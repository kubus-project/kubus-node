import type { KubusApiClient } from '../backend/kubusApiClient.js';
import type { AvailabilityCommitment } from '../backend/models.js';
import type { AppConfig } from '../config/schema.js';
import type { KuboClient } from '../ipfs/kuboClient.js';
import { reconcilePins } from '../ipfs/pinning.js';
import { probeRetrieval } from '../ipfs/retrieval.js';
import type { LocalStore } from '../state/localStore.js';
import { addHoursIso } from '../utils/time.js';

export async function syncRewardableCids(api: KubusApiClient, store: LocalStore, config: AppConfig) {
  const response = await api.getRewardableCids({ limit: Math.min(config.maxPinnedCids, 500), offset: 0 });
  let records = response.records || [];
  if (config.cidClassFilters.length > 0) {
    records = records.filter((record) => config.cidClassFilters.includes(record.verificationClass || 'hot'));
  }
  const desired = records.slice(0, config.maxPinnedCids);
  await store.update((state) => {
    state.rewardableCids = response.records || [];
    state.desiredCids = desired;
  });
  return desired;
}

export async function reconcileDesiredPins(kubo: KuboClient, store: LocalStore, config: AppConfig) {
  const desired = store.snapshot().desiredCids;
  const results = await reconcilePins(kubo, desired, config.skipPinning);
  await store.update((state) => {
    state.pinnedCids = results.filter((result) => result.ok).map((result) => result.cid);
    state.failedCids = Object.fromEntries(
      results.filter((result) => !result.ok).map((result) => [result.cid, { error: result.error || 'pin_failed', at: new Date().toISOString() }]),
    );
  });
  return results;
}

export async function refreshCommitments(api: KubusApiClient, kubo: KuboClient, store: LocalStore, config: AppConfig) {
  const state = store.snapshot();
  if (!state.nodeId) throw new Error('Cannot create commitments before registration');
  const commitments: AvailabilityCommitment[] = [];
  for (const item of state.desiredCids) {
    if (!state.pinnedCids.includes(item.cid) && !config.skipPinning) continue;
    const probe = await probeRetrieval(kubo, config.ipfsGatewayUrl, item.cid);
    if (!['pinned', 'retrievable'].includes(probe.state) && !config.skipPinning) continue;
    const commitment = await api.createCommitment({
      nodeId: state.nodeId,
      rewardableCidId: item.id,
      expiresAt: addHoursIso(Number(state.policy?.commitmentTtlHours || 24)),
      metadata: {
        pinned: state.pinnedCids.includes(item.cid),
        retrievalCheckedAt: probe.checkedAt,
        localGatewayUrl: `${config.ipfsGatewayUrl.replace(/\/+$/, '')}/ipfs/${item.cid}`,
        verificationHints: {
          retrievalState: probe.state,
          rewardRole: item.rewardRole,
          verificationClass: item.verificationClass,
        },
      },
    });
    commitments.push(commitment);
  }
  await store.update((next) => {
    next.activeCommitments = commitments;
  });
  return commitments;
}
