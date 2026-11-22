import type { Logger } from '../logging/logger.js';
import type { KuboClient } from '../ipfs/kuboClient.js';
import type { LocalStore } from '../state/localStore.js';

/**
 * Superseded content that is still in the local block store.
 *
 * Unpinning a record (`supersedeSpatialRecord`) does not delete anything: Kubo keeps the blocks until garbage
 * collection, and its gateway and, once the Node is connected to a swarm, bitswap serve an unpinned block that is
 * still there. So a superseded record whose images showed people stays retrievable until its blocks are gone.
 * This module finds those blocks and removes exactly them (never a pinned block, never anything outside a
 * superseded record), which is the deliberate step for content that must really disappear.
 */

interface SupersededRecord {
  id: string;
  state: string;
  manifestCid?: string;
  manifest?: { variants?: Array<{ cid?: string }> };
  contentPurgedAt?: string;
}

type Client = Pick<KuboClient, 'blockPresent' | 'refsLocal' | 'blockRm'>;

export interface SupersededContentReport {
  /** Superseded records with at least one root block still in the store. */
  records: Array<{ id: string; cids: string[] }>;
  /** Number of root blocks (manifest and variants) still present. */
  present: number;
}

function supersededRecords(store: LocalStore): SupersededRecord[] {
  return (Object.values(store.snapshot().spatial || {}) as SupersededRecord[]).filter((record) => record?.state === 'superseded');
}

function rootsOf(record: SupersededRecord): string[] {
  return [...new Set([record.manifestCid, ...(record.manifest?.variants ?? []).map((variant) => variant.cid)].filter((cid): cid is string => typeof cid === 'string' && cid.length > 0))];
}

/** Which superseded records still hold their content in the block store. Read only. */
export async function findSupersededContent(deps: { store: LocalStore; kubo: Pick<KuboClient, 'blockPresent'> }): Promise<SupersededContentReport> {
  const records: SupersededContentReport['records'] = [];
  let present = 0;
  for (const record of supersededRecords(deps.store)) {
    const cids: string[] = [];
    for (const cid of rootsOf(record)) {
      if (await deps.kubo.blockPresent(cid)) cids.push(cid);
    }
    if (cids.length) { records.push({ id: record.id, cids }); present += cids.length; }
  }
  return { records, present };
}

/** Logs a warning at start-up when superseded content is still stored; never throws. */
export async function warnAboutSupersededContent(deps: { store: LocalStore; kubo: Pick<KuboClient, 'blockPresent'>; logger: Pick<Logger, 'warn'> }): Promise<void> {
  try {
    const report = await findSupersededContent(deps);
    if (report.present > 0) {
      deps.logger.warn(
        { supersededRecords: report.records.length, rootBlocksPresent: report.present },
        'superseded spatial content is still in the block store and can be served by the Kubo gateway (and by peers once the Node is connected); run `kubus-node spatial purge-superseded` before enabling peering',
      );
    }
  } catch (error) {
    deps.logger.warn({ err: error instanceof Error ? error.message : String(error) }, 'could not check for superseded spatial content');
  }
}

export interface PurgeResult {
  records: Array<{ id: string; blocksRemoved: number; blocksKept: number; keptReason?: string }>;
  blocksRemoved: number;
  blocksKept: number;
}

const BATCH = 200;

/**
 * Removes the blocks of every superseded record from the block store: for each root (manifest and variants) the
 * blocks below it, children first and the root last, so an interrupted run never leaves a root whose children
 * can no longer be found. Kubo refuses a pinned block, so anything a current record or another pin still holds is
 * kept and reported. Repeating it is harmless.
 */
export async function purgeSupersededContent(deps: { store: LocalStore; kubo: Client }): Promise<PurgeResult> {
  const result: PurgeResult = { records: [], blocksRemoved: 0, blocksKept: 0 };
  for (const record of supersededRecords(deps.store)) {
    let removed = 0;
    let kept = 0;
    let keptReason: string | undefined;
    for (const root of rootsOf(record)) {
      if (!(await deps.kubo.blockPresent(root))) continue;
      const blocks = [...new Set(await deps.kubo.refsLocal(root))].reverse();
      for (let start = 0; start < blocks.length; start += BATCH) {
        for (const answer of await deps.kubo.blockRm(blocks.slice(start, start + BATCH))) {
          if (!answer.error) removed += 1;
          else if (/not found|does not exist|has no such/i.test(answer.error)) continue;
          else { kept += 1; keptReason ??= answer.error; }
        }
      }
    }
    if (kept === 0) {
      await deps.store.update((state) => {
        const current = (state.spatial as Record<string, SupersededRecord> | undefined)?.[record.id];
        if (current) current.contentPurgedAt = new Date().toISOString();
      });
    }
    result.records.push({ id: record.id, blocksRemoved: removed, blocksKept: kept, ...(keptReason ? { keptReason } : {}) });
    result.blocksRemoved += removed;
    result.blocksKept += kept;
  }
  return result;
}
