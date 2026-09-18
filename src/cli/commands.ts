import path from 'node:path';
import { existsSync } from 'node:fs';
import { KubusApiClient } from '../backend/kubusApiClient.js';
import { BearerAuthProvider } from '../backend/operatorAuth.js';
import { parseEnv, persistedConfigPath, resolveNodeKey } from '../config/env.js';
import { loadOrCreateNodeIdentity } from '../identity/nodeIdentity.js';
import { enrollNodeIdentity } from '../identity/remoteAttach.js';
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
import { CapabilityRegistry } from '../capabilities/registry.js';
import { PairingService } from '../localApi/pairingService.js';
import { CaptureStore } from '../captures/captureStore.js';
import { JobRuntime } from '../jobs/jobRuntime.js';
import { NetworkParticipationGate } from '../participation/networkParticipationGate.js';
import { WorkerAuthService } from '../spatial/workerAuth.js';
import { ComputeIdentityService } from '../compute/computeIdentity.js';
import { PrivatePayloadTransport } from '../compute/privatePayloadTransport.js';
import { RemoteComputeRuntime } from '../compute/remoteComputeRuntime.js';
import { NodeSignalingClient } from '../webrtc/nodeSignalingClient.js';
import { startSetupServer } from '../gui/setupServer.js';
import { PermissionUpdateService } from '../setup/permissionUpdate.js';
import { AnalyticsStore } from '../analytics/analyticsStore.js';
import { recoverNetworkStartup } from '../runtime/networkStartup.js';

/**
 * Whether a command may sweep orphaned capture directories.
 *
 * Only the commands that then serve uploads. `status` is the container
 * healthcheck: a second process, running every 30 seconds, whose in-memory
 * draft map is necessarily empty, so to it every live transfer looks
 * orphaned.
 */
export function reclaimsOrphanedCaptures(command: string): boolean {
  return command === 'start' || command === 'gui';
}

export async function runCli(argv = process.argv.slice(2)): Promise<void> {
  const command = argv[0] || 'start';
  let config: ReturnType<typeof parseEnv>;
  try {
    config = parseEnv();
  } catch (error) {
    // First start is the one moment the runtime cannot yet know the backend
    // token or operator wallet. Serve setup only when there is no durable
    // configuration file; a broken existing configuration must fail loudly
    // rather than presenting an unauthenticated overwrite page.
    if (command !== 'start' || existsSync(process.env.KUBUS_NODE_CONFIG_PATH?.trim() || persistedConfigPath())) throw error;
    const setup = await startSetupServer();
    console.log(JSON.stringify({ status: 'setup_required', url: setup.url }, null, 2));
    await waitForShutdown(null, setup);
    return;
  }
  const logger = createLogger(config.logLevel);
  const store = new LocalStore(config.localStatePath);
  await store.load();
  // Own file, own directory — never inside `state.json`. See identity/nodeIdentity.ts.
  const identity = await loadOrCreateNodeIdentity(path.dirname(config.localStatePath), logger);
  const api = new KubusApiClient({ baseUrl: config.apiBaseUrl, auth: new BearerAuthProvider(config.operatorToken) });
  const kubo = new KuboClient(config.ipfsRpcUrl);
  const actionLock = new ActionLock();
  const capabilities = new CapabilityRegistry(kubo, config.spatialWorkerUrl);
  const participationGate = new NetworkParticipationGate({ store, config, kubo });
  const workerAuth = new WorkerAuthService(config.workerAuthKeyPath);
  await workerAuth.initialize();
  const computeIdentity = new ComputeIdentityService(store);
  await computeIdentity.initialize();
  const pairing = new PairingService(store, config, identity);
  const captures = new CaptureStore(config.localDataPath, store);
  // Streaming-upload drafts are in-memory, so a restart mid-transfer leaves a
  // capture directory with no owner. Reclaim those before serving, or every
  // interrupted upload permanently consumes disk.
  //
  // Only the commands that go on to serve uploads may sweep. `status` is the
  // container healthcheck and runs every 30 seconds in a second process whose
  // draft map is empty, so sweeping there deleted whatever transfer was in
  // flight while the serving process carried on accounting for files that no
  // longer existed — and committed the capture as complete.
  if (reclaimsOrphanedCaptures(command)) {
    const reclaimedCaptures = await captures.reclaimOrphanedDirectories();
    if (reclaimedCaptures > 0) {
      logger.info(`captures: reclaimed ${reclaimedCaptures} orphaned capture ${reclaimedCaptures === 1 ? 'directory' : 'directories'}`);
    }
  }
  // Own file, own directory — same rationale as identity above: bounded
  // derived counters, never appended into state.json's single growing file.
  const analytics = new AnalyticsStore(path.join(path.dirname(config.localStatePath), 'analytics.json'));
  await analytics.load();
  const jobs = new JobRuntime({ store, captureStore: captures, kubo, logger, dataRoot: config.localDataPath, workerUrl: config.spatialWorkerUrl, concurrency: config.jobConcurrency, participationGate, workerAuth, capabilities, analytics });
  const privateTransport = new PrivatePayloadTransport({ captures, kubo, store, identity: computeIdentity, dataRoot: config.localDataPath, maxInputBytes: config.remoteComputeMaxInputBytes });
  const remoteCompute = new RemoteComputeRuntime({ api, kubo, store, config, captures, jobs, gate: participationGate, identity: computeIdentity, transport: privateTransport, logger });
  // Explicit, account-authorized credential rotation for a Node paired before
  // the current scope contract. Restarting is how the replacement takes
  // effect, matching how setup converges from unconfigured to running.
  const permissionUpdate = new PermissionUpdateService({
    apiBaseUrl: config.apiBaseUrl,
    configPath: process.env.KUBUS_NODE_CONFIG_PATH?.trim() || persistedConfigPath(),
    identity,
    nodeId: () => store.snapshot().nodeId,
    currentToken: () => config.operatorToken,
    logger,
    onCredentialReplaced: () => { setTimeout(() => process.exit(75), 150).unref(); },
  });
  const localApi = { api, kubo, store, config, capabilities, pairing, captures, jobs, participationGate, remoteCompute, identity, permissionUpdate };

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
    participationGate.setSchedulerActive(false);
    await jobs.start();
    await capabilities.refresh();
    const guiConfig = { ...config, guiEnabled: true };
    const gui = await startGuiServer({ api, kubo, store, config: guiConfig, logger, actionLock, analytics, localApi: { ...localApi, config: guiConfig } });
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
    await bootstrapOnce(api, kubo, store, config, capabilities);
    console.log(JSON.stringify(buildStatusSummary(config, store.snapshot()), null, 2));
    return;
  }

  if (command === 'pin') {
    await syncPublicPinSet(api, store, config);
    console.log(JSON.stringify(await reconcileDesiredPins(kubo, store, config), null, 2));
    return;
  }

  if (command === 'heartbeat') {
    console.log(JSON.stringify(await sendHeartbeat(api, kubo, store, config, capabilities), null, 2));
    return;
  }

  if (command === 'rewards') {
    console.log(JSON.stringify(await refreshRewards(api, store), null, 2));
    return;
  }

  if (command !== 'start') throw new Error(`Unknown command: ${command}`);
  await jobs.start();
  await capabilities.refresh();
  // Declared before the GUI so its late-bound diagnostics read the live client.
  let signaling: NodeSignalingClient | null = null;
  const gui = (config.guiEnabled || config.localApiEnabled)
    ? await startGuiServer({
      api, kubo, store, config, logger, actionLock, analytics, localApi,
      remoteConnections: () => signaling?.connectionDiagnostics() ?? [],
    })
    : null;
  let scheduler: Scheduler | null = null;
  const startupAbort = new AbortController();
  const startup = recoverNetworkStartup({
    signal: startupAbort.signal,
    logger,
    bootstrap: () => actionLock.run('startup', () => bootstrapOnce(api, kubo, store, config, capabilities, participationGate, computeIdentity)),
    activate: () => {
      scheduler = new Scheduler({ api, kubo, store, config, logger, gate: participationGate, identity: computeIdentity, capabilities, actionLock });
      scheduler.start();
      remoteCompute.start();
      // The signaling namespace authorizes the durable node id against the
      // operator token, so it can only start after registration. It remains
      // explicitly non-fatal: a signaling outage must not take down LAN access,
      // configured HTTPS, or archive participation.
      const nodeId = store.snapshot().nodeId;
      if (nodeId) {
        // Enrollment failure affects remote first attachment only. Local access,
        // archive and existing pairings remain available during backend outages.
        void enrollNodeIdentity(api, nodeId, identity).catch(() => {
          logger.warn({ nodeId }, 'remote identity enrollment unavailable; existing pairings are preserved');
        });
        signaling = new NodeSignalingClient({ config, nodeId, localApi, identity, logger });
        signaling.start();
      }
      logger.info({ nodeId: store.snapshot().nodeId }, 'kubus node started');
    },
  });
  await waitForShutdown({ stop: async () => {
    startupAbort.abort();
    // Backend requests have their own timeouts. A request completing after
    // shutdown cannot activate services because recovery checks the signal.
    // This wait was 10s, which is Docker's entire stop grace period on its own,
    // so every stop was SIGKILLed here while startup finished reconciling pins
    // in the background. Aborting is what matters; waiting is a courtesy.
    await Promise.race([startup, new Promise<void>((resolve) => { setTimeout(resolve, STARTUP_ABORT_GRACE_MS).unref(); })]);
    await scheduler?.stop();
    await signaling?.stop();
  } }, gui, remoteCompute, null, logger);
}

async function bootstrapOnce(api: KubusApiClient, kubo: KuboClient, store: LocalStore, config: ReturnType<typeof parseEnv>, capabilities: CapabilityRegistry, gate?: NetworkParticipationGate, identity?: ComputeIdentityService) {
  await api.getHealth();
  const kuboHealth = await waitForKubo(kubo);
  await resolveNodeKey(config, store);
  await ensureRegistered(api, store, config, kuboHealth.peerId || '', kuboHealth);
  const policy = await api.getPolicies();
  await store.update((state) => {
    state.policy = policy;
  });
  const desired = await syncPublicPinSet(api, store, config);
  await sendHeartbeat(api, kubo, store, config, capabilities, gate, identity);
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

// Docker's default stop grace period is 10 seconds. A shutdown that has not
// finished by then is SIGKILLed, which can truncate the state file mid-write,
// so teardown is given a deadline inside that window rather than being allowed
// to block forever.
// Total must leave clear margin under the grace period: an 8s budget plus the
// forced-exit delay measured 9.8s against a 10s limit, which is a coin flip.
export const SHUTDOWN_DEADLINE_MS = 5000;
// Each step is bounded on its own, so one step that never returns cannot stop
// the others from running. Closing the GUI still happens when the scheduler
// hangs, and the log names whichever step was at fault.
export const SHUTDOWN_STEP_BUDGET_MS = 1500;
const FORCED_EXIT_DELAY_MS = 500;
// How long shutdown waits for an aborted startup to unwind before moving on.
// Must stay inside a single step's budget or the scheduler step always stalls.
export const STARTUP_ABORT_GRACE_MS = 1000;

export async function waitForShutdown(
  scheduler: { stop(): Promise<void> } | null,
  gui?: GuiServerHandle | null,
  remoteCompute?: RemoteComputeRuntime,
  signaling?: NodeSignalingClient | null,
  logger?: { info(obj: unknown, msg?: string): void; warn(obj: unknown, msg?: string): void },
  options: {
    deadlineMs?: number;
    stepBudgetMs?: number;
    // Injectable so tests can observe the forced exit instead of being killed by it.
    forceExit?: () => void;
  } = {},
): Promise<void> {
  const deadlineMs = options.deadlineMs ?? SHUTDOWN_DEADLINE_MS;
  const forceExit = options.forceExit ?? (() => process.exit(0));
  const signal = await new Promise<string>((resolve) => {
    process.once('SIGINT', () => resolve('SIGINT'));
    process.once('SIGTERM', () => resolve('SIGTERM'));
  });
  logger?.info({ signal, deadlineMs }, 'shutdown requested');

  const startedAt = Date.now();
  const stepBudget = options.stepBudgetMs ?? SHUTDOWN_STEP_BUDGET_MS;
  const stalled: string[] = [];

  const runStep = async (name: string, run: () => Promise<void> | void): Promise<void> => {
    const remaining = deadlineMs - (Date.now() - startedAt);
    if (remaining <= 0) {
      stalled.push(name);
      return;
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    const budget = Math.min(stepBudget, remaining);
    const timeout = new Promise<'timeout'>((resolve) => {
      timer = setTimeout(() => resolve('timeout'), budget);
      timer.unref();
    });
    const stepStartedAt = Date.now();
    const outcome = await Promise.race([
      (async (): Promise<'done' | 'failed'> => {
        try {
          await run();
          return 'done';
        } catch (error) {
          logger?.warn({ step: name, err: error instanceof Error ? error.message : String(error) }, 'shutdown step failed');
          return 'failed';
        }
      })(),
      timeout,
    ]);
    if (timer) clearTimeout(timer);
    if (outcome === 'timeout') {
      stalled.push(name);
      logger?.warn({ step: name, budgetMs: budget }, 'shutdown step did not finish in time');
    } else {
      logger?.info({ step: name, ms: Date.now() - stepStartedAt, outcome }, 'shutdown step finished');
    }
  };

  await runStep('scheduler', async () => { await scheduler?.stop(); });
  await runStep('remoteCompute', () => { remoteCompute?.stop(); });
  await runStep('signaling', async () => { await signaling?.stop(); });
  await runStep('gui', async () => { await gui?.close(); });

  if (stalled.length > 0) {
    logger?.warn({ stalled, ms: Date.now() - startedAt }, 'shutdown completed with stalled steps; exiting anyway');
  } else {
    logger?.info({ ms: Date.now() - startedAt }, 'shutdown complete');
  }

  // Completing teardown is not the same as exiting: one lingering handle (a
  // keep-alive socket, an un-unref'd interval) keeps the event loop running and
  // the container is then SIGKILLed anyway. This timer is unref'd, so it does
  // not hold the loop open when the process is ready to exit on its own, and it
  // fires only if something else is still holding it.
  setTimeout(forceExit, FORCED_EXIT_DELAY_MS).unref();
}
