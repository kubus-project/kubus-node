import type { KubusApiClient } from '../backend/kubusApiClient.js';
import type { LocalStore } from '../state/localStore.js';

export async function refreshRewards(api: KubusApiClient, store: LocalStore) {
  const rewards = await api.getMyRewards({ limit: 50, offset: 0 });
  await store.update((state) => {
    state.rewards = rewards;
  });
  return rewards;
}
