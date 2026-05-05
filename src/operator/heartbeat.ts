import type { KubusApiClient } from '../backend/kubusApiClient.js';
import type { AppConfig } from '../config/schema.js';
import { getKuboHealth } from '../ipfs/health.js';
import type { KuboClient } from '../ipfs/kuboClient.js';
import type { LocalStore } from '../state/localStore.js';
import { AGENT_VERSION } from './registerNode.js';

export async function sendHeartbeat(api: KubusApiClient, kubo: KuboClient, store: LocalStore, config: AppConfig) {
  const state = store.snapshot();
  if (!state.nodeId) throw new Error('Cannot send heartbeat before registration');
  const kuboHealth = await getKuboHealth(kubo);
  const status = kuboHealth.reachable && Object.keys(state.failedCids).length === 0 ? 'healthy' : kuboHealth.reachable ? 'degraded' : 'offline';
  const response = await api.sendHeartbeat({
    nodeId: state.nodeId,
    peerId: state.peerId,
    agentVersion: AGENT_VERSION,
    kuboHealth: kuboHealth as unknown as Record<string, unknown>,
    storage: (kuboHealth.repo && typeof kuboHealth.repo === 'object' ? kuboHealth.repo : {}) as Record<string, unknown>,
    trackedCidCount: state.desiredCids.length,
    pinnedCidCount: state.pinnedCids.length,
    failedCidCount: Object.keys(state.failedCids).length,
    rewardableCidCount: state.rewardableCids.length,
    status,
    metadata: {
      operatorWallet: config.operatorWallet,
      skipPinning: config.skipPinning,
      publicPinSetCount: state.publicPinSet.length,
      desiredPublicCidCount: state.desiredCids.length,
      rewardableCidCount: state.rewardableCids.length,
      pinnedPublicCidCount: state.pinnedCids.length,
      failedPublicCidCount: Object.keys(state.failedCids).length,
      pinningSource: state.policy?.pinning || null,
    },
  });
  await store.update((next) => {
    next.latestHeartbeat = response.heartbeat as never;
    next.latestStatus = response.status;
  });
  return response;
}
