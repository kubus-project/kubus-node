import { promises as fs } from 'node:fs';
import type { FileHandle } from 'node:fs/promises';
import path from 'node:path';
import { localError } from '../localApi/pairingService.js';
import type { LocalStore } from '../state/localStore.js';

/**
 * The human look that face masking leaves behind, and the operator's way to do it.
 *
 * Masking is tuned for recall and cannot be proven complete: a large, close, hatted or sunglassed face can score
 * under the near-certain bar and is then only counted (`needsLook`). A record with such images carries a private
 * `faceReview` (never in the manifest, never handed to a paired client or the backend). The Node keeps a copy of
 * each flagged, already masked image under `private/face-review/<record id>/`, the GUI serves them to the
 * operator one by one, and only after every listed image has been served (and the operator confirmed) is the
 * review acknowledged. The publish route refuses until then. Nothing here reads the unmasked source: the copies
 * are the same masked pixels the reconstruction saw.
 */

export interface FaceReviewItem {
  part: 'photos' | 'video';
  /** 1-based number in the part's own order (`photos/00001.jpg` is 1; a video frame is its place among the selected frames). */
  image: number;
  /** Name of the stored copy under the record's review directory; also the key of `viewed`. */
  file: string;
  weakExcluded?: number;
  largeBelowCertain?: number;
  /** Where in the footage a video frame is. */
  seconds?: number;
}

export interface FaceReview {
  /** Images flagged (all of them, also those beyond the list). */
  pending: number;
  jobId: string;
  items: FaceReviewItem[];
  itemsTruncated?: boolean;
  /** Stored names (`FaceReviewItem.file`) the operator was shown. */
  viewed: string[];
  acknowledged?: { at: string; by: string };
}

const RECORD_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const STORED_NAME = /^(photos|video)-\d{5,6}\.(jpg|jpeg|png)$/;
const MAX_IMAGE_BYTES = 64 * 1024 * 1024;

/** The worker's name for a flagged image, relative to the job's output directory. Anything else is refused. */
export const WORKER_REVIEW_FILE = /^(?:dataset\/images\/(?:photo|video)_\d{5}\.jpg|selected_frames\/frame_\d{5}\.jpg)$/;

export function faceReviewDirectory(dataRoot: string, spatialId: string): string {
  if (!RECORD_ID.test(spatialId)) throw new Error('face_review_record_id_invalid');
  return path.join(dataRoot, 'private', 'face-review', spatialId);
}

export function storedReviewName(part: 'photos' | 'video', image: number, extension: string): string {
  return `${part}-${String(image).padStart(5, '0')}.${extension}`;
}

/** Resolves `relative` under `root` without following a link, to a regular file of bounded size. */
async function safeFile(root: string, relative: string): Promise<string> {
  const resolvedRoot = path.resolve(root);
  let current = resolvedRoot;
  const parts = relative.split('/');
  for (const [index, part] of parts.entries()) {
    if (!part || part === '.' || part === '..') throw new Error('face_review_source_invalid');
    current = path.join(current, part);
    const info = await fs.lstat(current);
    if (info.isSymbolicLink() || (index < parts.length - 1 ? !info.isDirectory() : !info.isFile())) throw new Error('face_review_source_invalid');
    if (index === parts.length - 1 && info.size > MAX_IMAGE_BYTES) throw new Error('face_review_source_too_large');
  }
  return current;
}

export interface ReviewSource {
  part: 'photos' | 'video';
  image: number;
  /** Path of the masked image: relative to `root`, with `/` separators. */
  relative: string;
  root: string;
  weakExcluded?: number;
  largeBelowCertain?: number;
  seconds?: number;
}

/**
 * Copies the flagged masked images into the record's review directory (mode 0600) and returns the review. Throws
 * when any image cannot be kept, so a record is never made whose review could not be done; the directory is
 * removed again in that case.
 */
export async function storeFaceReview(
  dataRoot: string,
  spatialId: string,
  jobId: string,
  pending: number,
  sources: ReviewSource[],
  itemsTruncated: boolean,
): Promise<FaceReview> {
  const directory = faceReviewDirectory(dataRoot, spatialId);
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const items: FaceReviewItem[] = [];
  try {
    for (const source of sources) {
      const from = await safeFile(source.root, source.relative);
      const extension = path.extname(from).slice(1).toLowerCase();
      if (!['jpg', 'jpeg', 'png'].includes(extension)) throw new Error('face_review_source_invalid');
      const file = storedReviewName(source.part, source.image, extension);
      await fs.copyFile(from, path.join(directory, file));
      await fs.chmod(path.join(directory, file), 0o600).catch(() => undefined);
      items.push({
        part: source.part, image: source.image, file,
        ...(source.weakExcluded ? { weakExcluded: source.weakExcluded } : {}),
        ...(source.largeBelowCertain ? { largeBelowCertain: source.largeBelowCertain } : {}),
        ...(typeof source.seconds === 'number' ? { seconds: source.seconds } : {}),
      });
    }
  } catch (error) {
    await removeFaceReviewImages(dataRoot, spatialId);
    throw Object.assign(new Error(`The flagged images could not be kept for review (${(error as Error).message})`), { code: 'face_review_images_unavailable' });
  }
  return { pending, jobId, items, ...(itemsTruncated ? { itemsTruncated: true } : {}), viewed: [] };
}

/** Best effort: the copies are private and only useful until the review is acknowledged or the record retired. */
export async function removeFaceReviewImages(dataRoot: string, spatialId: string): Promise<void> {
  try {
    await fs.rm(faceReviewDirectory(dataRoot, spatialId), { recursive: true, force: true });
  } catch {
    // nothing to remove, or not removable now; a later acknowledge or supersede retries
  }
}

/**
 * Start-up sweep: removes review copies that nothing needs. `keepFaceReview` copies the flagged images before the
 * record is written, so a process killed in between leaves a directory for an id no record has; a record that was
 * superseded or acknowledged needs none either. Only called before any job runs (a record being made right now
 * would look like an orphan). Returns the directory names it removed. Best effort: what cannot be removed now is
 * retried at the next start.
 */
export async function sweepOrphanFaceReviews(dataRoot: string, store: LocalStore): Promise<string[]> {
  const root = path.join(dataRoot, 'private', 'face-review');
  let names: string[];
  try {
    names = await fs.readdir(root);
  } catch {
    return [];
  }
  const removed: string[] = [];
  for (const name of names) {
    const record = RECORD_ID.test(name) ? (store.snapshot().spatial?.[name] as StoredWithReview | undefined) : undefined;
    const needed = Boolean(record && record.state !== 'superseded' && record.faceReview && !record.faceReview.acknowledged);
    if (needed) continue;
    try {
      // `rm` removes a link itself and never follows it.
      await fs.rm(path.join(root, name), { recursive: true, force: true });
      removed.push(name);
    } catch {
      // retried at the next start
    }
  }
  return removed;
}

/** `items` and `viewed` are optional on disk: a state file written before the review kept its images has neither. */
interface StoredWithReview { state?: string; faceReview?: FaceReview }

function recordOf(store: LocalStore, spatialId: string): StoredWithReview {
  const record = store.snapshot().spatial?.[spatialId] as StoredWithReview | undefined;
  if (!record) throw localError(404, 'spatial_not_found');
  return record;
}

/** What the GUI shows the operator: no paths, only stored names it can ask for. */
export interface FaceReviewView {
  pending: number;
  acknowledged?: { at: string; by: string };
  items: Array<FaceReviewItem & { viewed: boolean }>;
  itemsTruncated: boolean;
  /** Listed images not yet shown. */
  unseen: number;
}

export function faceReviewView(store: LocalStore, spatialId: string): FaceReviewView {
  const record = recordOf(store, spatialId);
  const review = record.faceReview;
  if (!review) throw localError(404, 'face_review_not_required', { message: 'This record has no face review' });
  const viewed = new Set(review.viewed ?? []);
  const items = (review.items ?? []).map((item) => ({ ...item, viewed: viewed.has(item.file) }));
  return {
    pending: review.pending,
    ...(review.acknowledged ? { acknowledged: review.acknowledged } : {}),
    items, itemsTruncated: Boolean(review.itemsTruncated),
    unseen: items.filter((item) => !item.viewed).length,
  };
}

/**
 * Opens one flagged image for the operator and records that it was shown. Only a name the review lists is served,
 * and only while the review is open (a superseded record's images are gone). The file is opened before the
 * record is updated, so an acknowledge or a supersede that removes the copy in between cannot turn the later read
 * into a stream error: the caller owns the returned handle and must close it (`serveFaceReviewImage` does, by
 * streaming it to the response).
 */
export async function openFaceReviewImage(dataRoot: string, store: LocalStore, spatialId: string, file: string): Promise<{ handle: FileHandle; mimeType: string; size: number }> {
  const record = recordOf(store, spatialId);
  const review = record.faceReview;
  if (!review || record.state === 'superseded') throw localError(404, 'face_review_not_found');
  if (!STORED_NAME.test(file) || !(review.items ?? []).some((item) => item.file === file)) throw localError(404, 'face_review_image_not_found');
  const target = path.join(faceReviewDirectory(dataRoot, spatialId), file);
  let handle: FileHandle;
  let size: number;
  try {
    const info = await fs.lstat(target);
    if (!info.isFile() || info.isSymbolicLink()) throw new Error('not a file');
    handle = await fs.open(target, 'r');
    try {
      const opened = await handle.stat();
      // `dev` is not compared: `lstat` reports 0 for it on Windows while a handle reports the volume serial.
      if (!opened.isFile() || opened.ino !== info.ino) throw new Error('not the checked file');
      size = opened.size;
    } catch (error) {
      await handle.close().catch(() => undefined);
      throw error;
    }
  } catch {
    throw localError(404, 'face_review_image_missing', { message: 'The stored copy of this image is gone; supersede the record and process the capture again' });
  }
  try {
    await store.update((state) => {
      const current = (state.spatial?.[spatialId] as StoredWithReview | undefined)?.faceReview;
      if (!current) return;
      const viewed = current.viewed ?? (current.viewed = []);
      if (!viewed.includes(file)) viewed.push(file);
    });
  } catch (error) {
    await handle.close().catch(() => undefined);
    throw error;
  }
  return { handle, mimeType: file.endsWith('.png') ? 'image/png' : 'image/jpeg', size };
}

/**
 * Records that the operator looked at every listed image. Refused while a listed image was not shown, so the
 * acknowledgement is a statement the Node can check, not a bare flag. A list that was cut (`itemsTruncated`) needs
 * the operator to say that the rest was looked at some other way (`allowTruncated`).
 */
export async function acknowledgeFaceReview(
  dataRoot: string,
  store: LocalStore,
  spatialId: string,
  by: string,
  options: { allowTruncated?: boolean } = {},
): Promise<FaceReviewView> {
  const record = recordOf(store, spatialId);
  const review = record.faceReview;
  if (!review) throw localError(404, 'face_review_not_required', { message: 'This record has no face review' });
  if (record.state === 'superseded') throw localError(409, 'spatial_not_publishable', { message: 'A superseded record cannot be reviewed' });
  if (review.acknowledged) return faceReviewView(store, spatialId);
  // A review written before the images were kept (`{ pending, jobId }` only) has nothing to show: it is never
  // acknowledgeable, the record has to be superseded and processed again.
  if (!Array.isArray(review.items)) {
    throw localError(409, 'face_review_images_unavailable', { message: 'The flagged images of this record were not kept; supersede the record and process the capture again' });
  }
  const viewed = new Set(review.viewed ?? []);
  const unseen = (review.items ?? []).filter((item) => !viewed.has(item.file)).length;
  if (unseen > 0) throw localError(409, 'face_review_images_unseen', { message: `${unseen} flagged image(s) have not been shown yet`, unseen });
  if (review.itemsTruncated && options.allowTruncated !== true) {
    throw localError(409, 'face_review_list_truncated', { message: `${review.pending} images are flagged but only ${(review.items ?? []).length} are listed; confirm that the rest was looked at (allowTruncated)` });
  }
  await store.update((state) => {
    const current = (state.spatial?.[spatialId] as StoredWithReview | undefined)?.faceReview;
    if (current && !current.acknowledged) current.acknowledged = { at: new Date().toISOString(), by };
  });
  // The review is done: the copies are not kept longer than needed.
  await removeFaceReviewImages(dataRoot, spatialId);
  return faceReviewView(store, spatialId);
}

/** A record as a paired client or the backend may see it: the Node's private review state is left out. */
export function withoutFaceReview<T extends object>(record: T): T {
  if (!('faceReview' in record)) return record;
  const { faceReview: _private, ...rest } = record as T & { faceReview?: unknown };
  return rest as T;
}
