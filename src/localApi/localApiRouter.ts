import type { IncomingMessage, ServerResponse } from 'node:http';
import type { KubusApiClient } from '../backend/kubusApiClient.js';
import type { CapabilityRegistry } from '../capabilities/registry.js';
import type { CapturePackagePayload, CaptureStore } from '../captures/captureStore.js';
import type { AppConfig } from '../config/schema.js';
import type { KuboClient } from '../ipfs/kuboClient.js';
import type { JobRuntime, JobType } from '../jobs/jobRuntime.js';
import { isValidCidLike, normalizeCid } from '../utils/cid.js';
import type { LocalStore } from '../state/localStore.js';
import { PairingService, type LocalScope, localError } from './pairingService.js';
import type { NetworkParticipationGate } from '../participation/networkParticipationGate.js';
import type { RemoteComputeRuntime } from '../compute/remoteComputeRuntime.js';

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
}

const SCOPE_BY_ROUTE: Array<[RegExp, LocalScope]> = [
  [/^\/local\/v1\/content\//, 'content:read'],
  [/^\/local\/v1\/captures(?:\/|$)/, 'captures:read'],
  [/^\/local\/v1\/jobs(?:\/|$)/, 'jobs:read'],
  [/^\/local\/v1\/spatial(?:\/|$)/, 'spatial:read'],
  [/^\/local\/v1\/compute(?:\/|$)/, 'jobs:read'],
];

export async function handleLocalApi(req: IncomingMessage, res: ServerResponse, deps: LocalApiDeps): Promise<boolean> {
  const parsed = new URL(req.url || '/', `http://${req.headers.host || '127.0.0.1'}`);
  if (!parsed.pathname.startsWith('/local/v1/')) return false;
  securityHeaders(res);
  if (!deps.config.localApiEnabled) throw localError(503, 'local_api_disabled');
  if (req.headers.origin) throw localError(403, 'browser_origin_not_allowed');
  if (!deps.config.localApiAllowLan && !isLoopback(req.socket.remoteAddress)) throw localError(403, 'lan_api_disabled');

  if (req.method === 'POST' && parsed.pathname === '/local/v1/pairing/session') {
    if (!isLoopback(req.socket.remoteAddress) && !matchesGuiToken(req, deps.config.guiToken)) throw localError(401, 'pairing_activation_required');
    json(res, 201, await deps.pairing.createSession());
    return true;
  }
  if (req.method === 'POST' && parsed.pathname === '/local/v1/pairing/exchange') {
    const body = await readJson(req);
    json(res, 201, await deps.pairing.exchange(String(body.sessionId || ''), String(body.secret || ''), typeof body.label === 'string' ? body.label : undefined));
    return true;
  }

  const token = bearer(req);
  const routeScope = SCOPE_BY_ROUTE.find(([pattern]) => pattern.test(parsed.pathname))?.[1] || 'content:read';
  if (!await deps.pairing.authorize(token, routeScope)) throw localError(401, 'local_credential_required');

  if (req.method === 'GET' && parsed.pathname === '/local/v1/info') {
    const state = deps.store.snapshot();
    json(res, 200, { apiVersion: 'local/v1', nodeId: state.nodeId || null, label: deps.config.nodeLabel, peerId: state.peerId || null, version: state.latestHeartbeat?.agentVersion || null });
    return true;
  }
  if (req.method === 'GET' && parsed.pathname === '/local/v1/status') {
    const state = deps.store.snapshot();
    json(res, 200, { status: state.latestStatus?.status || 'offline', lastHeartbeat: state.latestHeartbeatAt || null, participation: await deps.participationGate.refresh(), jobs: deps.jobs.health(), captures: deps.captures.list().length, worker: deps.capabilities.getWorkerHealth() });
    return true;
  }
  if (req.method === 'GET' && parsed.pathname === '/local/v1/participation') {
    json(res, 200, await deps.participationGate.refresh());
    return true;
  }
  if (req.method === 'GET' && parsed.pathname === '/local/v1/capabilities') {
    json(res, 200, { capabilities: await deps.capabilities.refresh(), worker: deps.capabilities.getWorkerHealth() });
    return true;
  }
  if (req.method === 'GET' && parsed.pathname === '/local/v1/network') {
    const state = deps.store.snapshot();
    json(res, 200, { peerId: state.peerId || null, nodeId: state.nodeId || null, publicPinSetCount: state.publicPinSetTotal ?? state.publicPinSet.length, verification: state.latestStatus?.archiveContribution?.metadata || null });
    return true;
  }
  if (req.method === 'GET' && parsed.pathname === '/local/v1/storage') {
    const state = deps.store.snapshot();
    const repo = await deps.kubo.repoStat().catch(() => ({ RepoSize: 0, StorageMax: 0 }));
    const privateCaptureBytes = deps.captures.list().reduce((sum, item) => sum + item.sizeBytes, 0);
    const publicReplicaBytes = state.desiredCids.filter((item) => state.pinnedCids.includes(item.cid)).reduce((sum, item) => sum + Number(item.sizeBytes || 0), 0);
    json(res, 200, { repoBytes: repo.RepoSize || 0, storageMaxBytes: repo.StorageMax || 0, publicReplicaBytes, privateCaptureBytes, maxPinnedBytes: deps.config.maxPinnedBytes, maxPinnedCids: deps.config.maxPinnedCids });
    return true;
  }
  const contentMatch = parsed.pathname.match(/^\/local\/v1\/content\/([^/]+)$/);
  if (req.method === 'GET' && contentMatch) {
    const cid = decodeURIComponent(contentMatch[1]!);
    if (!isValidCidLike(cid)) throw localError(400, 'cid_invalid');
    const bytes = await deps.kubo.cat(normalizeCid(cid));
    res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': String(bytes.byteLength), 'Cache-Control': 'private, max-age=300', 'X-Content-Type-Options': 'nosniff' });
    res.end(bytes);
    return true;
  }
  if (req.method === 'POST' && parsed.pathname === '/local/v1/captures') {
    if (!await deps.pairing.authorize(token, 'captures:create')) throw localError(403, 'scope_required');
    // Capture frames are base64 encoded in the initial JSON transport, so a
    // 50 MiB source package can exceed 50 MiB on the wire. Keep the endpoint
    // bounded while allowing a useful mobile capture session.
    json(res, 201, await deps.captures.create(await readJson(req, 256 * 1024 * 1024) as unknown as CapturePackagePayload));
    return true;
  }
  const captureMatch = parsed.pathname.match(/^\/local\/v1\/captures\/([^/]+)$/);
  if (captureMatch && req.method === 'GET') { json(res, 200, deps.captures.get(captureMatch[1]!)); return true; }
  if (captureMatch && req.method === 'DELETE') { await deps.captures.delete(captureMatch[1]!); json(res, 200, { deleted: true }); return true; }
  if (req.method === 'POST' && parsed.pathname === '/local/v1/jobs') {
    if (!await deps.pairing.authorize(token, 'jobs:create')) throw localError(403, 'scope_required');
    const body = await readJson(req);
    json(res, 201, await deps.jobs.create(String(body.type || '') as JobType, (body.input && typeof body.input === 'object' ? body.input : {}) as Record<string, unknown>));
    return true;
  }
  if (req.method === 'GET' && parsed.pathname === '/local/v1/jobs') {
    const gate = await deps.participationGate.refresh();
    const jobs = deps.jobs.list().map((job) => gate.leaseEligible || !job.output ? job : { ...job, output: undefined });
    json(res, 200, { jobs }); return true;
  }
  const cancelMatch = parsed.pathname.match(/^\/local\/v1\/jobs\/([^/]+)\/cancel$/);
  if (req.method === 'POST' && cancelMatch) { json(res, 200, await deps.jobs.cancel(cancelMatch[1]!)); return true; }
  const jobMatch = parsed.pathname.match(/^\/local\/v1\/jobs\/([^/]+)$/);
  if (req.method === 'GET' && jobMatch) {
    const job = deps.jobs.get(jobMatch[1]!);
    if (job.output) await deps.participationGate.assertUsefulOperation('private_job_result_read');
    json(res, 200, job); return true;
  }
  if (req.method === 'POST' && parsed.pathname === '/local/v1/compute/candidates') {
    const body = await readJson(req);
    const authorization = String(body.backendAuthorization || '');
    json(res, 200, await deps.remoteCompute.candidates(authorization, {
      type: typeof body.type === 'string' ? body.type : 'spatial.reconstruct',
      minimumVramBytes: Number(body.minimumVramBytes || 0),
      inputBytes: Number(body.inputBytes || 0),
    }));
    return true;
  }
  if (req.method === 'POST' && parsed.pathname === '/local/v1/compute/jobs') {
    if (!await deps.pairing.authorize(token, 'jobs:create')) throw localError(403, 'scope_required');
    const body = await readJson(req);
    json(res, 201, await deps.remoteCompute.requestJob({
      authorization: String(body.backendAuthorization || ''),
      captureId: String(body.captureId || ''),
      provider: (body.provider && typeof body.provider === 'object' ? body.provider : {}) as never,
      requirements: (body.requirements && typeof body.requirements === 'object' ? body.requirements : {}) as Record<string, unknown>,
      type: typeof body.type === 'string' ? body.type : undefined,
    }));
    return true;
  }
  const remoteStatusMatch = parsed.pathname.match(/^\/local\/v1\/compute\/jobs\/([^/]+)\/status$/);
  if (req.method === 'POST' && remoteStatusMatch) {
    const body = await readJson(req);
    json(res, 200, await deps.remoteCompute.getRequesterJob(remoteStatusMatch[1]!, String(body.backendAuthorization || '')));
    return true;
  }
  const remoteRetrieveMatch = parsed.pathname.match(/^\/local\/v1\/compute\/jobs\/([^/]+)\/retrieve$/);
  if (req.method === 'POST' && remoteRetrieveMatch) {
    const body = await readJson(req);
    json(res, 200, await deps.remoteCompute.retrieveRequesterOutput(remoteRetrieveMatch[1]!, String(body.backendAuthorization || '')));
    return true;
  }
  const remoteAcknowledgeMatch = parsed.pathname.match(/^\/local\/v1\/compute\/jobs\/([^/]+)\/acknowledge$/);
  if (req.method === 'POST' && remoteAcknowledgeMatch) {
    const body = await readJson(req);
    json(res, 200, await deps.remoteCompute.acknowledgeRequesterOutput(remoteAcknowledgeMatch[1]!, String(body.backendAuthorization || ''), body.accepted === true, typeof body.reason === 'string' ? body.reason : undefined));
    return true;
  }
  const remoteCancelMatch = parsed.pathname.match(/^\/local\/v1\/compute\/jobs\/([^/]+)\/cancel$/);
  if (req.method === 'POST' && remoteCancelMatch) {
    const body = await readJson(req);
    json(res, 200, await deps.remoteCompute.cancelRequesterJob(remoteCancelMatch[1]!, String(body.backendAuthorization || '')));
    return true;
  }
  const publishMatch = parsed.pathname.match(/^\/local\/v1\/spatial\/([^/]+)\/publish$/);
  if (req.method === 'POST' && publishMatch) {
    if (!await deps.pairing.authorize(token, 'spatial:publish-request')) throw localError(403, 'scope_required');
    const spatialId = publishMatch[1]!;
    const spatial = deps.store.snapshot().spatial?.[spatialId] as Record<string, unknown> | undefined;
    if (!spatial) throw localError(404, 'spatial_not_found');
    const body = await readJson(req);
    const authorization = typeof body.backendAuthorization === 'string' ? body.backendAuthorization : '';
    if (!authorization.startsWith('Bearer ')) throw localError(400, 'backend_authorization_required');
    const result = await deps.api.publishExistingSpatial({ spatial, artworkId: body.artworkId, markerId: body.markerId }, authorization);
    await deps.store.update((state) => {
      const current = state.spatial?.[spatialId] as Record<string, unknown> | undefined;
      if (current) { current.state = 'publication_requested'; current.publication = result; }
    });
    json(res, 202, result);
    return true;
  }
  const spatialMatch = parsed.pathname.match(/^\/local\/v1\/spatial\/([^/]+)$/);
  if (req.method === 'GET' && spatialMatch) {
    await deps.participationGate.assertUsefulOperation('private_spatial_result_read');
    const value = deps.store.snapshot().spatial?.[spatialMatch[1]!];
    if (!value) throw localError(404, 'spatial_not_found');
    json(res, 200, value);
    return true;
  }
  throw localError(404, 'local_route_not_found');
}

function bearer(req: IncomingMessage): string | undefined { const value = req.headers.authorization || ''; return value.startsWith('Bearer ') ? value.slice(7).trim() : undefined; }
function matchesGuiToken(req: IncomingMessage, expected?: string): boolean { return Boolean(expected && bearer(req) === expected); }
function isLoopback(address?: string): boolean { return ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(address || ''); }
function securityHeaders(res: ServerResponse): void { res.setHeader('Access-Control-Allow-Origin', 'null'); res.setHeader('Referrer-Policy', 'no-referrer'); res.setHeader('X-Content-Type-Options', 'nosniff'); res.setHeader('Cache-Control', 'no-store'); }
function json(res: ServerResponse, status: number, value: unknown): void { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(`${JSON.stringify({ success: true, data: value })}\n`); }
async function readJson(req: IncomingMessage, maxBytes = 1024 * 1024): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = []; let size = 0;
  for await (const chunk of req) { const bytes = Buffer.from(chunk); size += bytes.length; if (size > maxBytes) throw localError(413, 'request_too_large'); chunks.push(bytes); }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') as Record<string, unknown>; } catch { throw localError(400, 'json_invalid'); }
}
