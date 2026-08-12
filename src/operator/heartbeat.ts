import type { KubusApiClient } from '../backend/kubusApiClient.js';
import type { AppConfig } from '../config/schema.js';
import { getKuboHealth } from '../ipfs/health.js';
import type { KuboClient } from '../ipfs/kuboClient.js';
import type { LocalStore } from '../state/localStore.js';
import { AGENT_VERSION } from './registerNode.js';
import type { CapabilityRegistry } from '../capabilities/registry.js';
import type { NetworkParticipationGate } from '../participation/networkParticipationGate.js';
import type { ComputeIdentityService } from '../compute/computeIdentity.js';
import { effectiveComputeProviderSettings } from '../compute/providerSettings.js';

function clampRatio(value: number): number {
  return Math.min(Math.max(Number.isFinite(value) ? value : 0, 0), 1);
}

export async function sendHeartbeat(api: KubusApiClient, kubo: KuboClient, store: LocalStore, config: AppConfig, capabilities: CapabilityRegistry, gate?: NetworkParticipationGate, identity?: ComputeIdentityService) {
  const state = store.snapshot();
  if (!state.nodeId) throw new Error('Cannot send heartbeat before registration');
  const kuboHealth = await getKuboHealth(kubo);
  const status = kuboHealth.reachable && Object.keys(state.failedCids).length === 0 ? 'healthy' : kuboHealth.reachable ? 'degraded' : 'offline';
  const rewardableCidSet = new Set(state.rewardableCids.map((item) => item.cid));
  const pinnedRewardableCidCount = state.pinnedCids.filter((cid) => rewardableCidSet.has(cid)).length;
  const publicPinSetCount = state.publicPinSetTotal ?? state.publicPinSet.length;
  const rewardableCidCount = state.rewardableCidTotal ?? state.rewardableCids.length;
  const estimatedPublicCoverage = clampRatio(state.pinnedCids.length / Math.max(state.desiredCids.length || publicPinSetCount, 1));
  const estimatedRewardableCoverage = clampRatio(pinnedRewardableCidCount / Math.max(rewardableCidCount, 1));
  const capabilityStatuses = await capabilities.refreshIfStale();
  const jobs = Object.values(state.jobs || {}) as Array<{ state?: string }>;
  const privateSpatialBytes = Object.values(state.captures || {}).reduce<number>((sum, value) => sum + Number((value as { sizeBytes?: number }).sizeBytes || 0), 0);
  const publicReplicaBytes = state.desiredCids.filter((item) => state.pinnedCids.includes(item.cid)).reduce((sum, item) => sum + Number(item.sizeBytes || 0), 0);
  const participation = gate ? await gate.refresh() : null;
  const computeIdentity = identity ? await identity.publicIdentity() : null;
  const providerSettings = effectiveComputeProviderSettings(config, state);
  const response = await api.sendHeartbeat({
    nodeId: state.nodeId,
    peerId: state.peerId,
    agentVersion: AGENT_VERSION,
    kuboHealth: kuboHealth as unknown as Record<string, unknown>,
    storage: {
      ...(kuboHealth.repo && typeof kuboHealth.repo === 'object' ? kuboHealth.repo : {}),
      publicReplicaBytes,
      localPrivateSpatialBytes: privateSpatialBytes,
      maxPinnedBytes: config.maxPinnedBytes,
    } as Record<string, unknown>,
    trackedCidCount: state.desiredCids.length,
    pinnedCidCount: state.pinnedCids.length,
    failedCidCount: Object.keys(state.failedCids).length,
    rewardableCidCount,
    status,
    metadata: {
      operatorWallet: config.operatorWallet,
      skipPinning: config.skipPinning,
      publicPinSetCount,
      desiredCidCount: state.desiredCids.length,
      desiredPublicCidCount: state.desiredCids.length,
      rewardableCidCount,
      pinnedPublicCidCount: state.pinnedCids.length,
      failedPublicCidCount: Object.keys(state.failedCids).length,
      pinnedRewardableCidCount,
      latestPublicPinSetSyncAt: state.latestPublicPinSetSyncAt || null,
      latestPinReconcileAt: state.latestPinReconcileAt || null,
      latestCommitmentRefreshAt: state.latestCommitmentRefreshAt || null,
      estimatedPublicCoverage,
      estimatedRewardableCoverage,
      guiEnabled: config.guiEnabled === true,
      nodeVersion: AGENT_VERSION,
      capabilities: Object.fromEntries(capabilityStatuses.map((item) => [item.name, { available: item.available, healthy: item.healthy }])),
      jobsRunning: jobs.filter((job) => job.state === 'running').length,
      jobsQueued: jobs.filter((job) => job.state === 'queued').length,
      spatialWorkerHealth: capabilities.getWorkerHealth(),
      participation,
      remoteCompute: {
        enabled: providerSettings.enabled,
        accepting: providerSettings.enabled && !providerSettings.paused && participation?.leaseEligible === true,
        paused: providerSettings.paused,
        maxConcurrency: providerSettings.maxConcurrency,
        maxQueueDepth: providerSettings.maxQueueDepth,
        maxAcceptedInputBytes: providerSettings.maxAcceptedInputBytes,
        minimumFreeVramBytes: providerSettings.minimumFreeVramBytes,
        runningJobs: jobs.filter((job) => job.state === 'running' && (job as { input?: { remoteComputeJobId?: string } }).input?.remoteComputeJobId).length,
        queuedJobs: jobs.filter((job) => job.state === 'queued' && (job as { input?: { remoteComputeJobId?: string } }).input?.remoteComputeJobId).length,
        protocolVersion: 'kubus.compute/1',
        encryptionPublicKey: computeIdentity?.encryptionPublicKey,
        signingPublicKey: computeIdentity?.signingPublicKey,
      },
      pinningSource: state.policy?.pinning || null,
    },
  });
  await store.update((next) => {
    next.latestHeartbeat = response.heartbeat as never;
    next.latestStatus = response.status;
    next.latestHeartbeatAt = new Date().toISOString();
  });
  await gate?.recordHeartbeatAccepted();
  return response;
}
