import http, { type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { KubusApiClient } from '../backend/kubusApiClient.js';
import type { AppConfig } from '../config/schema.js';
import { getKuboHealth } from '../ipfs/health.js';
import type { KuboClient } from '../ipfs/kuboClient.js';
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

export interface GuiDeps {
  api: KubusApiClient;
  kubo: KuboClient;
  store: LocalStore;
  config: AppConfig;
  logger: Logger;
  actionLock: ActionLock;
}

export interface GuiServerHandle {
  url: string;
  close: () => Promise<void>;
}

export async function startGuiServer(deps: GuiDeps): Promise<GuiServerHandle> {
  assertGuiConfig(deps.config);
  const server = http.createServer((req, res) => {
    void handleRequest(req, res, deps).catch((error) => {
      writeJson(res, Number((error as Error & { statusCode?: number }).statusCode || 500), {
        success: false,
        error: String((error as Error).message || error),
      });
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(deps.config.guiPort, deps.config.guiHost, () => resolve());
  });
  const address = server.address() as AddressInfo;
  const url = deps.config.guiPort === 0
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

function buildPinning(deps: GuiDeps) {
  const state = deps.store.snapshot();
  return redactSecrets({
    publicPinSetCount: state.publicPinSet.length,
    desiredCidCount: state.desiredCids.length,
    pinnedCidCount: state.pinnedCids.length,
    failedCidCount: Object.keys(state.failedCids).length,
    rewardableCidCount: state.rewardableCids.length,
    maxPinnedCids: deps.config.maxPinnedCids,
    cidClassFilters: deps.config.cidClassFilters,
    latestSyncTime: state.updatedAt || null,
    failedPins: Object.entries(state.failedCids).map(([cid, failure]) => ({ cid, ...failure })),
    actionLock: deps.actionLock.snapshot(),
  });
}

function buildRewards(store: LocalStore) {
  const rewards = store.snapshot().rewards;
  return redactSecrets({
    count: rewards?.count || 0,
    summary: rewards?.summary || { pendingKub8: 0, settledKub8: 0, noRewardEpochs: 0 },
    rewards: rewards?.rewards || [],
    settlement: 'pending_control_plane_record',
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
    return deps.actionLock.run('gui:heartbeat', () => sendHeartbeat(deps.api, deps.kubo, deps.store, deps.config));
  }
  if (action === 'doctor') {
    return deps.actionLock.run('gui:doctor', () => runDoctor(deps));
  }
  const error = new Error(`Unknown GUI action: ${action}`);
  (error as Error & { statusCode?: number }).statusCode = 404;
  throw error;
}

async function runDoctor(deps: GuiDeps) {
  const checks: Array<{ name: string; ok: boolean; detail?: string }> = [];
  const backend = await deps.api.getHealth().then(() => ({ ok: true })).catch((error) => ({ ok: false, detail: String((error as Error).message || error) }));
  checks.push({ name: 'Backend health', ...backend });
  const kubo = await getKuboHealth(deps.kubo);
  checks.push({ name: 'Kubo health', ok: kubo.reachable, detail: kubo.error || kubo.version });
  const stateWrite = await deps.store.update(() => undefined).then(() => ({ ok: true })).catch((error) => ({ ok: false, detail: String((error as Error).message || error) }));
  checks.push({ name: 'State file write', ...stateWrite });
  checks.push({ name: 'Operator token presence', ok: Boolean(deps.config.operatorToken), detail: deps.config.operatorToken ? 'configured' : 'missing' });
  const pinSet = await deps.api.getPublicPinSet({ limit: 1 }).then((data) => ({ ok: true, detail: `${data.count} public CIDs` })).catch((error) => ({ ok: false, detail: String((error as Error).message || error) }));
  checks.push({ name: 'Public pin-set endpoint', ...pinSet });
  const rewardable = await deps.api.getRewardableCids({ limit: 1 }).then((data) => ({ ok: true, detail: `${data.count} rewardable CIDs` })).catch((error) => ({ ok: false, detail: String((error as Error).message || error) }));
  checks.push({ name: 'Rewardable endpoint', ...rewardable });
  const cid = deps.store.snapshot().pinnedCids[0];
  if (cid) {
    const gateway = await fetch(`${deps.config.ipfsGatewayUrl.replace(/\/+$/, '')}/ipfs/${encodeURIComponent(cid)}`, { method: 'GET' })
      .then((response) => ({ ok: response.ok, detail: `HTTP ${response.status}` }))
      .catch((error) => ({ ok: false, detail: String((error as Error).message || error) }));
    checks.push({ name: 'Gateway retrieval', ...gateway });
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

function writeJson(res: ServerResponse, statusCode: number, payload: unknown): void {
  res.writeHead(statusCode, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  });
  res.end(JSON.stringify(redactSecrets(payload)));
}
