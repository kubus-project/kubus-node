import http, { type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { KubusApiClient } from '../backend/kubusApiClient.js';
import type { AppConfig } from '../config/schema.js';
import { formatFingerprint } from '../identity/nodeIdentity.js';
import { getKuboHealth } from '../ipfs/health.js';
import type { KuboClient } from '../ipfs/kuboClient.js';
import { probeRetrieval, RETRIEVAL_AVAILABLE_STATES, type RetrievalProbe } from '../ipfs/retrieval.js';
import { getBufferedLogs, clearBufferedLogs, redactSecrets } from '../logging/logBuffer.js';
import type { Logger } from '../logging/logger.js';
import { syncPublicPinSet, reconcileDesiredPins, refreshCommitments } from '../operator/commitments.js';
import { sendHeartbeat } from '../operator/heartbeat.js';
import { refreshRewards } from '../operator/rewards.js';
import { buildStatusSummary, refreshStatus } from '../operator/status.js';
import type { ActionLock } from '../runtime/actionLock.js';
import type { LocalStore } from '../state/localStore.js';
import { guiCss } from './public/guiCss.js';
import { guiJs } from './public/guiJs.js';
import { assertGuiConfig, authorizeGuiRequest, guiRemoteMode, sendUnauthorized } from './guiAuth.js';
import { guiHtml } from './templates/index.js';
import { handleLocalApi, type LocalApiDeps } from '../localApi/localApiRouter.js';
import { buildViewModel } from './viewModel.js';
import { renderQrSvg } from './qr.js';
import {
  getCaptureSummary,
  getJobSummary,
  getSpatialRecord,
  listCaptureSummaries,
  listJobSummaries,
  listSpatialSummaries,
  serveCaptureFile,
  serveSpatialVariant,
} from './spatialGuiApi.js';

export interface GuiDeps {
  api: KubusApiClient;
  kubo: KuboClient;
  store: LocalStore;
  config: AppConfig;
  logger: Logger;
  actionLock: ActionLock;
  localApi?: LocalApiDeps;
}

export interface GuiServerHandle {
  url: string;
  close: () => Promise<void>;
}

export async function startGuiServer(deps: GuiDeps): Promise<GuiServerHandle> {
  if (deps.config.guiEnabled) assertGuiConfig(deps.config);
  const server = http.createServer((req, res) => {
    void handleRequest(req, res, deps).catch((error) => {
      writeJson(res, Number((error as Error & { statusCode?: number }).statusCode || 500), {
        success: false,
        error: String((error as Error).message || error),
        code: (error as Error & { code?: string }).code,
        details: (error as Error & { details?: Record<string, unknown> }).details,
      });
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    const port = deps.config.localApiEnabled ? deps.config.localApiPort : deps.config.guiPort;
    const host = deps.config.localApiEnabled ? deps.config.localApiHost : deps.config.guiHost;
    server.listen(port, host, () => resolve());
  });
  const address = server.address() as AddressInfo;
  const listenPort = deps.config.localApiEnabled ? deps.config.localApiPort : deps.config.guiPort;
  const url = listenPort === 0
    ? `http://127.0.0.1:${address.port}/gui`
    : (deps.config.guiDisplayUrl || `http://${deps.config.guiHost}:${address.port}/gui`);
  deps.logger.info({
    guiEnabled: true,
    guiUrl: url,
    fallbackUrl: deps.config.guiFallbackUrl,
    localhostOnly: !guiRemoteMode(deps.config),
    tokenConfigured: Boolean(deps.config.guiToken),
  }, 'kubus node GUI started');
  return {
    url,
    close: () => new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    }),
  };
}

async function handleRequest(req: IncomingMessage, res: ServerResponse, deps: GuiDeps): Promise<void> {
  const parsed = new URL(req.url || '/', `http://${req.headers.host || '127.0.0.1'}`);
  if (deps.localApi && await handleLocalApi(req, res, deps.localApi)) return;
  if (!deps.config.guiEnabled && parsed.pathname.startsWith('/gui')) {
    writeJson(res, 404, { success: false, error: 'GUI disabled' });
    return;
  }
  if ((req.method === 'GET' || req.method === 'HEAD') && parsed.pathname === '/gui') {
    if (req.method === 'HEAD') {
      writeHead(res, 200, 'text/html; charset=utf-8');
      res.end();
      return;
    }
    writeText(res, 200, guiHtml(), 'text/html; charset=utf-8');
    return;
  }
  if (req.method === 'GET' && parsed.pathname === '/gui/assets/gui.css') {
    writeText(res, 200, guiCss, 'text/css; charset=utf-8');
    return;
  }
  if (req.method === 'GET' && parsed.pathname === '/gui/assets/gui.js') {
    writeText(res, 200, guiJs, 'application/javascript; charset=utf-8');
    return;
  }
  if (!parsed.pathname.startsWith('/gui/api/')) {
    writeJson(res, 404, { success: false, error: 'Not found' });
    return;
  }
  if (!authorizeGuiRequest(req, deps.config)) {
    sendUnauthorized(res);
    return;
  }
  if (req.method === 'GET' && parsed.pathname === '/gui/api/status') {
    const live = await liveStatus(deps.api, deps.kubo);
    writeJson(res, 200, { success: true, data: await buildGuiStatus(deps, live) });
    return;
  }
  if (req.method === 'GET' && parsed.pathname === '/gui/api/view') {
    writeJson(res, 200, { success: true, data: await buildGuiView(deps) });
    return;
  }
  if (req.method === 'PUT' && parsed.pathname === '/gui/api/compute/settings') {
    const local = requireLocalApi(deps);
    writeJson(res, 200, { success: true, data: await local.remoteCompute.updateSettings(await readGuiJson(req)) });
    return;
  }
  if (req.method === 'POST' && parsed.pathname === '/gui/api/pairing/session') {
    const pairing = await createGuiPairing(deps);
    writeJson(res, 201, { success: true, data: pairing }, pairing.code);
    return;
  }
  const revokeMatch = parsed.pathname.match(/^\/gui\/api\/devices\/([^/]+)$/);
  if (req.method === 'DELETE' && revokeMatch) {
    const local = requireLocalApi(deps);
    await local.pairing.revoke(decodeURIComponent(revokeMatch[1]!));
    writeJson(res, 200, { success: true, data: { disconnected: true } });
    return;
  }
  if (req.method === 'GET' && parsed.pathname === '/gui/api/pinning') {
    writeJson(res, 200, { success: true, data: buildPinning(deps) });
    return;
  }
  if (req.method === 'GET' && parsed.pathname === '/gui/api/rewards') {
    writeJson(res, 200, { success: true, data: buildRewards(deps.store) });
    return;
  }
  if (req.method === 'GET' && parsed.pathname === '/gui/api/commitments') {
    writeJson(res, 200, { success: true, data: buildCommitments(deps) });
    return;
  }
  if (req.method === 'GET' && parsed.pathname === '/gui/api/logs') {
    writeJson(res, 200, { success: true, data: { logs: getBufferedLogs(parsed.searchParams.get('level')) } });
    return;
  }
  if (req.method === 'DELETE' && parsed.pathname === '/gui/api/logs') {
    clearBufferedLogs();
    writeJson(res, 200, { success: true, data: { cleared: true } });
    return;
  }
  if (req.method === 'POST' && parsed.pathname.startsWith('/gui/api/actions/')) {
    const action = parsed.pathname.split('/').pop() || '';
    writeJson(res, 200, { success: true, data: await runAction(action, deps) });
    return;
  }

  // --- Spatial library, capture archive, and job queue (read-only) ---------
  if (req.method === 'GET' && parsed.pathname === '/gui/api/jobs') {
    const local = requireLocalApi(deps);
    writeJson(res, 200, { success: true, data: listJobSummaries(local.jobs) });
    return;
  }
  const jobMatch = parsed.pathname.match(/^\/gui\/api\/jobs\/([^/]+)$/);
  if (req.method === 'GET' && jobMatch) {
    const local = requireLocalApi(deps);
    writeJson(res, 200, { success: true, data: getJobSummary(local.jobs, decodeURIComponent(jobMatch[1]!)) });
    return;
  }
  if (req.method === 'GET' && parsed.pathname === '/gui/api/captures') {
    const local = requireLocalApi(deps);
    writeJson(res, 200, { success: true, data: listCaptureSummaries(local.captures) });
    return;
  }
  const captureMatch = parsed.pathname.match(/^\/gui\/api\/captures\/([^/]+)$/);
  if (req.method === 'GET' && captureMatch) {
    const local = requireLocalApi(deps);
    writeJson(res, 200, { success: true, data: getCaptureSummary(local.captures, decodeURIComponent(captureMatch[1]!)) });
    return;
  }
  const captureContentMatch = parsed.pathname.match(/^\/gui\/api\/captures\/([^/]+)\/content\/(.+)$/);
  if (req.method === 'GET' && captureContentMatch) {
    const local = requireLocalApi(deps);
    await serveCaptureFile(res, local, decodeURIComponent(captureContentMatch[1]!), decodeURIComponent(captureContentMatch[2]!));
    return;
  }
  if (req.method === 'GET' && parsed.pathname === '/gui/api/spatial') {
    writeJson(res, 200, { success: true, data: listSpatialSummaries(deps.store) });
    return;
  }
  const spatialManifestMatch = parsed.pathname.match(/^\/gui\/api\/spatial\/([^/]+)\/manifest$/);
  if (req.method === 'GET' && spatialManifestMatch) {
    writeJson(res, 200, { success: true, data: getSpatialRecord(deps.store, decodeURIComponent(spatialManifestMatch[1]!)).manifest });
    return;
  }
  const spatialContentMatch = parsed.pathname.match(/^\/gui\/api\/spatial\/([^/]+)\/content\/([^/]+)$/);
  if (req.method === 'GET' && spatialContentMatch) {
    await serveSpatialVariant(req, res, deps, decodeURIComponent(spatialContentMatch[1]!), decodeURIComponent(spatialContentMatch[2]!));
    return;
  }
  const spatialMatch = parsed.pathname.match(/^\/gui\/api\/spatial\/([^/]+)$/);
  if (req.method === 'GET' && spatialMatch) {
    const record = getSpatialRecord(deps.store, decodeURIComponent(spatialMatch[1]!));
    writeJson(res, 200, { success: true, data: record });
    return;
  }

  writeJson(res, 404, { success: false, error: 'Not found' });
}

async function liveStatus(api: KubusApiClient, kubo: KuboClient) {
  const [backendHealth, kuboHealth] = await Promise.all([
    api.getHealth().then((data) => ({ reachable: true, data })).catch((error) => ({ reachable: false, error: String((error as Error).message || error) })),
    getKuboHealth(kubo),
  ]);
  return { backendHealth, kuboHealth };
}

async function buildGuiStatus(deps: GuiDeps, live: Awaited<ReturnType<typeof liveStatus>>) {
  const state = deps.store.snapshot();
  const summary = buildStatusSummary(deps.config, state, {
    backendHealth: live.backendHealth,
    kuboHealth: live.kuboHealth,
  });
  return redactSecrets({
    ...summary,
    status: state.latestStatus?.status || (live.kuboHealth.reachable ? 'syncing' : 'offline'),
    backendReachable: live.backendHealth.reachable,
    kuboReachable: live.kuboHealth.reachable,
    backendUrl: deps.config.apiBaseUrl,
    nodeLabel: deps.config.nodeLabel,
    operatorWallet: deps.config.operatorWallet,
    peerId: live.kuboHealth.peerId || state.peerId || null,
    gui: {
      enabled: deps.config.guiEnabled,
      displayUrl: deps.config.guiDisplayUrl,
      fallbackUrl: deps.config.guiFallbackUrl,
      localhostOnly: !guiRemoteMode(deps.config),
      tokenConfigured: Boolean(deps.config.guiToken),
      remoteMode: guiRemoteMode(deps.config),
    },
    actionLock: deps.actionLock.snapshot(),
  });
}

/**
 * The runtime pieces the redesigned GUI reads from. They are optional on
 * `GuiDeps` for the benefit of narrow tests, but the CLI always supplies them.
 */
function requireLocalApi(deps: GuiDeps): LocalApiDeps {
  if (!deps.localApi) {
    const error = new Error('local_runtime_unavailable') as Error & { statusCode?: number; code?: string };
    error.statusCode = 503;
    error.code = 'local_runtime_unavailable';
    throw error;
  }
  return deps.localApi;
}

async function buildGuiView(deps: GuiDeps) {
  const local = requireLocalApi(deps);
  const state = deps.store.snapshot();
  const [participation, live, repo] = await Promise.all([
    local.participationGate.refresh(),
    liveStatus(deps.api, deps.kubo),
    deps.kubo.repoStat().catch(() => ({ RepoSize: 0, StorageMax: 0 })),
    local.capabilities.refreshIfStale(),
  ]);

  const captures = local.captures.list();
  const pinnedSet = new Set(state.pinnedCids);
  const publicReplicaBytes = state.desiredCids
    .filter((record) => pinnedSet.has(record.cid))
    .reduce((sum, record) => sum + Number(record.sizeBytes || 0), 0);

  return buildViewModel({
    state,
    identity: { fingerprint: local.identity.fingerprint },
    participation,
    worker: local.capabilities.getWorkerHealth(),
    jobs: local.jobs.health(),
    compute: local.remoteCompute.settings(),
    storage: {
      repoBytes: Number(repo.RepoSize || 0),
      storageMaxBytes: Number(repo.StorageMax || 0),
      publicReplicaBytes,
      privateCaptureBytes: captures.reduce((sum, capture) => sum + capture.sizeBytes, 0),
      maxPinnedBytes: deps.config.maxPinnedBytes,
    },
    health: {
      backendReachable: live.backendHealth.reachable,
      kuboReachable: live.kuboHealth.reachable,
      kuboVersion: live.kuboHealth.version ?? null,
    },
    config: {
      nodeLabel: deps.config.nodeLabel,
      apiBaseUrl: deps.config.apiBaseUrl,
      maxPinnedCids: deps.config.maxPinnedCids,
      cidClassFilters: deps.config.cidClassFilters,
      localApiEnabled: deps.config.localApiEnabled,
      localApiAllowLan: deps.config.localApiAllowLan,
      guiRemoteMode: guiRemoteMode(deps.config),
      guiTokenConfigured: Boolean(deps.config.guiToken),
      operatorTokenConfigured: Boolean(deps.config.operatorToken),
    },
    captureCount: captures.length,
  });
}

/**
 * Starts a pairing session and returns it in renderable form.
 *
 * The one-time secret is deliberately returned under `code` rather than
 * `secret`: the GUI has to display it, and the response-level redaction that
 * protects every other endpoint would otherwise blank the pairing code. Nothing
 * else about the session — and no operator credential — is included.
 */
async function createGuiPairing(deps: GuiDeps) {
  const local = requireLocalApi(deps);
  const session = await local.pairing.createSession();
  // The app shows the node's name and fingerprint for confirmation before it
  // exchanges the credential, so both travel in the code itself — otherwise the
  // person is asked to trust a bare host and port. `formatFingerprint` is the
  // same grouped, uppercase form used in Settings, and the same form the app
  // computes from the public key it just received (`pk` in the payload) — the
  // operator compares this string, not the full 64-character digest.
  const fingerprint = formatFingerprint(session.node.fingerprint);
  return {
    code: session.payload,
    sessionId: session.sessionId,
    expiresAt: session.expiresAt,
    qrSvg: await renderQrSvg(session.payload, { title: 'kubus Node pairing code' }),
    node: {
      label: session.node.label,
      fingerprint,
      endpoint: session.node.endpoint,
    },
  };
}

async function readGuiJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const bytes = Buffer.from(chunk as Buffer);
    size += bytes.length;
    if (size > 64 * 1024) {
      const error = new Error('request_too_large') as Error & { statusCode?: number };
      error.statusCode = 413;
      throw error;
    }
    chunks.push(bytes);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') as Record<string, unknown>;
  } catch {
    const error = new Error('json_invalid') as Error & { statusCode?: number };
    error.statusCode = 400;
    throw error;
  }
}

function buildPinning(deps: GuiDeps) {
  const state = deps.store.snapshot();
  const familyCounts = state.desiredCids.reduce<Record<string, number>>((counts, record) => {
    const key = record.isRewardable ? 'rewardable' : record.role === 'manifest' ? 'manifest' : record.role === 'record' ? 'record' : (record.family || 'media');
    counts[key] = (counts[key] || 0) + 1;
    return counts;
  }, {});
  const rewardableCidSet = new Set(state.rewardableCids.map((item) => item.cid));
  const pinnedRewardableCidCount = state.pinnedCids.filter((cid) => rewardableCidSet.has(cid)).length;
  return redactSecrets({
    publicPinSetCount: state.publicPinSetTotal ?? state.publicPinSet.length,
    desiredCidCount: state.desiredCids.length,
    pinnedCidCount: state.pinnedCids.length,
    failedCidCount: Object.keys(state.failedCids).length,
    rewardableCidCount: state.rewardableCidTotal ?? state.rewardableCids.length,
    pinnedRewardableCidCount,
    estimatedPublicCoverage: state.desiredCids.length > 0 ? state.pinnedCids.length / state.desiredCids.length : 0,
    estimatedRewardableCoverage: (state.rewardableCidTotal ?? state.rewardableCids.length) > 0
      ? pinnedRewardableCidCount / (state.rewardableCidTotal ?? state.rewardableCids.length)
      : 0,
    roleCounts: {
      manifest: familyCounts.manifest || 0,
      record: familyCounts.record || 0,
      media: familyCounts.media || familyCounts.leaf || 0,
      rewardable: familyCounts.rewardable || 0,
    },
    maxPinnedCids: deps.config.maxPinnedCids,
    cidClassFilters: deps.config.cidClassFilters,
    latestSyncTime: state.latestPublicPinSetSyncAt || null,
    latestPinReconcileAt: state.latestPinReconcileAt || null,
    failedPins: Object.entries(state.failedCids).map(([cid, failure]) => ({ cid, ...failure })),
    actionLock: deps.actionLock.snapshot(),
  });
}

function buildRewards(store: LocalStore) {
  const state = store.snapshot();
  const rewards = state.rewards;
  const rewardableCidSet = new Set(state.rewardableCids.map((item) => item.cid));
  const pinnedRewardableCidCount = state.pinnedCids.filter((cid) => rewardableCidSet.has(cid)).length;
  const publicCoverage = state.desiredCids.length > 0 ? state.pinnedCids.length / state.desiredCids.length : 0;
  const rewardableCoverage = (state.rewardableCidTotal ?? state.rewardableCids.length) > 0
    ? pinnedRewardableCidCount / (state.rewardableCidTotal ?? state.rewardableCids.length)
    : 0;
  const backendEstimate = state.latestStatus?.archiveContribution || null;
  return redactSecrets({
    count: rewards?.count || 0,
    summary: rewards?.summary || { pendingKub8: 0, settledKub8: 0, noRewardEpochs: 0 },
    rewards: rewards?.rewards || [],
    estimate: {
      label: 'local_estimate_only',
      publicArchiveCoverage: publicCoverage,
      rewardableCoverage,
      pinnedPublicCidCount: state.pinnedCids.length,
      pinnedRewardableCidCount,
      failedPublicCidCount: Object.keys(state.failedCids).length,
      estimatedContributionScore: backendEstimate?.effectivePoints ?? null,
    },
    verified: backendEstimate,
    settlement: 'pending_control_plane_record',
    formula: 'Rewards are based on verified public archive availability. Priority CIDs add a bonus, but the public archive itself is rewarded.',
  });
}

function buildCommitments(deps: GuiDeps) {
  const state = deps.store.snapshot();
  return redactSecrets({
    count: state.activeCommitments.length,
    gatewayBaseUrl: deps.config.ipfsGatewayUrl.replace(/\/+$/, ''),
    commitments: state.activeCommitments,
  });
}

async function runAction(action: string, deps: GuiDeps): Promise<unknown> {
  if (action === 'sync') {
    return deps.actionLock.run('gui:sync-public-pin-set', () => syncPublicPinSet(deps.api, deps.store, deps.config));
  }
  if (action === 'pin') {
    return deps.actionLock.run('gui:reconcile-pins', () => reconcileDesiredPins(deps.kubo, deps.store, deps.config));
  }
  if (action === 'commitments') {
    return deps.actionLock.run('gui:refresh-commitments', () => refreshCommitments(deps.api, deps.kubo, deps.store, deps.config));
  }
  if (action === 'heartbeat') {
    const local = requireLocalApi(deps);
    return deps.actionLock.run('gui:heartbeat', () => sendHeartbeat(deps.api, deps.kubo, deps.store, deps.config, local.capabilities));
  }
  if (action === 'doctor') {
    return deps.actionLock.run('gui:doctor', () => runDoctor(deps));
  }
  const error = new Error(`Unknown GUI action: ${action}`);
  (error as Error & { statusCode?: number }).statusCode = 404;
  throw error;
}

/**
 * Actionable, specific copy for each typed retrieval outcome (Part 13.3) —
 * replaces the previous behaviour of surfacing whatever Node's raw `fetch`
 * threw, which for a DNS/TLS/connection failure is literally the string
 * "fetch failed" and tells the operator nothing they can act on.
 */
/**
 * Failures that are settings problems rather than network problems. Telling an
 * operator to check their connection when their gateway URL is simply
 * unusable wastes the one piece of information the probe actually recovered.
 */
const GATEWAY_CONFIGURATION_ADVICE: Record<string, string> = {
  gateway_url_port_not_permitted:
    'Gateway URL uses a port this runtime refuses to connect to. Check IPFS_GATEWAY_URL — a gateway normally runs on 8080 or 443.',
  gateway_url_scheme_unsupported:
    'Gateway URL scheme is not supported. Check IPFS_GATEWAY_URL — it must begin with http:// or https://.',
  gateway_url_invalid:
    'Gateway URL could not be parsed. Check IPFS_GATEWAY_URL for a typo.',
};

function describeRetrievalProbe(probe: RetrievalProbe): string {
  switch (probe.state) {
    case 'pinned':
      return 'Pinned locally';
    case 'local_retrievable':
      return 'Available from local Kubo';
    case 'gateway_retrievable':
      return 'Reachable via the configured gateway';
    case 'gateway_timeout':
      return 'Gateway timed out — the configured gateway did not respond in time';
    case 'gateway_unreachable':
      // A configuration mistake and a network outage need different actions
      // from the operator, so they must not read as the same message.
      return GATEWAY_CONFIGURATION_ADVICE[probe.errorClass ?? '']
        ?? `Gateway unreachable — could not connect (${probe.errorClass || 'unknown'}). Local content is unaffected.`;
    case 'gateway_http_error':
      return `Gateway returned HTTP ${probe.httpStatus} for this CID`;
    case 'gateway_not_found':
      return 'Gateway returned 404 for this CID';
    case 'invalid_cid':
      return 'CID is not valid';
  }
}

async function runDoctor(deps: GuiDeps) {
  const checks: Array<{ name: string; ok: boolean; detail?: string }> = [];
  const backend = await deps.api.getHealth().then(() => ({ ok: true })).catch((error) => ({ ok: false, detail: String((error as Error).message || error) }));
  checks.push({ name: 'Backend health', ...backend });
  const kubo = await getKuboHealth(deps.kubo);
  checks.push({ name: 'Kubo health', ok: kubo.reachable, detail: kubo.error || kubo.version });
  const stateWrite = await deps.store.update(() => undefined).then(() => ({ ok: true })).catch((error) => ({ ok: false, detail: String((error as Error).message || error) }));
  checks.push({ name: 'State file write', ...stateWrite });
  checks.push({ name: 'GUI hostname', ok: deps.config.guiHost === '0.0.0.0' || ['127.0.0.1', 'localhost', '::1'].includes(deps.config.guiHost), detail: deps.config.guiHost });
  checks.push({ name: 'GUI token', ok: Boolean(deps.config.guiToken), detail: deps.config.guiToken ? 'configured' : 'missing' });
  checks.push({ name: 'Operator token presence', ok: Boolean(deps.config.operatorToken), detail: deps.config.operatorToken ? 'configured' : 'missing' });
  const pinSet = await deps.api.getPublicPinSet({ limit: 1 }).then((data) => ({ ok: true, detail: `${data.count} public CIDs` })).catch((error) => ({ ok: false, detail: String((error as Error).message || error) }));
  checks.push({ name: 'Public pin-set endpoint', ...pinSet });
  const rewardable = await deps.api.getRewardableCids({ limit: 1 }).then((data) => ({ ok: true, detail: `${data.count} rewardable CIDs` })).catch((error) => ({ ok: false, detail: String((error as Error).message || error) }));
  checks.push({ name: 'Rewardable endpoint', ...rewardable });
  const cid = deps.store.snapshot().pinnedCids[0];
  if (cid) {
    const probe = await probeRetrieval(deps.kubo, deps.config.ipfsGatewayUrl, cid);
    checks.push({ name: 'Gateway retrieval', ok: RETRIEVAL_AVAILABLE_STATES.includes(probe.state), detail: describeRetrievalProbe(probe) });
  } else {
    checks.push({ name: 'Gateway retrieval', ok: true, detail: 'No pinned CID available yet' });
  }
  await refreshStatus(deps.api, deps.kubo, deps.store).catch(() => null);
  await refreshRewards(deps.api, deps.store).catch(() => null);
  return redactSecrets({ checks });
}

function writeText(res: ServerResponse, statusCode: number, body: string, contentType: string): void {
  writeHead(res, statusCode, contentType);
  res.end(body);
}

function writeHead(res: ServerResponse, statusCode: number, contentType: string): void {
  res.writeHead(statusCode, {
    'content-type': contentType,
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  });
}

function writeJson(
  res: ServerResponse,
  statusCode: number,
  payload: unknown,
  canonicalPairingCode?: string,
): void {
  res.writeHead(statusCode, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  });
  const sanitized = redactSecrets(payload) as Record<string, unknown>;
  if (canonicalPairingCode && sanitized && typeof sanitized === 'object') {
    const data = sanitized.data;
    if (data && typeof data === 'object') {
      // This is the sole intentional exemption from GUI value redaction: the
      // one-time canonical URI must remain byte-identical to the QR input.
      (data as Record<string, unknown>).code = canonicalPairingCode;
    }
  }
  res.end(JSON.stringify(sanitized));
}
