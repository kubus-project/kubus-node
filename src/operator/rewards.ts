import type { KubusApiClient } from '../backend/kubusApiClient.js';
import type { LocalStore } from '../state/localStore.js';

export async function refreshRewards(api: KubusApiClient, store: LocalStore) {
  const nodeId = store.snapshot().nodeId;
  const [rewards, computeRewards] = await Promise.all([
    api.getMyRewards({ limit: 50, offset: 0 }),
    nodeId ? api.getProviderComputeRewards(nodeId).catch(() => undefined) : Promise.resolve(undefined),
  ]);
  await store.update((state) => {
    state.rewards = rewards;
    if (computeRewards) state.computeRewards = computeRewards;
    state.latestRewardsRefreshAt = new Date().toISOString();
  });
  return { archive: rewards, compute: computeRewards };
}
