import { Buffer } from 'node:buffer';
import type { KubusApiClient } from '../backend/kubusApiClient.js';
import type { CapabilityRegistry } from '../capabilities/registry.js';
import type { CaptureDraftPayload, CapturePackagePayload, CaptureStore } from '../captures/captureStore.js';
import type { AppConfig } from '../config/schema.js';
import { createIdentityProof, IDENTITY_PROOF_PROTOCOL_VERSION } from '../identity/identityProof.js';
import type { NodeIdentity } from '../identity/nodeIdentity.js';
import type { KuboClient } from '../ipfs/kuboClient.js';
import type { JobRuntime, JobType } from '../jobs/jobRuntime.js';
import type { NetworkParticipationGate } from '../participation/networkParticipationGate.js';
import type { RemoteComputeRuntime } from '../compute/remoteComputeRuntime.js';
import type { LocalStore } from '../state/localStore.js';
import { isValidCidLike, normalizeCid } from '../utils/cid.js';
import { IdempotencyStore } from './idempotencyStore.js';
import {
  BODY_LIMITS,
  jsonResponse,
  type LocalRequest,
  type LocalResponse,
} from './localRequest.js';
import {
  PairingAttemptLimiter,
  pairingAttemptKey,
  localError,
  type LocalScope,
  type PairingService,
} from './pairingService.js';

export interface LocalApiDeps {
  api: KubusApiClient;
  kubo: KuboClient;
  store: LocalStore;
  config: AppConfig;
  capabilities: CapabilityRegistry;
  pairing: PairingService;
  captures: CaptureStore;
  jobs: JobRuntime;
  participationGate: NetworkParticipationGate;
  remoteCompute: RemoteComputeRuntime;
  /** Loaded once at startup; every route reads the same in-memory identity. */
  identity: NodeIdentity;
  /**
   * Shared across transports on purpose: a mutation retried on a different
   * rung must collide with the original attempt, which it cannot do if each
   * transport keeps its own memory of what it has already done.
   */
  idempotency?: IdempotencyStore;
}

const SCOPE_BY_ROUTE: Array<[RegExp, LocalScope]> = [
  [/^\/local\/v1\/content\//, 'content:read'],
  [/^\/local\/v1\/captures(?:\/|$)/, 'captures:read'],
  [/^\/local\/v1\/jobs(?:\/|$)/, 'jobs:read'],
  [/^\/local\/v1\/spatial(?:\/|$)/, 'spatial:read'],
  [/^\/local\/v1\/compute(?:\/|$)/, 'jobs:read'],
];

const pairingAttempts = new PairingAttemptLimiter();

/**
 * The session id bound into every HTTP identity proof.
 *
 * WebRTC binds a real signalling session here. HTTP has none, so this constant
 * takes its place and does the one job that still matters over HTTP: it keeps
 * the two transports' proofs disjoint, so a proof minted for a data channel
 * can never be presented as an HTTP proof or the reverse. Freshness is not its
 * job -- the client's 32-byte nonce carries that.
 *
 * Like the WebRTC session id, it is the node's own value and is never read
 * from the request. A client that could choose what gets signed here could ask
 * for a proof bound to someone else's session.
 */
export const HTTP_IDENTITY_SESSION_ID = 'local-http/v1';

/**
 * Rate limit for the unauthenticated proof route, which is a signing oracle.
 *
 * The ceiling is deliberately high: the app proves identity again before every
 * private transfer, so uploading a capture of many files legitimately asks for
 * many proofs in a row. This is here to bound CPU against an unauthenticated
 * flood, not to police normal use.
 */
const identityProofAttempts = new PairingAttemptLimiter(600, 60_000, 4096, 3000);
const sharedIdempotency = new IdempotencyStore();

/** Verbs whose effects a retry could duplicate. */
const MUTATING_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

export function routeScope(path: string): LocalScope {
  return SCOPE_BY_ROUTE.find(([pattern]) => pattern.test(path))?.[1] || 'content:read';
}

/**
 * Serves one canonical Node operation, whatever carried it here.
 *
 * Every authorization decision, size bound, and business rule lives in this
 * function precisely once. A transport's job is to produce a `LocalRequest`
 * and render a `LocalResponse`; it gets no say in what an operation means or
 * who is allowed to perform it.
 */
export async function dispatchLocalRequest(
  request: LocalRequest,
  deps: LocalApiDeps,
): Promise<LocalResponse> {
  if (!deps.config.localApiEnabled) throw localError(503, 'local_api_disabled');

  const method = request.method.toUpperCase();
  const path = request.path;
  if (!path.startsWith('/local/v1/')) throw localError(404, 'local_route_not_found');

  if (method === 'POST' && path === '/local/v1/pairing/session') {
    // Do not trust the peer for activation: a public reverse proxy legitimately
    // connects from loopback, and a WebRTC peer has no address at all. Minting
    // a pairing session always requires the separate GUI administrator
    // credential, on every transport.
    if (!deps.config.guiToken || request.credential !== deps.config.guiToken) {
      throw localError(401, 'pairing_activation_required');
    }
    return jsonResponse(201, await deps.pairing.createSession());
  }

  if (method === 'POST' && path === '/local/v1/pairing/exchange') {
    return exchangePairing(request, deps);
  }

  // Before the credential gate on purpose: a caller that has not yet proved
  // which machine it reached must not have to present the credential to find
  // out. See proveIdentity's doc comment for what it does and does not expose.
  if (method === 'POST' && path === '/local/v1/identity/proof') {
    return proveIdentity(request, deps);
  }

  const scope = routeScope(path);
  if (!(await deps.pairing.authorize(request.credential, scope))) {
    throw localError(401, 'local_credential_required');
  }

  // A peer that reached a data channel has proved a channel exists, never who
  // is on the far end of it. Holding a valid credential does not change that:
  // a stolen credential is exactly the case this guards. Nothing privileged is
  // served until the identity challenge has been answered.
  if (!request.peer.identityHandshakeComplete) {
    throw localError(403, 'node_identity_proof_required');
  }

  const idempotency = deps.idempotency ?? sharedIdempotency;
  const claim = MUTATING_METHODS.has(method)
    ? idempotency.begin({
        key: request.idempotencyKey,
        credential: request.credential,
        operation: `${method} ${path}`,
      })
    : undefined;

  if (claim?.replay) {
    return jsonResponse(claim.replay.status, claim.replay.value);
  }

  let response: LocalResponse | undefined;
  try {
    response = await route(method, path, request, deps);
    return response;
  } catch (error) {
    claim?.settle(undefined, true);
    throw error;
  } finally {
    if (response) claim?.settle(response, false);
  }
}

/**
 * Proves possession of the node's private key over a caller-supplied nonce.
 *
 * ## Why this route is unauthenticated
 *
 * It is the bootstrap of "prove who you are before I trust you with a
 * credential". A client that has not yet confirmed which machine answered must
 * not send the node credential to find out -- that is precisely the disclosure
 * the check exists to prevent -- so the one request it is willing to make to an
 * unproved address has to work without one.
 *
 * ## Why it discloses nothing new
 *
 * It returns the node id, fingerprint and public key, and nothing else. All
 * three are printed in the pairing QR code an operator holds up to a camera,
 * so they are public by construction. It deliberately does NOT return the
 * label, peer id, endpoint list or version that `/local/v1/info` carries: those
 * describe the deployment rather than the identity, and stay behind the
 * credential.
 *
 * ## Why a signature rather than an echo
 *
 * Returning the identity fields alone would prove nothing. Anyone who has seen
 * the pairing QR -- or any earlier response from this route -- knows all three
 * values and could repeat them. Only the private key distinguishes the real
 * node, so the caller picks a random challenge and requires a signature over
 * it. The message is built by the shared canonical builder, so the bytes signed
 * here are the same ones the data-channel handshake signs.
 *
 * A live relay that forwards a challenge to the real node and returns its
 * answer is not defeated by this, and cannot be without binding the proof to
 * the channel. Over HTTPS the transport already authenticates the host; over
 * cleartext LAN the attacker must already be on the network.
 */
async function proveIdentity(request: LocalRequest, deps: LocalApiDeps): Promise<LocalResponse> {
  identityProofAttempts.assertAllowed(
    pairingAttemptKey(request.peer.address || request.peer.kind, 'identity-proof'),
  );
  const body = await request.body.json(BODY_LIMITS.json);
  if (String(body.protocolVersion || '') !== IDENTITY_PROOF_PROTOCOL_VERSION) {
    throw localError(400, 'identity_protocol_version_unsupported');
  }
  // base64 or base64url, since the two sides of this protocol historically
  // disagree about which; the length check is what actually matters.
  const nonce = Buffer.from(String(body.nonce || ''), 'base64');
  if (nonce.length !== 32) throw localError(400, 'identity_nonce_invalid');

  const proof = createIdentityProof(deps.identity, {
    protocolVersion: IDENTITY_PROOF_PROTOCOL_VERSION,
    sessionId: HTTP_IDENTITY_SESSION_ID,
    nonce,
    // The same role the data-channel handshake signs, because the verifier is
    // literally the same code path on the app side.
    clientRole: 'client',
  });
  const state = deps.store.snapshot();
  return jsonResponse(200, {
    protocolVersion: IDENTITY_PROOF_PROTOCOL_VERSION,
    sessionId: HTTP_IDENTITY_SESSION_ID,
    nodeId: state.nodeId || `local-${deps.identity.fingerprint}`,
    fingerprint: proof.fingerprint,
    publicKey: proof.publicKeyRaw.toString('base64url'),
    signature: proof.signature.toString('base64'),
  });
}

async function exchangePairing(request: LocalRequest, deps: LocalApiDeps): Promise<LocalResponse> {
  const body = await request.body.json(BODY_LIMITS.json);
  const sessionId = String(body.sessionId || '');
  const client = pairingAttemptKey(request.peer.address || request.peer.kind, sessionId);
  pairingAttempts.assertAllowed(client);
  try {
    const result = await deps.pairing.exchange(
      sessionId,
      String(body.secret || ''),
      typeof body.label === 'string' ? body.label : undefined,
    );
    pairingAttempts.succeeded(client);
    return jsonResponse(201, result);
  } catch (error) {
    const code = (error as Error & { code?: string }).code;
    if (
      code &&
      [
        'invalid_pairing_session',
        'pairing_session_replayed',
        'pairing_session_expired',
        'invalid_pairing_secret',
      ].includes(code)
    ) {
      pairingAttempts.failed(client);
      // A remote caller must not learn which credential check failed. The
      // pairing secret itself never reaches logs.
      throw localError(401, 'pairing_exchange_failed');
    }
    // Storage and other operational failures stay observable and do not
    // consume the caller's authentication-failure budget.
    throw error;
  }
}

async function route(
  method: string,
  path: string,
  request: LocalRequest,
  deps: LocalApiDeps,
): Promise<LocalResponse> {
  const { pairing, store, config, capabilities, captures, jobs, participationGate, remoteCompute, kubo, api, identity } = deps;
  const credential = request.credential;

  if (method === 'GET' && path === '/local/v1/info') {
    const state = store.snapshot();
    const fingerprint = identity.fingerprint;
    return jsonResponse(200, {
      apiVersion: 'local/v1',
      nodeId: state.nodeId || `local-${fingerprint}`,
      label: config.nodeLabel,
      peerId: state.peerId || null,
      fingerprint,
      publicKey: identity.publicKeyBase64Url,
      identityAlgorithm: 'ed25519',
      endpoints: [
        config.localApiRemoteUrl,
        config.localApiAllowLan ? config.localApiLanUrl : undefined,
      ].filter(Boolean),
      version: state.latestHeartbeat?.agentVersion || null,
    });
  }

  if (method === 'GET' && path === '/local/v1/status') {
    const state = store.snapshot();
    await capabilities.refreshIfStale();
    return jsonResponse(200, {
      status: state.latestStatus?.status || 'offline',
      lastHeartbeat: state.latestHeartbeatAt || null,
      participation: await participationGate.refresh(),
      jobs: jobs.health(),
      captures: captures.list().length,
      worker: capabilities.getWorkerHealth(),
    });
  }

  if (method === 'GET' && path === '/local/v1/participation') {
    return jsonResponse(200, await participationGate.refresh());
  }

  if (method === 'GET' && path === '/local/v1/capabilities') {
    return jsonResponse(200, {
      capabilities: await capabilities.refreshIfStale(),
      worker: capabilities.getWorkerHealth(),
    });
  }

  if (method === 'GET' && path === '/local/v1/network') {
    const state = store.snapshot();
    return jsonResponse(200, {
      peerId: state.peerId || null,
      nodeId: state.nodeId || null,
      publicPinSetCount: state.publicPinSetTotal ?? state.publicPinSet.length,
      verification: state.latestStatus?.archiveContribution?.metadata || null,
    });
  }

  if (method === 'GET' && path === '/local/v1/storage') {
    const state = store.snapshot();
    const repo = await kubo.repoStat().catch(() => ({ RepoSize: 0, StorageMax: 0 }));
    const privateCaptureBytes = captures.list().reduce((sum, item) => sum + item.sizeBytes, 0);
    const publicReplicaBytes = state.desiredCids
      .filter((item) => state.pinnedCids.includes(item.cid))
      .reduce((sum, item) => sum + Number(item.sizeBytes || 0), 0);
    return jsonResponse(200, {
      repoBytes: repo.RepoSize || 0,
      storageMaxBytes: repo.StorageMax || 0,
      publicReplicaBytes,
      privateCaptureBytes,
      maxPinnedBytes: config.maxPinnedBytes,
      maxPinnedCids: config.maxPinnedCids,
    });
  }

  const contentMatch = path.match(/^\/local\/v1\/content\/([^/]+)$/);
  if (method === 'GET' && contentMatch) {
    const cid = decodeURIComponent(contentMatch[1]!);
    if (!isValidCidLike(cid)) throw localError(400, 'cid_invalid');
    const bytes = await kubo.cat(normalizeCid(cid));
    return {
      kind: 'bytes',
      status: 200,
      contentType: 'application/octet-stream',
      body: Buffer.from(bytes),
      cacheControl: 'private, max-age=300',
    };
  }

  if (method === 'POST' && path === '/local/v1/captures') {
    if (!(await pairing.authorize(credential, 'captures:create'))) throw localError(403, 'scope_required');
    // Capture frames are base64 encoded in this transport, so a 50 MiB source
    // package can exceed 50 MiB on the wire. Keep the endpoint bounded while
    // allowing a useful mobile capture session.
    const payload = (await request.body.json(BODY_LIMITS.capturePackage)) as unknown as CapturePackagePayload;
    return jsonResponse(201, await captures.create(payload));
  }

  if (method === 'POST' && path === '/local/v1/captures/drafts') {
    if (!(await pairing.authorize(credential, 'captures:create'))) throw localError(403, 'scope_required');
    const payload = (await request.body.json(BODY_LIMITS.captureDraftMetadata)) as unknown as CaptureDraftPayload;
    return jsonResponse(201, await captures.beginDraft(payload));
  }

  const draftFileMatch = path.match(/^\/local\/v1\/captures\/drafts\/([^/]+)\/files$/);
  if (method === 'PUT' && draftFileMatch) {
    if (!(await pairing.authorize(credential, 'captures:create'))) throw localError(403, 'scope_required');
    const filePath = request.query.get('path');
    if (!filePath) throw localError(400, 'capture_file_path_invalid');
    const mimeType = request.contentType;
    return jsonResponse(
      200,
      await captures.writeDraftFileStream(
        draftFileMatch[1]!,
        filePath,
        request.body.stream(),
        typeof mimeType === 'string' && mimeType !== 'application/octet-stream' ? mimeType : undefined,
        BODY_LIMITS.captureDraftFile,
      ),
    );
  }

  const draftMatch = path.match(/^\/local\/v1\/captures\/drafts\/([^/]+)$/);
  if (method === 'GET' && draftMatch) {
    return jsonResponse(200, captures.getDraft(draftMatch[1]!));
  }
  if (method === 'DELETE' && draftMatch) {
    if (!(await pairing.authorize(credential, 'captures:create'))) throw localError(403, 'scope_required');
    await captures.discardDraft(draftMatch[1]!);
    return jsonResponse(200, { discarded: true });
  }

  const draftCommitMatch = path.match(/^\/local\/v1\/captures\/drafts\/([^/]+)\/commit$/);
  if (method === 'POST' && draftCommitMatch) {
    if (!(await pairing.authorize(credential, 'captures:create'))) throw localError(403, 'scope_required');
    return jsonResponse(201, await captures.commitDraft(draftCommitMatch[1]!));
  }

  const captureMatch = path.match(/^\/local\/v1\/captures\/([^/]+)$/);
  if (captureMatch && method === 'GET') return jsonResponse(200, captures.get(captureMatch[1]!));
  if (captureMatch && method === 'DELETE') {
    await captures.delete(captureMatch[1]!);
    return jsonResponse(200, { deleted: true });
  }

  if (method === 'POST' && path === '/local/v1/jobs') {
    if (!(await pairing.authorize(credential, 'jobs:create'))) throw localError(403, 'scope_required');
    const body = await request.body.json(BODY_LIMITS.json);
    return jsonResponse(
      201,
      await jobs.create(
        String(body.type || '') as JobType,
        (body.input && typeof body.input === 'object' ? body.input : {}) as Record<string, unknown>,
      ),
    );
  }

  if (method === 'GET' && path === '/local/v1/jobs') {
    const gate = await participationGate.refresh();
    const list = jobs.list().map((job) => (gate.leaseEligible || !job.output ? job : { ...job, output: undefined }));
    return jsonResponse(200, { jobs: list });
  }

  const cancelMatch = path.match(/^\/local\/v1\/jobs\/([^/]+)\/cancel$/);
  if (method === 'POST' && cancelMatch) return jsonResponse(200, await jobs.cancel(cancelMatch[1]!));

  const jobMatch = path.match(/^\/local\/v1\/jobs\/([^/]+)$/);
  if (method === 'GET' && jobMatch) {
    const job = jobs.get(jobMatch[1]!);
    if (job.output) await participationGate.assertUsefulOperation('private_job_result_read');
    return jsonResponse(200, job);
  }

  if (method === 'POST' && path === '/local/v1/compute/candidates') {
    const body = await request.body.json(BODY_LIMITS.json);
    return jsonResponse(
      200,
      await remoteCompute.candidates(String(body.backendAuthorization || ''), {
        type: typeof body.type === 'string' ? body.type : 'spatial.reconstruct',
        minimumVramBytes: Number(body.minimumVramBytes || 0),
        inputBytes: Number(body.inputBytes || 0),
      }),
    );
  }

  if (method === 'GET' && path === '/local/v1/compute/settings') {
    return jsonResponse(200, remoteCompute.settings());
  }

  if (method === 'PUT' && path === '/local/v1/compute/settings') {
    if (!(await pairing.authorize(credential, 'compute:manage'))) throw localError(403, 'scope_required');
    return jsonResponse(200, await remoteCompute.updateSettings(await request.body.json(BODY_LIMITS.json)));
  }

  if (method === 'POST' && path === '/local/v1/compute/jobs') {
    if (!(await pairing.authorize(credential, 'jobs:create'))) throw localError(403, 'scope_required');
    const body = await request.body.json(BODY_LIMITS.json);
    return jsonResponse(
      201,
      await remoteCompute.requestJob({
        authorization: String(body.backendAuthorization || ''),
        captureId: String(body.captureId || ''),
        provider: (body.provider && typeof body.provider === 'object' ? body.provider : {}) as never,
        requirements: (body.requirements && typeof body.requirements === 'object' ? body.requirements : {}) as Record<string, unknown>,
        type: typeof body.type === 'string' ? body.type : undefined,
      }),
    );
  }

  const remoteStatusMatch = path.match(/^\/local\/v1\/compute\/jobs\/([^/]+)\/status$/);
  if (method === 'POST' && remoteStatusMatch) {
    const body = await request.body.json(BODY_LIMITS.json);
    return jsonResponse(
      200,
      await remoteCompute.getRequesterJob(remoteStatusMatch[1]!, String(body.backendAuthorization || '')),
    );
  }

  const remoteRetrieveMatch = path.match(/^\/local\/v1\/compute\/jobs\/([^/]+)\/retrieve$/);
  if (method === 'POST' && remoteRetrieveMatch) {
    const body = await request.body.json(BODY_LIMITS.json);
    return jsonResponse(
      200,
      await remoteCompute.retrieveRequesterOutput(remoteRetrieveMatch[1]!, String(body.backendAuthorization || '')),
    );
  }

  const remoteAcknowledgeMatch = path.match(/^\/local\/v1\/compute\/jobs\/([^/]+)\/acknowledge$/);
  if (method === 'POST' && remoteAcknowledgeMatch) {
    const body = await request.body.json(BODY_LIMITS.json);
    return jsonResponse(
      200,
      await remoteCompute.acknowledgeRequesterOutput(
        remoteAcknowledgeMatch[1]!,
        String(body.backendAuthorization || ''),
        body.accepted === true,
        typeof body.reason === 'string' ? body.reason : undefined,
      ),
    );
  }

  const remoteCancelMatch = path.match(/^\/local\/v1\/compute\/jobs\/([^/]+)\/cancel$/);
  if (method === 'POST' && remoteCancelMatch) {
    const body = await request.body.json(BODY_LIMITS.json);
    return jsonResponse(
      200,
      await remoteCompute.cancelRequesterJob(remoteCancelMatch[1]!, String(body.backendAuthorization || '')),
    );
  }

  const publishMatch = path.match(/^\/local\/v1\/spatial\/([^/]+)\/publish$/);
  if (method === 'POST' && publishMatch) {
    if (!(await pairing.authorize(credential, 'spatial:publish-request'))) throw localError(403, 'scope_required');
    const spatialId = publishMatch[1]!;
    const spatial = store.snapshot().spatial?.[spatialId] as Record<string, unknown> | undefined;
    if (!spatial) throw localError(404, 'spatial_not_found');
    const body = await request.body.json(BODY_LIMITS.json);
    const authorization = typeof body.backendAuthorization === 'string' ? body.backendAuthorization : '';
    if (!authorization.startsWith('Bearer ')) throw localError(400, 'backend_authorization_required');
    const result = await api.publishExistingSpatial(
      { spatial, artworkId: body.artworkId, markerId: body.markerId },
      authorization,
    );
    await store.update((state) => {
      const current = state.spatial?.[spatialId] as Record<string, unknown> | undefined;
      if (current) {
        current.state = 'publication_requested';
        current.publication = result;
      }
    });
    return jsonResponse(202, result);
  }

  const spatialMatch = path.match(/^\/local\/v1\/spatial\/([^/]+)$/);
  if (method === 'GET' && spatialMatch) {
    await participationGate.assertUsefulOperation('private_spatial_result_read');
    const value = store.snapshot().spatial?.[spatialMatch[1]!];
    if (!value) throw localError(404, 'spatial_not_found');
    return jsonResponse(200, value);
  }

  throw localError(404, 'local_route_not_found');
}
