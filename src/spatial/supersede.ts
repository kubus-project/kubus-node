import { localError } from '../localApi/pairingService.js';
import { ManagedPins } from '../ipfs/managedPins.js';
import { removeFaceReviewImages } from './faceReview.js';
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
  /** Set by the publish route while it waits for the backend; see `publishInFlight`. */
  publishInFlightAt?: string;
}

/** A publish request older than this is a crashed one, not an in-flight one. */
const PUBLISH_IN_FLIGHT_MS = 10 * 60 * 1000;

function publishInFlight(record: StoredSpatial): boolean {
  const at = record.publishInFlightAt ? Date.parse(record.publishInFlightAt) : NaN;
  return Number.isFinite(at) && Date.now() - at < PUBLISH_IN_FLIGHT_MS;
}

const PUBLICATION_ACTIVE = { message: 'The record was offered to a backend for publication; withdraw that publication first, then supersede it' };

export interface SupersedeResult {
  id: string;
  state: 'superseded';
  supersededBy: string;
  released: Array<{ cid: string; pinRemoved: boolean; reason?: string }>;
  /**
   * Root blocks (manifest and variants) of this record that are still in the local block store. Unpinned is not
   * deleted: while any are present Kubo's gateway serves them, and so does bitswap once the Node has peers. Run
   * `kubus-node spatial purge-superseded` to remove exactly these blocks. Absent when the store could not be asked.
   */
  blocksStillStored?: number;
  /**
   * Things the operator should know about the replacement. `replacement_not_face_masked`: the replacing record does
   * not say that faces were masked (`processing.faceMasking.ran`), so retiring a record for its faces may have
   * replaced it with another that shows them. Superseding stays the operator's decision; this only says so.
   */
  warnings?: string[];
}

/** Does the manifest's derivation record that face masking ran? */
function maskedManifest(manifest: SpatialManifest): boolean {
  const derivation = (manifest as { captureProvenance?: { derivation?: { faceMasking?: { ran?: unknown } } } }).captureProvenance?.derivation;
  return derivation?.faceMasking?.ran === true;
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
 * block store until `purgeSupersededContent` (`kubus-node spatial purge-superseded`) removes exactly them, and
 * the result says how many are still there.
 *
 * `superseded` is terminal: nothing sets a superseded record back to another state (the publish route refuses it).
 *
 * Idempotent: repeating it retries any pin whose release did not finish.
 */
export async function supersedeSpatialRecord(
  deps: { store: LocalStore; /** Where the Node keeps its private files; when given, the record's face-review images are removed. */ dataRoot?: string; kubo: Pick<KuboClient, 'pinLs' | 'pinAdd' | 'pinRm'> & Partial<Pick<KuboClient, 'blockPresent'>> },
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
  // A record that was already offered to a backend cannot be retired from here: the publication would stay
  // live while this Node stops serving its content. Withdraw it there first.
  if (old.state === 'publication_requested' || publishInFlight(old)) {
    throw localError(409, 'spatial_publication_active', PUBLICATION_ACTIVE);
  }
  if (replacement.state !== 'local' && replacement.state !== 'publication_requested') {
    throw localError(422, 'spatial_replacement_unavailable', { message: 'The replacing record is itself superseded or unavailable' });
  }
  if (old.supersededBy && old.supersededBy !== newId) throw localError(409, 'spatial_already_superseded', { message: 'The record was already superseded by another record' });
  if (replacement.createdAt <= old.createdAt) throw localError(422, 'spatial_replacement_not_newer', { message: 'The replacing record is not newer' });

  await deps.store.update((state) => {
    const spatial = state.spatial as Record<string, StoredSpatial> | undefined;
    const current = spatial?.[oldId];
    if (!current) return;
    // The other checks are repeated on the state this update sees, not only on the snapshot read above: two
    // operator actions (a second supersede with another replacement, a supersede of the replacement) can overlap.
    if (current.supersededBy && current.supersededBy !== newId) throw localError(409, 'spatial_already_superseded', { message: 'The record was already superseded by another record' });
    const target = spatial?.[newId];
    if (!target?.manifest) throw localError(404, 'spatial_replacement_not_found', { message: 'No local spatial record has the replacing id' });
    if (target.state !== 'local' && target.state !== 'publication_requested') {
      throw localError(422, 'spatial_replacement_unavailable', { message: 'The replacing record is itself superseded or unavailable' });
    }
    // Checked again here, inside the update: the publish route claims the record in an update of its own, and a
    // request that began after the read above must not be retired under the backend's feet.
    if (current.state === 'publication_requested' || publishInFlight(current)) throw localError(409, 'spatial_publication_active', PUBLICATION_ACTIVE);
    current.state = 'superseded';
    current.supersededBy = newId;
    current.supersededAt ??= new Date().toISOString();
  });

  // The flagged-image copies of a retired record are not kept (and are never served: the route refuses a superseded record).
  if (deps.dataRoot) await removeFaceReviewImages(deps.dataRoot, oldId);
  const managed = new ManagedPins(deps.kubo, deps.store, { allowUnpin: true });
  const owner = old.pinOwner ?? `spatial:${oldId}`;
  const cids = [old.manifestCid, ...old.manifest.variants.map((variant) => variant.cid)];
  const released: SupersedeResult['released'] = [];
  for (const cid of [...new Set(cids)]) {
    const result = await managed.release(cid, owner);
    released.push({ cid, pinRemoved: result.pinRemoved, ...(result.reason ? { reason: result.reason } : {}) });
  }
  let blocksStillStored: number | undefined;
  if (deps.kubo.blockPresent) {
    try {
      blocksStillStored = 0;
      for (const cid of [...new Set(cids)]) if (await deps.kubo.blockPresent(cid)) blocksStillStored += 1;
    } catch {
      blocksStillStored = undefined;
    }
  }
  const warnings = maskedManifest(replacement.manifest) ? [] : ['replacement_not_face_masked'];
  return {
    id: oldId, state: 'superseded', supersededBy: newId, released,
    ...(blocksStillStored !== undefined ? { blocksStillStored } : {}),
    ...(warnings.length ? { warnings } : {}),
  };
}
