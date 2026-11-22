import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';

/**
 * Face masking of a capture's images, decided at import and carried in the record.
 *
 * People who happen to stand in front of a mural must not end up in a splat.
 * Masking runs in the spatial worker (the only place with a face detector, see
 * `spatial-worker/face_mask.py`), either
 *
 * - `premasked`: the operator masked the photos before import with
 *   `python face_mask.py mask <in> <out>`, which writes masked copies and a
 *   `kubus-face-masking.json` report next to them. The report names every
 *   masked file by SHA-256, so it cannot be attached to different images. The
 *   unmasked originals never enter the capture store.
 * - `worker`: the worker masks every photo and every video frame as the first
 *   step of the job, before COLMAP and training. The unmasked source files stay
 *   in the (private) capture store; only masked pixels reach the trainer.
 * - `none`: no masking (a private capture, or an explicit `--no-mask-faces`),
 *   recorded as such.
 *
 * Default: a capture bound to an artwork (public art) is masked unless the
 * operator opts out; a capture without an artwork is not. The decision is
 * stored on the capture so reprocessing it cannot silently differ.
 */

export type PhotoMasking = 'premasked' | 'worker' | 'none';
export type VideoMasking = 'worker' | 'none';

export const FACE_MASKING_REPORT_NAME = 'kubus-face-masking.json';
export const FACE_MASKING_REPORT_SCHEMA = 'kubus.face-masking/1';
/** SHA-256 of the pinned YuNet weights (`spatial-worker/face_mask.py` `MODEL_SHA256`). */
export const PINNED_WEIGHTS_SHA256 = '8f2383e4dd3cfbb4553ea8718107fc0423210dc964f9f4280604804ed2552fa4';
const REPORT_MAX_BYTES = 256 * 1024;
const MAX_REGIONS_PER_IMAGE = 2000;

export interface FaceMaskingSummary {
  detector: string;
  model: string;
  weightsSha256: string;
  /** Does the report name the pinned weights? A report is the operator's statement; the Node cannot re-run it. */
  weightsPinned: boolean;
  /** Always `operator_report`: the Node binds the report to the files by checksum but did not mask them. */
  attestation: 'operator_report';
  scoreThreshold?: number;
  licence?: string;
  opencv?: string;
  images: number;
  regions: number;
  imagesWithRegions: number;
  /** Regions per image in the capture's own photo order (`photos/00001.jpg` first). */
  regionsPerImage: number[];
  manualAdded: number;
  manualExcluded: number;
  /**
   * What the masking run left for a human to look at, summed from the report's per-image `needsLook` (a weaker
   * detection swallowed by an exclude box that the reviewer did not acknowledge with `expectWeak`, a large
   * detection that was not masked). `images` is how many images carry one. Zero means the report flagged nothing.
   */
  needsLook: { images: number; weakExcluded: number; largeBelowCertain: number };
}

export interface CaptureFaceMasking {
  photos?: PhotoMasking;
  video?: VideoMasking;
  /** Present for `premasked` photos: what the operator's report says, bound to the imported files by SHA-256. */
  report?: FaceMaskingSummary;
}

export class FaceMaskingReportError extends Error {
  constructor(readonly code: 'face_masking_report_invalid' | 'face_masking_report_mismatch' | 'face_masking_report_unpinned', message: string) {
    super(message);
    this.name = 'FaceMaskingReportError';
  }
}

export interface MaskingChoice {
  /** `--mask-faces` (true) or `--no-mask-faces` (false); absent means the default for the capture. */
  maskFaces?: boolean;
  artworkId?: string;
}

/** What the default is for a capture, and whether the caller changed it. */
export function resolveMasking(choice: MaskingChoice): boolean {
  if (choice.maskFaces !== undefined) return choice.maskFaces;
  return Boolean(choice.artworkId);
}

/** The masking a stored capture needs when its record predates the feature: the default for its artwork. */
export function effectiveMasking(capture: { artworkId?: string; kind?: string; faceMasking?: CaptureFaceMasking }): CaptureFaceMasking {
  if (capture.faceMasking) return capture.faceMasking;
  const wanted = resolveMasking({ artworkId: capture.artworkId });
  return wanted ? { photos: 'worker', video: 'worker' } : { photos: 'none', video: 'none' };
}

function sha256(buffer: Buffer): string {
  return createHash('sha256').update(buffer).digest('hex');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Reads `<directory>/kubus-face-masking.json` when it exists and checks it against
 * the photos about to be imported (`photoHashes`: SHA-256 of each file). Returns
 * undefined when there is no report; throws when there is one that does not fit or that names other than the pinned weights.
 */
export async function readPremaskedReport(directory: string, photoHashes: string[]): Promise<FaceMaskingSummary | undefined> {
  const file = path.join(directory, FACE_MASKING_REPORT_NAME);
  let raw: Buffer;
  try {
    const stat = await fs.lstat(file);
    if (!stat.isFile()) throw new FaceMaskingReportError('face_masking_report_invalid', 'The face-masking report is not a regular file');
    if (stat.size > REPORT_MAX_BYTES) throw new FaceMaskingReportError('face_masking_report_invalid', 'The face-masking report is too large');
    raw = await fs.readFile(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
  let report: unknown;
  try { report = JSON.parse(raw.toString('utf8')); } catch { throw new FaceMaskingReportError('face_masking_report_invalid', 'The face-masking report is not valid JSON'); }
  const summary = summariseReport(report, photoHashes);
  // A report is the operator's statement; one that names any other detector weights than the pinned ones describes
  // a run this Node cannot vouch for at all, so it is refused rather than recorded as masked.
  if (!summary.weightsPinned) {
    throw new FaceMaskingReportError('face_masking_report_unpinned', 'The face-masking report names detector weights other than the pinned ones; mask the photos again with face_mask.py from the worker image, or import without a report and let the worker mask them');
  }
  return summary;
}

export function summariseReport(report: unknown, photoHashes: string[]): FaceMaskingSummary {
  if (!isRecord(report) || report.schema !== FACE_MASKING_REPORT_SCHEMA) throw new FaceMaskingReportError('face_masking_report_invalid', 'The face-masking report has an unknown schema');
  const detector = report.detector;
  if (!isRecord(detector) || typeof detector.name !== 'string' || typeof detector.model !== 'string' || typeof detector.weightsSha256 !== 'string' || !/^[0-9a-f]{64}$/.test(detector.weightsSha256)) {
    throw new FaceMaskingReportError('face_masking_report_invalid', 'The face-masking report names no detector with a pinned weights checksum');
  }
  if (!Array.isArray(report.images)) throw new FaceMaskingReportError('face_masking_report_invalid', 'The face-masking report lists no images');
  // Each imported file must be one the report lists, once per occurrence (identical files may repeat).
  type Entry = { regions: number; manualAdded: number; manualExcluded: number; weakExcluded: number; largeBelowCertain: number };
  const pool = new Map<string, Entry[]>();
  for (const item of report.images) {
    if (!isRecord(item) || typeof item.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(item.sha256)) {
      throw new FaceMaskingReportError('face_masking_report_invalid', 'A face-masking report entry has no SHA-256');
    }
    const regions = item.regions;
    if (typeof regions !== 'number' || !Number.isInteger(regions) || regions < 0 || regions > MAX_REGIONS_PER_IMAGE) {
      throw new FaceMaskingReportError('face_masking_report_invalid', 'A face-masking report entry has an invalid region count');
    }
    const count = (value: unknown) => (typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= MAX_REGIONS_PER_IMAGE ? value : 0);
    const list = pool.get(item.sha256) ?? [];
    const look = isRecord(item.needsLook) ? item.needsLook : {};
    list.push({ regions, manualAdded: count(item.manualAdded), manualExcluded: count(item.manualExcluded), weakExcluded: count(look.weakExcluded), largeBelowCertain: count(look.largeBelowCertain) });
    pool.set(item.sha256, list);
  }
  if (report.images.length !== photoHashes.length) {
    throw new FaceMaskingReportError('face_masking_report_mismatch', `The face-masking report covers ${report.images.length} images; the directory holds ${photoHashes.length} photos`);
  }
  const regionsPerImage: number[] = [];
  let manualAdded = 0;
  let manualExcluded = 0;
  const needsLook = { images: 0, weakExcluded: 0, largeBelowCertain: 0 };
  for (const hash of photoHashes) {
    const entry = pool.get(hash)?.shift();
    if (!entry) throw new FaceMaskingReportError('face_masking_report_mismatch', 'A photo is not covered by the face-masking report (it was changed after masking, or never masked)');
    regionsPerImage.push(entry.regions);
    manualAdded += entry.manualAdded;
    manualExcluded += entry.manualExcluded;
    needsLook.weakExcluded += entry.weakExcluded;
    needsLook.largeBelowCertain += entry.largeBelowCertain;
    if (entry.weakExcluded || entry.largeBelowCertain) needsLook.images += 1;
  }
  const clip = (value: unknown, limit = 120) => (typeof value === 'string' ? value.slice(0, limit) : undefined);
  const threshold = typeof detector.scoreThreshold === 'number' && Number.isFinite(detector.scoreThreshold) ? detector.scoreThreshold : undefined;
  return {
    detector: clip(detector.name)!,
    model: clip(detector.model)!,
    weightsSha256: detector.weightsSha256,
    weightsPinned: detector.weightsSha256 === PINNED_WEIGHTS_SHA256,
    attestation: 'operator_report',
    ...(threshold !== undefined ? { scoreThreshold: threshold } : {}),
    ...(clip(detector.licence, 40) ? { licence: clip(detector.licence, 40)! } : {}),
    ...(clip(detector.opencv, 40) ? { opencv: clip(detector.opencv, 40)! } : {}),
    images: regionsPerImage.length,
    regions: regionsPerImage.reduce((sum, value) => sum + value, 0),
    imagesWithRegions: regionsPerImage.filter((value) => value > 0).length,
    regionsPerImage,
    manualAdded,
    manualExcluded,
    needsLook,
  };
}

export async function sha256OfFile(file: string): Promise<string> {
  return sha256(await fs.readFile(file));
}

/** Compact, public-safe summary for `processing.faceMasking` (no per-image counts). */
export function publicMaskingSummary(masking: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  if (!masking || masking.ran !== true) {
    if (!masking) return undefined;
    return { ran: false, ...(typeof masking.reason === 'string' ? { reason: masking.reason.slice(0, 60) } : {}) };
  }
  const pick = (part: unknown) => {
    if (!isRecord(part)) return undefined;
    const out: Record<string, unknown> = {};
    for (const key of ['source', 'attestation', 'detector', 'model', 'weightsSha256', 'weightsPinned', 'scoreThreshold', 'images', 'regions', 'imagesWithRegions']) {
      if (part[key] !== undefined) out[key] = part[key];
    }
    return out;
  };
  const out: Record<string, unknown> = { ran: true };
  const photos = pick(masking.photos);
  const video = pick(masking.video);
  if (photos) out.photos = photos;
  if (video) out.video = video;
  return out;
}
