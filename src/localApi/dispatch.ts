import { Buffer } from 'node:buffer';
import type { KubusApiClient } from '../backend/kubusApiClient.js';
import type { CapabilityRegistry } from '../capabilities/registry.js';
import type { CaptureDraftPayload, CapturePackagePayload, CaptureStore } from '../captures/captureStore.js';
import type { AppConfig } from '../config/schema.js';
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
    const bytes = await request.body.binary(BODY_LIMITS.captureDraftFile);
    const mimeType = request.contentType;
    return jsonResponse(
      200,
      await captures.writeDraftFile(
        draftFileMatch[1]!,
        filePath,
        bytes,
        typeof mimeType === 'string' && mimeType !== 'application/octet-stream' ? mimeType : undefined,
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
