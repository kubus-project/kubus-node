import type { KubusApiClient } from '../backend/kubusApiClient.js';
import type { AppConfig } from '../config/schema.js';
import { getKuboHealth } from '../ipfs/health.js';
import type { KuboClient } from '../ipfs/kuboClient.js';
import type { LocalStore } from '../state/localStore.js';
import crypto from 'node:crypto';

export async function refreshStatus(api: KubusApiClient, kubo: KuboClient, store: LocalStore) {
  const state = store.snapshot();
  const [status, epoch, commitments] = await Promise.all([
    state.nodeId ? api.getNodeStatus(state.nodeId) : Promise.resolve(state.latestStatus),
    api.getCurrentEpoch(),
    state.nodeId ? api.getCurrentCommitments(state.nodeId) : Promise.resolve({ commitments: [] }),
  ]);
  await store.update((next) => {
    if (status) next.latestStatus = status;
    next.currentEpoch = epoch.epoch;
    next.activeCommitments = commitments.commitments;
  });
  return { status, epoch, commitments, kubo: await getKuboHealth(kubo) };
}

export function buildStatusSummary(config: AppConfig, state: ReturnType<LocalStore['snapshot']>, live?: { backendHealth?: unknown; kuboHealth?: unknown }) {
  return {
    backendUrl: config.apiBaseUrl,
    backendHealth: live?.backendHealth || 'not_checked',
    operatorWallet: config.operatorWallet,
    nodeKeyFingerprint: state.nodeKey ? crypto.createHash('sha256').update(state.nodeKey).digest('hex').slice(0, 16) : null,
    nodeId: state.nodeId || null,
    registered: Boolean(state.nodeId),
    kuboPeerId: state.peerId || null,
    kuboHealth: live?.kuboHealth || 'not_checked',
    policyVersion: state.policy?.version || null,
    rewardableCidCount: state.rewardableCids.length,
    desiredCidCount: state.desiredCids.length,
    pinnedCidCount: state.pinnedCids.length,
    failedCidCount: Object.keys(state.failedCids).length,
    activeCommitmentCount: state.activeCommitments.length,
    lastHeartbeat: state.latestHeartbeat?.receivedAt || null,
    backendNodeStatus: state.latestStatus?.status || null,
    currentEpoch: state.currentEpoch?.epochKey || null,
    pendingKub8Rewards: state.rewards?.summary?.pendingKub8 ?? state.latestStatus?.rewardSummary?.pendingKub8 ?? 0,
    stateUpdatedAt: state.updatedAt || null,
  };
}
