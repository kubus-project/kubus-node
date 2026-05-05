import type { KubusApiClient } from '../backend/kubusApiClient.js';
import type { AvailabilityCommitment, PublicPinSetRecord, RewardableCid } from '../backend/models.js';
import type { AppConfig } from '../config/schema.js';
import type { KuboClient } from '../ipfs/kuboClient.js';
import { reconcilePins } from '../ipfs/pinning.js';
import { probeRetrieval } from '../ipfs/retrieval.js';
import type { LocalStore } from '../state/localStore.js';
import { addHoursIso } from '../utils/time.js';

function classFilterAllows(record: { verificationClass?: string | null }, filters: string[]): boolean {
  const verificationClass = record.verificationClass?.trim();
  return filters.length === 0 || !verificationClass || filters.includes(verificationClass);
}

function sameObjectVersion(left: { objectType?: string | null; objectId?: string | null; version?: number }, right: { objectType?: string | null; objectId?: string | null; version?: number }): boolean {
  return Boolean(
    left.objectType &&
      left.objectId &&
      left.version &&
      left.objectType === right.objectType &&
      left.objectId === right.objectId &&
      left.version === right.version,
  );
}

function bundleForRewardable(publicPinSet: PublicPinSetRecord[], rewardable: RewardableCid): PublicPinSetRecord[] {
  const bundle = publicPinSet.filter((record) => sameObjectVersion(record, rewardable));
  const leaf = publicPinSet.find((record) => record.rewardableCidId === rewardable.id || record.cid === rewardable.cid);
  return Array.from(new Map([...bundle, ...(leaf ? [leaf] : [])].map((record) => [record.cid, record])).values());
}

export async function syncPublicPinSet(api: KubusApiClient, store: LocalStore, config: AppConfig) {
  const limit = Math.min(config.maxPinnedCids, 1000);
  const [pinSetResponse, rewardableResponse] = await Promise.all([
    api.getPublicPinSet({ limit, offset: 0 }),
    api.getRewardableCids({ limit: 500, offset: 0 }),
  ]);
  const publicPinSet = pinSetResponse.records || [];
  const desired = publicPinSet
    .filter((record) => classFilterAllows(record, config.cidClassFilters))
    .slice(0, config.maxPinnedCids);
  const rewardable = (rewardableResponse.records || [])
    .filter((record) => classFilterAllows(record, config.cidClassFilters));
  await store.update((state) => {
    state.publicPinSet = publicPinSet;
    state.rewardableCids = rewardable;
    state.desiredCids = desired;
  });
  return desired;
}

export const syncRewardableCids = syncPublicPinSet;

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
  const desiredCidSet = new Set(state.desiredCids.map((record) => record.cid));
  for (const item of state.rewardableCids) {
    if (!desiredCidSet.has(item.cid)) continue;
    if (!state.pinnedCids.includes(item.cid) && !config.skipPinning) continue;
    const probe = await probeRetrieval(kubo, config.ipfsGatewayUrl, item.cid);
    if (!['pinned', 'retrievable'].includes(probe.state) && !config.skipPinning) continue;
    const bundle = bundleForRewardable(state.desiredCids, item);
    const pinnedBundleCids = bundle
      .filter((record) => state.pinnedCids.includes(record.cid) || config.skipPinning)
      .map((record) => record.cid);
    const manifest = bundle.find((record) => record.role === 'manifest');
    const record = bundle.find((entry) => entry.role === 'record');
    const leaf = bundle.find((entry) => entry.rewardableCidId === item.id || entry.cid === item.cid);
    const commitment = await api.createCommitment({
      nodeId: state.nodeId,
      rewardableCidId: item.id,
      expiresAt: addHoursIso(Number(state.policy?.commitmentTtlHours || 24)),
      metadata: {
        pinned: state.pinnedCids.includes(item.cid),
        retrievalCheckedAt: probe.checkedAt,
        localGatewayUrl: `${config.ipfsGatewayUrl.replace(/\/+$/, '')}/ipfs/${item.cid}`,
        pinnedBundleCids,
        manifestCidPinned: manifest ? pinnedBundleCids.includes(manifest.cid) : false,
        recordCidPinned: record ? pinnedBundleCids.includes(record.cid) : false,
        leafCidPinned: leaf ? pinnedBundleCids.includes(leaf.cid) : state.pinnedCids.includes(item.cid),
        objectType: item.objectType || null,
        objectId: item.objectId || null,
        version: item.version || null,
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
