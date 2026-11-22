import { localError } from '../localApi/pairingService.js';
import { ManagedPins } from '../ipfs/managedPins.js';
import type { KuboClient } from '../ipfs/kuboClient.js';
import type { LocalStore } from '../state/localStore.js';
import type { SpatialManifest } from './models.js';

interface StoredSpatial {
  id: string;
  state: string;
  manifestCid: string;
  manifest: SpatialManifest;
  createdAt: string;
  pinOwner?: string;
  supersededBy?: string;
  supersededAt?: string;
}

export interface SupersedeResult {
  id: string;
  state: 'superseded';
  supersededBy: string;
  released: Array<{ cid: string; pinRemoved: boolean; reason?: string }>;
}

/**
 * Marks a local spatial record as replaced by a newer one for the same artwork and releases the Node's own
 * pins on its content.
 *
 * Used when an earlier record must never be served again (for example it was reconstructed from images that
 * showed people's faces). The record stays in the state as history, with `state: 'superseded'`; its content
 * is no longer pinned and the local gateway refuses to serve it. This is an explicit operator command, so it
 * unpins even where automatic pin release is switched off, but it only ever removes pins this Node created
 * for that record (`ManagedPins` ownership) and it never runs garbage collection: blocks stay in the local
 * block store until the operator collects them.
 *
 * Idempotent: repeating it retries any pin whose release did not finish.
 */
export async function supersedeSpatialRecord(
  deps: { store: LocalStore; kubo: Pick<KuboClient, 'pinLs' | 'pinAdd' | 'pinRm'> },
  oldId: string,
  newId: string,
): Promise<SupersedeResult> {
  const records = (deps.store.snapshot().spatial || {}) as Record<string, StoredSpatial>;
  const old = records[oldId];
  const replacement = records[newId];
  if (!old?.manifest) throw localError(404, 'spatial_record_not_found', { message: 'No local spatial record has the id to supersede' });
  if (!replacement?.manifest) throw localError(404, 'spatial_replacement_not_found', { message: 'No local spatial record has the replacing id' });
  if (oldId === newId) throw localError(422, 'spatial_supersede_self', { message: 'A record cannot supersede itself' });
  if (old.manifest.artworkId !== replacement.manifest.artworkId) {
    throw localError(422, 'spatial_supersede_artwork_mismatch', { message: 'The replacing record belongs to a different artwork' });
  }
  if (replacement.state !== 'local') throw localError(422, 'spatial_replacement_unavailable', { message: 'The replacing record is itself superseded or unavailable' });
  if (old.supersededBy && old.supersededBy !== newId) throw localError(409, 'spatial_already_superseded', { message: 'The record was already superseded by another record' });
  if (replacement.createdAt <= old.createdAt) throw localError(422, 'spatial_replacement_not_newer', { message: 'The replacing record is not newer' });

  await deps.store.update((state) => {
    const current = (state.spatial as Record<string, StoredSpatial> | undefined)?.[oldId];
    if (!current) return;
    current.state = 'superseded';
    current.supersededBy = newId;
    current.supersededAt ??= new Date().toISOString();
  });

  const managed = new ManagedPins(deps.kubo, deps.store, { allowUnpin: true });
  const owner = old.pinOwner ?? `spatial:${oldId}`;
  const cids = [old.manifestCid, ...old.manifest.variants.map((variant) => variant.cid)];
  const released: SupersedeResult['released'] = [];
  for (const cid of [...new Set(cids)]) {
    const result = await managed.release(cid, owner);
    released.push({ cid, pinRemoved: result.pinRemoved, ...(result.reason ? { reason: result.reason } : {}) });
  }
  return { id: oldId, state: 'superseded', supersededBy: newId, released };
}
