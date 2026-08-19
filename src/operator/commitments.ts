import type { KubusApiClient } from '../backend/kubusApiClient.js';
import type { AvailabilityCommitment, PublicPinSetRecord, RewardableCid } from '../backend/models.js';
import type { AppConfig } from '../config/schema.js';
import type { KuboClient } from '../ipfs/kuboClient.js';
import { reconcilePins } from '../ipfs/pinning.js';
import { probeRetrieval, RETRIEVAL_AVAILABLE_STATES } from '../ipfs/retrieval.js';
import type { LocalStore } from '../state/localStore.js';
import { addHoursIso } from '../utils/time.js';

function classFilterAllows(record: { verificationClass?: string | null }, filters: string[]): boolean {
  const verificationClass = record.verificationClass?.trim();
  return filters.length === 0 || !verificationClass || filters.includes(verificationClass);
}

const CLASS_PRIORITY: Record<string, number> = { hot: 0, warm: 1, cold: 2 };
const ROLE_PRIORITY: Record<string, number> = { manifest: 0, record: 1, spatial_preview: 2, media: 3, leaf: 3, spatial_mobile: 4, spatial_archive: 5 };

export function planPublicPins(records: PublicPinSetRecord[], maxCids: number, maxBytes: number, filters: string[]): PublicPinSetRecord[] {
  const sorted = records.filter((record) => classFilterAllows(record, filters)).sort((left, right) => {
    const leftClass = left.storageClass || (['manifest', 'record'].includes(left.role) ? 'hot' : left.verificationClass) || 'warm';
    const rightClass = right.storageClass || (['manifest', 'record'].includes(right.role) ? 'hot' : right.verificationClass) || 'warm';
    return (CLASS_PRIORITY[leftClass] ?? 1) - (CLASS_PRIORITY[rightClass] ?? 1)
      || (ROLE_PRIORITY[left.role] ?? 10) - (ROLE_PRIORITY[right.role] ?? 10)
      || String(left.objectType || '').localeCompare(String(right.objectType || ''))
      || String(left.objectId || '').localeCompare(String(right.objectId || ''))
      || Number(left.version || 0) - Number(right.version || 0)
      || left.cid.localeCompare(right.cid);
  });
  const selected: PublicPinSetRecord[] = [];
  let plannedBytes = 0;
  for (const record of sorted) {
    if (selected.length >= maxCids) break;
    const size = Math.max(0, Number(record.sizeBytes || 0));
    if (size > 0 && plannedBytes + size > maxBytes) continue;
    selected.push(record);
    plannedBytes += size;
  }
  return selected;
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
  const pageSize = 1000;
  const [firstPinSetPage, rewardableResponse] = await Promise.all([
    api.getPublicPinSet({ limit: pageSize, offset: 0 }),
    api.getRewardableCids({ limit: 500, offset: 0 }),
  ]);
  // The server's completeness bit is authoritative. Fetch every page before
  // establishing the local desired plan, so a capacity-limited plan is never
  // confused with an incomplete canonical response.
  const allRecords = [...(firstPinSetPage.records || [])];
  const total = Number(firstPinSetPage.count || 0);
  for (let offset = allRecords.length; offset < total; offset += pageSize) {
    const page = await api.getPublicPinSet({ limit: pageSize, offset });
    if (page.complete !== true || Number(page.count) !== total) {
      throw new Error('The canonical public pin set changed during synchronization.');
    }
    allRecords.push(...(page.records || []));
  }
  const pinSetResponse = firstPinSetPage;
  const publicPinSet = allRecords;
  // A partial first page must never be treated as the canonical archive.  This
  // also makes an explicitly complete, genuinely empty archive distinguishable
  // from an unavailable or incomplete response.
  if (pinSetResponse.complete !== true || total !== publicPinSet.length) {
    throw new Error('The canonical public pin set is incomplete.');
  }
  const desired = planPublicPins(publicPinSet, config.maxPinnedCids, config.maxPinnedBytes, config.cidClassFilters);
  const rewardable = (rewardableResponse.records || [])
    .filter((record) => classFilterAllows(record, config.cidClassFilters));
  await store.update((state) => {
    state.publicPinSet = publicPinSet;
    state.rewardableCids = rewardable;
    state.desiredCids = desired;
    state.publicPinSetTotal = pinSetResponse.count;
    state.publicPinSetComplete = pinSetResponse.complete === true;
    state.rewardableCidTotal = rewardableResponse.count;
    state.latestPublicPinSetSyncAt = new Date().toISOString();
  });
  return desired;
}

export const syncRewardableCids = syncPublicPinSet;

export async function reconcileDesiredPins(kubo: KuboClient, store: LocalStore, config: AppConfig) {
  const desired = store.snapshot().desiredCids;
  const results = await reconcilePins(kubo, desired, config.skipPinning, config.apiBaseUrl);
  await store.update((state) => {
    state.pinnedCids = results.filter((result) => result.ok).map((result) => result.cid);
    state.failedCids = Object.fromEntries(
      results.filter((result) => !result.ok).map((result) => [result.cid, { error: result.error || 'pin_failed', at: new Date().toISOString() }]),
    );
    state.latestPinReconcileAt = new Date().toISOString();
  });
  return results;
}

export async function refreshCommitments(api: KubusApiClient, kubo: KuboClient, store: LocalStore, config: AppConfig) {
  const state = store.snapshot();
  if (!state.nodeId) throw new Error('Cannot create commitments before registration');
  const commitments: AvailabilityCommitment[] = [];
  const desiredCidSet = new Set(state.desiredCids.map((record) => record.cid));
  const skipReasons: Record<string, string> = {};
  for (const item of state.rewardableCids) {
    if (!desiredCidSet.has(item.cid)) {
      skipReasons[item.cid] = 'not_in_desired_public_pin_set';
      continue;
    }
    if (!state.pinnedCids.includes(item.cid) && !config.skipPinning) {
      skipReasons[item.cid] = 'rewardable_leaf_not_pinned';
      continue;
    }
    const probe = await probeRetrieval(kubo, config.ipfsGatewayUrl, item.cid);
    if (!RETRIEVAL_AVAILABLE_STATES.includes(probe.state) && !config.skipPinning) {
      skipReasons[item.cid] = `retrieval_${probe.state}`;
      continue;
    }
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
    next.commitmentSkipReasons = skipReasons;
    next.latestCommitmentRefreshAt = new Date().toISOString();
  });
  return commitments;
}
