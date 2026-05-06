import { KubusApiClient } from '../backend/kubusApiClient.js';
import { BearerAuthProvider } from '../backend/operatorAuth.js';
import { parseEnv, resolveNodeKey } from '../config/env.js';
import { KuboClient } from '../ipfs/kuboClient.js';
import { getKuboHealth, waitForKubo } from '../ipfs/health.js';
import { createLogger } from '../logging/logger.js';
import { startGuiServer, type GuiServerHandle } from '../gui/guiServer.js';
import { ensureRegistered } from '../operator/registerNode.js';
import { syncPublicPinSet, reconcileDesiredPins, refreshCommitments } from '../operator/commitments.js';
import { sendHeartbeat } from '../operator/heartbeat.js';
import { refreshRewards } from '../operator/rewards.js';
import { buildStatusSummary, refreshStatus } from '../operator/status.js';
import { ActionLock } from '../runtime/actionLock.js';
import { Scheduler } from '../scheduler/loops.js';
import { LocalStore } from '../state/localStore.js';

export async function runCli(argv = process.argv.slice(2)): Promise<void> {
  const command = argv[0] || 'start';
  const config = parseEnv();
  const logger = createLogger(config.logLevel);
  const store = new LocalStore(config.localStatePath);
  await store.load();
  const api = new KubusApiClient({ baseUrl: config.apiBaseUrl, auth: new BearerAuthProvider(config.operatorToken) });
  const kubo = new KuboClient(config.ipfsRpcUrl);
  const actionLock = new ActionLock();

  if (command === 'status') {
    const live = await liveStatus(api, kubo);
    console.log(JSON.stringify(buildStatusSummary(config, store.snapshot(), live), null, 2));
    return;
  }

  if (command === 'doctor') {
    await doctor(api, kubo, config, store);
    return;
  }

  if (command === 'gui') {
    const gui = await startGuiServer({ api, kubo, store, config: { ...config, guiEnabled: true }, logger, actionLock });
    console.log(JSON.stringify({
      status: 'gui_started',
      url: gui.url,
      fallbackUrl: config.guiFallbackUrl,
      localhostOnly: !config.guiAllowRemote,
      tokenConfigured: Boolean(config.guiToken),
    }, null, 2));
    await waitForShutdown(null, gui);
    return;
  }

  if (command === 'register') {
    const kuboHealth = await waitForKubo(kubo);
    const peerId = kuboHealth.peerId || '';
    const node = await ensureRegistered(api, store, config, peerId, kuboHealth);
    console.log(JSON.stringify(node, null, 2));
    return;
  }

  if (command === 'sync') {
    await bootstrapOnce(api, kubo, store, config);
    console.log(JSON.stringify(buildStatusSummary(config, store.snapshot()), null, 2));
    return;
  }

  if (command === 'pin') {
    await syncPublicPinSet(api, store, config);
    console.log(JSON.stringify(await reconcileDesiredPins(kubo, store, config), null, 2));
    return;
  }

  if (command === 'heartbeat') {
    console.log(JSON.stringify(await sendHeartbeat(api, kubo, store, config), null, 2));
    return;
  }

  if (command === 'rewards') {
    console.log(JSON.stringify(await refreshRewards(api, store), null, 2));
    return;
  }

  if (command !== 'start') throw new Error(`Unknown command: ${command}`);
  const gui = config.guiEnabled ? await startGuiServer({ api, kubo, store, config, logger, actionLock }) : null;
  let scheduler: Scheduler | null = null;
  try {
    await actionLock.run('startup', () => bootstrapOnce(api, kubo, store, config));
    scheduler = new Scheduler({ api, kubo, store, config, logger, actionLock });
    scheduler.start();
    logger.info({ nodeId: store.snapshot().nodeId }, 'kubus node started');
  } catch (error) {
    logger.error({ error: String((error as Error).message || error) }, 'kubus node startup failed');
    if (!gui) throw error;
    logger.warn({ guiUrl: gui.url }, 'GUI remains available for local diagnostics; scheduler was not started');
  }
  await waitForShutdown(scheduler, gui);
}

async function bootstrapOnce(api: KubusApiClient, kubo: KuboClient, store: LocalStore, config: ReturnType<typeof parseEnv>) {
  await api.getHealth();
  const kuboHealth = await waitForKubo(kubo);
  await resolveNodeKey(config, store);
  await ensureRegistered(api, store, config, kuboHealth.peerId || '', kuboHealth);
  const policy = await api.getPolicies();
  await store.update((state) => {
    state.policy = policy;
  });
  const desired = await syncPublicPinSet(api, store, config);
  await sendHeartbeat(api, kubo, store, config);
  await refreshStatus(api, kubo, store);
  await refreshRewards(api, store);
  if (desired.length > 0) {
    console.log(JSON.stringify({
      status: 'startup_deferred_pin_reconcile',
      desiredCidCount: desired.length,
      message: 'Node registered and heartbeat sent; scheduler will reconcile public pins in the background.',
    }));
  }
}

async function liveStatus(api: KubusApiClient, kubo: KuboClient) {
  const [backendHealth, kuboHealth] = await Promise.all([
    api.getHealth().catch((error) => ({ reachable: false, error: String(error?.message || error) })),
    getKuboHealth(kubo),
  ]);
  return { backendHealth, kuboHealth };
}

async function doctor(api: KubusApiClient, kubo: KuboClient, config: ReturnType<typeof parseEnv>, store: LocalStore) {
  const report = {
    env: {
      backendUrl: config.apiBaseUrl,
      ipfsRpcUrl: config.ipfsRpcUrl,
      ipfsGatewayUrl: config.ipfsGatewayUrl,
      statePath: config.localStatePath,
      production: config.isProduction,
    },
    live: await liveStatus(api, kubo),
    local: buildStatusSummary(config, store.snapshot()),
  };
  console.log(JSON.stringify(report, null, 2));
}

async function waitForShutdown(scheduler: Scheduler | null, gui?: GuiServerHandle | null): Promise<void> {
  await new Promise<void>((resolve) => {
    const done = () => resolve();
    process.once('SIGINT', done);
    process.once('SIGTERM', done);
  });
  await scheduler?.stop();
  await gui?.close();
}
