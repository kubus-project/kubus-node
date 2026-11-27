import crypto from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { AnalyticsStore } from '../analytics/analyticsStore.js';
import type { CaptureStore } from '../captures/captureStore.js';
import { NEEDS_LOOK_LIST_LIMIT, PINNED_WEIGHTS_SHA256, effectiveMasking, publicMaskingSummary, unmaskedForJobArtwork, type NeedsLook, type NeedsLookItem } from '../captures/faceMasking.js';
import type { KuboClient } from '../ipfs/kuboClient.js';
import { localError } from '../localApi/pairingService.js';
import type { Logger } from '../logging/logger.js';
import { WORKER_REVIEW_FILE, removeFaceReviewImages, storeFaceReview, sweepOrphanFaceReviews, type FaceReview, type ReviewSource } from '../spatial/faceReview.js';
import { buildNerfstudioDataset } from '../spatial/nerfstudioAdapter.js';
import { longWorkerFetch, workerFailure } from '../spatial/workerClient.js';
import { validateSpatialManifest, type SpatialManifest, type SpatialRevision, type SpatialVariant } from '../spatial/models.js';
import type { LocalStore } from '../state/localStore.js';
import type { NetworkParticipationGate } from '../participation/networkParticipationGate.js';
import type { WorkerAuthService } from '../spatial/workerAuth.js';
import { resolveWorkerOutputFile } from './workerOutput.js';
import { JobCleanup } from './jobCleanup.js';
import { ManagedPins } from '../ipfs/managedPins.js';
import type { CapabilityRegistry } from '../capabilities/registry.js';
import { PRIVATE_OUTPUT_PROTOCOL, assertSpatialOutputRoles, sealOutputBlob, validatePrivateOutput, type PrivateOutputBlob } from '../compute/privateOutputTransport.js';

export type JobType = 'spatial.reconstruct' | 'spatial.optimize' | 'spatial.generate_preview';
export type JobState = 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';
/**
 * Truthful processing stages. `progress` stays a fixed, honest checkpoint for
 * bounded steps; it is `null` during `training`, the one stage whose real
 * duration and completion fraction this worker version does not report -
 * showing a fabricated percentage there would be worse than an indeterminate
 * spinner labelled with the real stage name. `extracting_frames` and
 * `solving_poses` are the two video-intake stages the worker reports through
 * its progress file; they are indeterminate for the same reason.
 */
export type JobStage =
  | 'queued'
  | 'preparing_dataset'
  | 'preparing_photos'
  | 'extracting_frames'
  | 'solving_poses'
  | 'starting_worker'
  | 'training'
  | 'importing'
  | 'completed'
  | 'failed'
  | 'cancelled';
export interface LocalJob {
  id: string;
  type: JobType;
  capability: string;
  state: JobState;
  stage: JobStage;
  progress: number | null;
  input: Record<string, unknown>;
  output?: Record<string, unknown>;
  /**
   * The full face-masking record of the run (per-image region counts, manual list counts). Private: it stays in
   * the Node's own job record and is not part of the manifest, which can be pinned and published.
   */
  maskingDetail?: Record<string, unknown>;
  error?: { code: string; message: string };
  createdAt: string;
  updatedAt: string;
  startedAt?: string;
  completedAt?: string;
  logs: Array<{ at: string; level: 'info' | 'warn' | 'error'; message: string }>;
}

interface WorkerOutput {
  variants: Array<{ role: SpatialVariant['role']; path: string; mimeType: string; format: string; storageClass: SpatialVariant['storageClass'] }>;
  transform?: SpatialManifest['transform'];
  viewerDefaults?: Record<string, unknown>;
  processing: SpatialManifest['processing'];
  /** What the worker derived the scene from (video intake): frame selection, SfM counts, splat count. */
  provenance?: unknown;
}

/** Worker-reported stages that map onto a job stage. `exporting` is a training-time step with no stage of its own. */
const WORKER_STAGES: Record<string, { stage: JobStage; message: string } | undefined> = {
  preparing_photos: { stage: 'preparing_photos', message: 'Preparing photos (orientation, size)' },
  extracting_frames: { stage: 'extracting_frames', message: 'Extracting and filtering frames from the video' },
  solving_poses: { stage: 'solving_poses', message: 'Solving camera poses (COLMAP)' },
  training: { stage: 'training', message: 'Training (this can take a while; progress is not reported mid-run by this worker version)' },
  masking_faces: { stage: 'preparing_photos', message: 'Masking faces before reconstruction' },
};
const PROGRESS_POLL_MS = 2000;
/** Backoff for retrying blocked job cleanup while the Node stays up (a restarting worker answers within about a minute). */
const CLEANUP_RETRY_DELAYS_MS = [5_000, 15_000, 45_000, 120_000, 300_000, 600_000];
/** How long a job request waits for an inline cleanup retry before it is refused with worker_cleanup_pending. */
const CREATE_CLEANUP_WAIT_MS = 3_000;
const PROVENANCE_MAX_BYTES = 8 * 1024;
const MASKING_PART_KEYS = ['source', 'attestation', 'detector', 'model', 'weightsSha256', 'weightsPinned', 'scoreThreshold', 'licence', 'opencv', 'images', 'photoImages', 'regions', 'imagesWithRegions', 'manualAdded', 'manualExcluded'] as const;

/** One part (photos or video) of a face-masking record: known keys, bounded primitives and one array of counts. */
function cleanMaskingPart(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const input = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const key of MASKING_PART_KEYS) {
    const item = input[key];
    if (typeof item === 'string') out[key] = item.slice(0, 120);
    else if (typeof item === 'number' && Number.isFinite(item)) out[key] = item;
    else if (typeof item === 'boolean') out[key] = item;
  }
  const counts = input.regionsPerImage;
  if (Array.isArray(counts) && counts.length <= 512 && counts.every((entry) => Number.isInteger(entry) && entry >= 0 && entry <= 2000)) out.regionsPerImage = counts;
  // What a human still has to look at (see `FaceMaskingSummary.needsLook`): counts only.
  const look = input.needsLook;
  if (look && typeof look === 'object' && !Array.isArray(look)) {
    const count = (value: unknown) => (typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 100000 ? value : 0);
    const raw = look as Record<string, unknown>;
    const needs: NeedsLook = { images: count(raw.images), weakExcluded: count(raw.weakExcluded), largeBelowCertain: count(raw.largeBelowCertain) };
    // Which images: bounded numbers only. Kept in the private job record so the operator can find them.
    if (Array.isArray(raw.items)) {
      const items: NeedsLookItem[] = [];
      for (const entry of raw.items.slice(0, NEEDS_LOOK_LIST_LIMIT)) {
        if (!entry || typeof entry !== 'object') continue;
        const item = entry as Record<string, unknown>;
        if (typeof item.image !== 'number' || !Number.isInteger(item.image) || item.image < 1 || item.image > 100000) continue;
        const weak = count(item.weakExcluded);
        const large = count(item.largeBelowCertain);
        // Where the masked copy is (the worker's name, under the job's output directory) and where in the footage a frame is.
        const file = typeof item.file === 'string' && WORKER_REVIEW_FILE.test(item.file) ? item.file : undefined;
        const seconds = typeof item.seconds === 'number' && Number.isFinite(item.seconds) && item.seconds >= 0 && item.seconds <= 360000 ? item.seconds : undefined;
        items.push({ image: item.image, ...(weak ? { weakExcluded: weak } : {}), ...(large ? { largeBelowCertain: large } : {}), ...(file ? { file } : {}), ...(seconds !== undefined ? { seconds } : {}) });
      }
      needs.items = items;
      if (raw.itemsTruncated === true || raw.items.length > NEEDS_LOOK_LIST_LIMIT) needs.itemsTruncated = true;
    }
    out.needsLook = needs;
  }
  return Object.keys(out).length ? out : undefined;
}

/** What a face-masking record leaves for a human to look at, over its parts: images, and the two kinds of detection (all 0 when nothing is flagged). */
export function maskingNeedsLookCounts(masking: unknown): { images: number; weakExcluded: number; largeBelowCertain: number } {
  const total = { images: 0, weakExcluded: 0, largeBelowCertain: 0 };
  if (!masking || typeof masking !== 'object') return total;
  for (const part of ['photos', 'video'] as const) {
    const look = ((masking as Record<string, unknown>)[part] as { needsLook?: Partial<Record<keyof typeof total, unknown>> } | undefined)?.needsLook;
    if (!look) continue;
    for (const key of Object.keys(total) as Array<keyof typeof total>) if (typeof look[key] === 'number') total[key] += look[key] as number;
  }
  return total;
}

/** How many images of a face-masking record a human still has to look at, over its parts (0 when nothing is flagged). */
export function maskingNeedsLook(masking: unknown): number {
  return maskingNeedsLookCounts(masking).images;
}

/**
 * The face-masking record of a new spatial record: what the worker reported for the parts it masked, plus the
 * operator's report for photos that were masked before import. `undefined` for a capture masking does not apply to.
 */
export function faceMaskingProvenance(capture: { kind?: string; faceMasking?: unknown; artworkId?: string }, worker: unknown): Record<string, unknown> | undefined {
  const kind = capture.kind ?? 'frames';
  // A posed-frame package (an app capture) is not masked by this step: its frames never pass through the worker's
  // intake. Say so in the record instead of leaving the question open.
  if (kind === 'frames') return { ran: false, reason: 'posed_frames_not_masked' };
  if (kind === 'prepared') {
    // Masked by the managed requester's worker before the dataset left it; the provider only carries its summary.
    const record = (worker && typeof worker === 'object' ? (worker as Record<string, unknown>).preparedBy : undefined) as Record<string, unknown> | undefined;
    const parts = (record?.faceMasking && typeof record.faceMasking === 'object' ? record.faceMasking : {}) as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const part of ['photos', 'video'] as const) {
      if (parts[part]) out[part] = cleanMaskingPart({ ...(parts[part] as object), source: 'worker', attestation: 'requester_worker', weightsPinned: pinned(parts[part]) });
    }
    return Object.keys(out).length ? { ran: true, ...out } : { ran: false, reason: 'prepared_without_masking' };
  }
  const masking = effectiveMasking(capture as Parameters<typeof effectiveMasking>[0]);
  const reported = (worker && typeof worker === 'object' ? (worker as Record<string, unknown>).faceMasking : undefined) as Record<string, unknown> | undefined;
  const out: Record<string, unknown> = {};
  if (kind !== 'video') {
    if (masking.photos === 'premasked' && masking.report) out.photos = cleanMaskingPart({ source: 'premasked', ...masking.report });
    else if (masking.photos === 'worker') out.photos = cleanMaskingPart({ ...(reported?.photos as object | undefined), source: 'worker', weightsPinned: pinned(reported?.photos) });
  }
  if (kind === 'video' || kind === 'mixed') {
    if (masking.video === 'worker') out.video = cleanMaskingPart({ ...(reported?.video as object | undefined), source: 'worker', weightsPinned: pinned(reported?.video) });
  }
  const ran = Boolean(out.photos || out.video);
  // `--no-mask-faces` is the operator's explicit choice; say so, so "not masked" is not read as "not applicable".
  return ran ? { ran: true, ...out } : { ran: false, ...(masking.optedOut ? { reason: 'operator_opted_out' } : {}) };
}

/**
 * The derivation as it may appear in a manifest, which is pinned and can be published: the face-masking record
 * keeps only what says that masking ran and with what (see `publicMaskingSummary`). Per-image region counts and the
 * manual add/exclude counts stay in the capture record in the Node's private state.
 */
export function publicDerivation(derivation: Record<string, unknown>): Record<string, unknown> {
  const masking = derivation.faceMasking as Record<string, unknown> | undefined;
  const out: Record<string, unknown> = masking ? { ...derivation, faceMasking: publicMaskingSummary(masking) } : { ...derivation };
  // The operator's device models and how many photos each took are private (they identify the photographer's kit).
  const photos = out.photos;
  if (photos && typeof photos === 'object' && !Array.isArray(photos) && 'cameras' in photos) {
    const { cameras: _private, ...rest } = photos as Record<string, unknown>;
    out.photos = rest;
  }
  return out;
}

/** Does the worker's report of one part name the pinned detector weights? */
function pinned(part: unknown): boolean {
  return Boolean(part) && typeof part === 'object' && (part as Record<string, unknown>).weightsSha256 === PINNED_WEIGHTS_SHA256;
}

/**
 * Parts the worker was asked to mask that its answer does not show as masked (or masked with other than the pinned
 * weights, or fewer images than it prepared); empty when everything ran. The count it masked is compared with the
 * count it reports having prepared (`photos.usable`, `frames.selected`) so a part masked in part does not pass.
 */
export function missingMasking(requested: { photos?: boolean; video?: boolean } | undefined, worker: unknown): string[] {
  if (!requested) return [];
  const record = (worker && typeof worker === 'object' ? worker : {}) as Record<string, unknown>;
  const reported = record.faceMasking as Record<string, unknown> | undefined;
  const prepared: Record<'photos' | 'video', unknown> = {
    photos: (record.photos as Record<string, unknown> | undefined)?.usable,
    video: (record.frames as Record<string, unknown> | undefined)?.selected,
  };
  const missing: string[] = [];
  for (const part of ['photos', 'video'] as const) {
    if (!requested[part]) continue;
    const summary = reported?.[part] as Record<string, unknown> | undefined;
    if (!summary || summary.ran !== true || typeof summary.images !== 'number' || summary.images < 1 || summary.weightsSha256 !== PINNED_WEIGHTS_SHA256 || summary.images !== prepared[part]) missing.push(part);
  }
  return missing;
}

/** Lower case with accents folded: a name with and without its diacritics compares equal. */
function foldName(value: string): string {
  return value.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
}

/**
 * Does a free-text note carry the capture operator's name? The note is published with the manifest, and the
 * operator's name belongs in `capturedBy` and nowhere else. Compares the whole label and each word of it that is
 * long enough to be a name (4 letters or more) as a whole word, accents and case ignored.
 */
export function noteNamesOperator(note: string, capturedBy: string | undefined): boolean {
  if (!capturedBy) return false;
  const haystack = foldName(note);
  const label = foldName(capturedBy).trim();
  if (label && haystack.includes(label)) return true;
  const wordsOf = (text: string) => text.split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  const noteWords = new Set(wordsOf(haystack));
  return wordsOf(label).some((word) => word.length >= 4 && noteWords.has(word));
}

/** Keeps worker-reported provenance to bounded JSON primitives under known keys. */
function sanitizeProvenance(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const clean = (input: unknown, depth: number): unknown => {
    if (typeof input === 'string') return input.slice(0, 200);
    if (typeof input === 'number') return Number.isFinite(input) ? input : null;
    if (typeof input === 'boolean' || input === null) return input;
    if (depth > 3) return undefined;
    if (Array.isArray(input)) return undefined;
    if (typeof input === 'object') {
      const out: Record<string, unknown> = {};
      for (const [key, item] of Object.entries(input as Record<string, unknown>).slice(0, 32)) {
        const cleaned = clean(item, depth + 1);
        if (cleaned !== undefined) out[key.slice(0, 64)] = cleaned;
      }
      return out;
    }
    return undefined;
  };
  const picked: Record<string, unknown> = {};
  for (const key of ['kind', 'video', 'photos', 'frames', 'sfm', 'splatCount', 'orientation', 'crop', 'timings']) {
    const cleaned = clean((value as Record<string, unknown>)[key], 0);
    if (cleaned !== undefined) picked[key] = cleaned;
  }
  return Buffer.byteLength(JSON.stringify(picked)) <= PROVENANCE_MAX_BYTES ? picked : undefined;
}

const capabilityFor = (type: JobType) => type === 'spatial.reconstruct' ? 'spatial.reconstruction' : 'spatial.optimization';

/** Wall-clock duration from real start/end timestamps, or undefined if the job never actually started running. */
function durationOf(job: LocalJob): number | undefined {
  if (!job.startedAt || !job.completedAt) return undefined;
  return Date.parse(job.completedAt) - Date.parse(job.startedAt);
}

export class JobRuntime {
  private running = new Map<string, AbortController>();
  private dispatching = false;
  private readonly cleanup: JobCleanup;
  private cleanupRetryTimer: ReturnType<typeof setTimeout> | undefined;
  private cleanupRetryStopped = false;
  private readonly tasks = new Map<string, Promise<void>>();
  /** Tail of the in-flight reconstruction request per capture id. */
  private readonly captureLocks = new Map<string, Promise<void>>();
  constructor(
    private readonly deps: {
      store: LocalStore;
      captureStore: CaptureStore;
      kubo: KuboClient;
      logger: Logger;
      dataRoot: string;
      workerUrl?: string;
      concurrency: number;
      participationGate: NetworkParticipationGate;
      workerAuth: WorkerAuthService;
      /** Shared runtime capability state; when supplied, dispatch confirms freshness before talking to the worker. */
      capabilities?: CapabilityRegistry;
      /** Optional: local processing analytics. Absent in tests that do not care about it. */
      analytics?: AnalyticsStore;
    },
  ) { this.cleanup = new JobCleanup(deps.store, deps.dataRoot, deps.workerAuth, deps.workerUrl); }

  async start(): Promise<void> {
    await this.deps.store.update((state) => {
      for (const value of Object.values(state.jobs || {})) {
        const job = value as LocalJob;
        if (job.state === 'running' || (job.state === 'queued' && state.jobCleanup?.[job.id])) {
          job.state = 'failed'; job.stage = 'failed';
          job.error = { code: 'interrupted_requires_retry', message: 'Processing interrupted; verify cleanup before starting a new attempt' };
          job.completedAt = job.updatedAt = new Date().toISOString();
          job.logs.push({ at: job.updatedAt, level: 'warn', message: 'Interrupted attempt retained for cleanup review' });
        }
      }
    });
    await this.reconcileCleanup();
    // Review copies of a record that was never written (a crash between the copy and the record) or no longer needs them.
    const swept = await sweepOrphanFaceReviews(this.deps.dataRoot, this.deps.store);
    if (swept.length) this.deps.logger.info({ removed: swept.length }, 'removed orphaned face-review copies');
    this.schedule();
  }

  async reconcileCleanup(): Promise<void> {
    await this.reconcileRecords(state => state !== 'complete');
    this.scheduleCleanupRetry();
  }

  private async reconcileRecords(wanted: (state: string) => boolean): Promise<void> {
    for (const [id, record] of Object.entries(this.deps.store.snapshot().jobCleanup || {})) {
      if (!wanted(record.state)) continue;
      await this.cleanup.reconcile(id).catch(() => {
        this.deps.logger.warn({ jobId: id, code: 'cleanup_retry_required' }, 'spatial cleanup remains pending');
      });
    }
  }

  private hasBlockedCleanup(): boolean {
    return Object.values(this.deps.store.snapshot().jobCleanup || {}).some(record => record.state === 'blocked');
  }

  /**
   * A worker that crashed is usually still restarting when the job's own cleanup runs, so that one attempt fails and
   * the journal goes blocked. Retry on a growing, bounded schedule so a Node that stays up recovers once the worker is
   * back; after the last attempt, creating a job or POST /local/v1/jobs/cleanup still retries on demand.
   */
  private scheduleCleanupRetry(attempt = 0): void {
    if (this.cleanupRetryStopped || this.cleanupRetryTimer || attempt >= CLEANUP_RETRY_DELAYS_MS.length || !this.hasBlockedCleanup()) return;
    this.cleanupRetryTimer = setTimeout(() => {
      this.cleanupRetryTimer = undefined;
      void this.reconcileRecords(state => state === 'blocked')
        .catch(() => undefined)
        .finally(() => this.scheduleCleanupRetry(attempt + 1));
    }, CLEANUP_RETRY_DELAYS_MS[attempt]);
    this.cleanupRetryTimer.unref();
  }

  private async retryBlockedCleanup(): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const attempt = this.reconcileRecords(state => state === 'blocked').catch(() => undefined);
    const bound = new Promise<void>(resolve => { timer = setTimeout(resolve, CREATE_CLEANUP_WAIT_MS); timer.unref(); });
    try { await Promise.race([attempt, bound]); } finally { if (timer) clearTimeout(timer); }
  }

  /** Stops the background cleanup retry for good (shutdown and tests); a reconcile still in flight cannot re-arm it. */
  stopCleanupRetry(): void {
    this.cleanupRetryStopped = true;
    if (this.cleanupRetryTimer) clearTimeout(this.cleanupRetryTimer);
    this.cleanupRetryTimer = undefined;
  }

  /** Quiescence is stronger than a terminal database state or an HTTP abort. */
  async ensureJobQuiescent(id: string): Promise<void> {
    await this.cancel(id);
    const job = this.get(id);
    let journal = this.deps.store.snapshot().jobCleanup?.[id];
    if (journal && journal.state !== 'complete') await this.cleanup.reconcile(id);
    journal = this.deps.store.snapshot().jobCleanup?.[id];
    if ((journal && journal.state !== 'complete') || (!journal && job.startedAt)) {
      throw localError(409, 'worker_quiescence_unverified');
    }
  }

  list(): LocalJob[] {
    return (Object.values(this.deps.store.snapshot().jobs || {}) as LocalJob[])
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  get(id: string): LocalJob {
    const job = this.deps.store.snapshot().jobs?.[id] as LocalJob | undefined;
    if (!job) throw localError(404, 'job_not_found');
    return structuredClone(job);
  }

  async create(type: JobType, input: Record<string, unknown>): Promise<LocalJob> {
    if (this.hasBlockedCleanup()) {
      // The worker may be back since the cleanup last failed; ask again before refusing. A hung worker must not hold
      // the request for the whole fetch timeout: wait a short, bounded time. The attempt carries on in the
      // background (one per record, shared with every other caller), and a later request sees its result.
      await this.retryBlockedCleanup();
      if (this.hasBlockedCleanup()) throw localError(409, 'worker_cleanup_pending');
    }
    // Network assignments retain participation authorization. A backend outage
    // must not revoke an owner's ability to process their own local capture.
    if (input.remoteComputeJobId) await this.deps.participationGate.assertUsefulOperation('remote_compute_execution');
    if (!['spatial.reconstruct', 'spatial.optimize', 'spatial.generate_preview'].includes(type)) throw localError(400, 'job_type_unsupported');
    const captureId = typeof input.captureId === 'string' ? input.captureId : '';
    if (!captureId) throw localError(400, 'job_capture_required');
    const target = this.deps.captureStore.get(captureId);
    // Import refuses a record without an artwork, but only after training and export. An artwork-less capture is a
    // normal thing to hold (private, not yet for an artwork), so the job must name one now, not burn a GPU run first.
    if (!String(input.artworkId || target.artworkId || '')) {
      throw localError(422, 'job_artwork_required', { message: 'This capture names no artwork and the job names none; a spatial record belongs to an artwork. Pass an artworkId, or import the capture with --artwork' });
    }

    if (type !== 'spatial.reconstruct') return this.insert(type, input);

    // The check for an attempt in flight, the package inspection and the
    // insertion form one critical section per capture. Checked and inserted
    // separately, two taps arriving together both see no active job while
    // each awaits the inspection, and both reserve a GPU run.
    return this.exclusiveForCapture(captureId, async () => {
      // A second tap, or a retry of a failure the processor could never have
      // fixed, must not cost another GPU run. An attempt already in flight is
      // the answer to "process this capture".
      const active = this.activeReconstruction(this.deps.store.snapshot().jobs, captureId);
      if (active) return structuredClone(active);

      // Reconstruction reads every frame off disk. Proving the package is
      // complete here costs a few stats; discovering it inside the worker
      // costs a GPU reservation, a job record and the operator's attention.
      const inspection = await this.deps.captureStore.inspect(captureId);
      if (!inspection.ok) {
        throw localError(422, inspection.code!, {
          message: inspection.message,
          missingPaths: inspection.missingPaths,
          missingCount: inspection.missingCount,
        });
      }
      // A video capture runs the video intake path in the worker; a posed
      // frame capture runs the Nerfstudio adapter. The package decides, and a
      // caller that names a mode must agree with it.
      const mode = inspection.kind === 'frames' || !inspection.kind ? 'frames' : inspection.kind;
      if (typeof input.mode === 'string' && input.mode !== mode) {
        throw localError(422, 'capture_input_mode_mismatch', { message: `The capture is a ${mode} capture, not ${input.mode}` });
      }
      // `maskFaces` is the Node's decision from the capture (below), never the caller's: a value sent by a paired client
      // for a capture that needs no masking would otherwise reach the worker.
      const { maskFaces: _callerMasking, ...callerInput } = input;
      const prepared = { ...(mode === 'frames' ? callerInput : { ...callerInput, mode }), ...this.revisionInput(input, captureId), ...this.maskingInput(captureId, mode, typeof input.artworkId === 'string' ? input.artworkId : undefined) };
      return this.insert(type, prepared, captureId);
    });
  }

  /**
   * Which parts of a capture the worker must mask before reconstruction (see `captures/faceMasking.ts`).
   * Photos masked before import need nothing here; posed frames are not masked by this step.
   */
  private maskingInput(captureId: string, mode: string, jobArtworkId: string | undefined): Record<string, unknown> {
    // A prepared dataset was masked on the requester's worker before it was packed; there is nothing left to mask.
    if (mode === 'frames' || mode === 'prepared') return {};
    const capture = this.deps.captureStore.get(captureId);
    // The default (masking for an artwork) is decided at import from the capture's artwork. A job that names an
    // artwork for a capture imported without one would bind a splat of unmasked images to that artwork.
    const unmasked = unmaskedForJobArtwork(capture, mode, jobArtworkId);
    if (unmasked.length) {
      throw localError(422, 'job_artwork_binds_unmasked_capture', {
        message: `This capture was imported without an artwork and without face masking (${unmasked.join(' and ')}); a job must not bind it to an artwork. Import it again with --artwork (faces are masked by default), or with --no-mask-faces to choose that explicitly`,
      });
    }
    const masking = effectiveMasking(capture);
    const photos = mode !== 'video' && masking.photos === 'worker';
    const video = (mode === 'video' || mode === 'mixed') && masking.video === 'worker';
    return photos || video ? { maskFaces: { photos, video } } : {};
  }

  /**
   * Validates the caller's options and resolves which earlier spatial record a
   * new one revises.
   *
   * `floaterCrop` must be a boolean. `previousSpatialId`, when given, must name
   * an existing local record for the same artwork; without one, a capture that
   * was derived from another (a video added to a photo capture) links to the
   * newest record of the capture it came from. The earlier record is only
   * referenced here, never changed.
   */
  private revisionInput(input: Record<string, unknown>, captureId: string): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    if (input.floaterCrop !== undefined) {
      if (typeof input.floaterCrop !== 'boolean') throw localError(400, 'job_floater_crop_invalid');
      out.floaterCrop = input.floaterCrop;
    }
    if (input.revisionNote !== undefined) {
      if (typeof input.revisionNote !== 'string' || input.revisionNote.length > 200) throw localError(400, 'job_revision_note_invalid');
      if (input.revisionNote.trim()) out.revisionNote = input.revisionNote.trim();
    }
    const capture = this.deps.captureStore.get(captureId);
    if (out.revisionNote && noteNamesOperator(String(out.revisionNote), capture.capturedBy)) {
      throw localError(422, 'job_revision_note_names_operator', { message: 'The revision note is published with the manifest and must not carry the operator name; describe the change instead' });
    }
    // A superseded record is history and its content is unpinned: nothing may link to it or be revised from it.
    const records = (Object.values(this.deps.store.snapshot().spatial || {}) as Array<{ id: string; state?: string; createdAt: string; manifest?: SpatialManifest }>)
      .filter((record) => record.state !== 'superseded');
    if (input.previousSpatialId !== undefined) {
      if (typeof input.previousSpatialId !== 'string' || !input.previousSpatialId) throw localError(400, 'job_previous_spatial_invalid');
      const previous = records.find((record) => record.id === input.previousSpatialId);
      if (!previous?.manifest) throw localError(422, 'previous_spatial_not_found', { message: 'No current local spatial record has that id (a superseded record cannot be revised)' });
      if (previous.manifest.artworkId !== (capture.artworkId ?? '')) {
        throw localError(422, 'previous_spatial_artwork_mismatch', { message: 'A revision must belong to the same artwork as the record it revises' });
      }
      out.previousSpatialId = previous.id;
    } else if (capture.derivedFrom?.captureId) {
      const sources = records
        .filter((record) => record.manifest?.captureId === capture.derivedFrom!.captureId && record.manifest.artworkId === (capture.artworkId ?? ''))
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
      if (sources[0]) out.previousSpatialId = sources[0].id;
    }
    return out;
  }

  /**
   * Records a queued job. For a reconstruction, re-asks inside the state
   * mutation itself, which nothing can interleave with, whether an attempt is
   * already active — so the guarantee holds even for a caller that reached
   * this runtime without going through [exclusiveForCapture].
   */
  private async insert(type: JobType, input: Record<string, unknown>, reconstructs?: string): Promise<LocalJob> {
    const now = new Date().toISOString();
    const job: LocalJob = {
      id: crypto.randomUUID(), type, capability: capabilityFor(type), state: 'queued', stage: 'queued', progress: 0,
      input: structuredClone(input), createdAt: now, updatedAt: now,
      logs: [{ at: now, level: 'info', message: 'Job queued' }],
    };
    let existing: LocalJob | undefined;
    await this.deps.store.update((state) => {
      existing = reconstructs ? this.activeReconstruction(state.jobs, reconstructs) : undefined;
      if (!existing) (state.jobs ??= {})[job.id] = job;
    });
    if (existing) return structuredClone(existing);
    this.schedule();
    return job;
  }

  private activeReconstruction(jobs: Record<string, unknown> | undefined, captureId: string): LocalJob | undefined {
    return (Object.values(jobs || {}) as LocalJob[]).find((job) =>
      job.type === 'spatial.reconstruct'
      && (job.input as { captureId?: unknown } | undefined)?.captureId === captureId
      && ['queued', 'running'].includes(job.state));
  }

  /**
   * Runs `work` after every earlier call for the same capture has settled.
   *
   * Keyed per capture, so requests for unrelated captures never wait on each
   * other; a failed call does not block the ones queued behind it.
   */
  private exclusiveForCapture<T>(captureId: string, work: () => Promise<T>): Promise<T> {
    const previous = this.captureLocks.get(captureId) ?? Promise.resolve();
    const result = previous.then(work);
    const tail = result.then(() => undefined, () => undefined);
    this.captureLocks.set(captureId, tail);
    void tail.then(() => {
      if (this.captureLocks.get(captureId) === tail) this.captureLocks.delete(captureId);
    });
    return result;
  }

  async cancel(id: string): Promise<LocalJob> {
    const job = this.get(id);
    if (['completed', 'failed', 'cancelled'].includes(job.state)) {
      await this.tasks.get(id);
      return this.get(id);
    }
    let changed = false;
    await this.deps.store.update((state) => {
      const current = state.jobs?.[id] as LocalJob | undefined;
      if (!current || ['completed', 'failed', 'cancelled'].includes(current.state)) return;
      current.state = 'cancelled';
      current.stage = 'cancelled';
      current.completedAt = current.updatedAt = new Date().toISOString();
      current.logs.push({ at: current.updatedAt, level: 'warn', message: 'Job cancelled' });
      changed = true;
    });
    // Persist the terminal decision before abort can reach run()'s catch.
    // Failure to persist leaves the running operation untouched and retryable.
    if (changed) {
      this.running.get(id)?.abort();
      this.recordAnalytics('cancelled', { durationMs: durationOf(this.get(id)) });
    }
    // This waits for Node-owned work only. Worker-process cancellation and
    // readable-file deletion require a separate acknowledged cleanup protocol.
    await this.tasks.get(id);
    return this.get(id);
  }

  health(): { configured: boolean; running: number; queued: number; concurrency: number; cleanupPending: number; cleanupBlocked: number } {
    const records = Object.values(this.deps.store.snapshot().jobCleanup || {});
    return { cleanupPending: records.filter(record => record.state !== 'complete').length, cleanupBlocked: records.filter(record => record.state === 'blocked').length, configured: Boolean(this.deps.workerUrl), running: this.running.size, queued: this.list().filter((job) => job.state === 'queued').length, concurrency: this.deps.concurrency };
  }

  private schedule(): void {
    if (this.dispatching) return;
    this.dispatching = true;
    queueMicrotask(() => void this.dispatch());
  }

  private async dispatch(): Promise<void> {
    try {
      while (this.running.size < this.deps.concurrency) {
        const next = this.list().reverse().find((job) => job.state === 'queued');
        if (!next) break;
        const controller = new AbortController();
        this.running.set(next.id, controller);
        const task = this.run(next.id, controller).finally(() => {
          this.running.delete(next.id); this.tasks.delete(next.id); this.schedule();
        });
        this.tasks.set(next.id, task);
        void task.catch(() => this.deps.logger.warn({ jobId: next.id, code: 'job_state_persistence_failed' }, 'spatial job state could not be saved'));
      }
    } finally {
      this.dispatching = false;
    }
  }

  private async run(id: string, controller: AbortController): Promise<void> {
    try {
      if (this.get(id).input.remoteComputeJobId) await this.deps.participationGate.assertUsefulOperation('remote_compute_execution');
      if (!this.deps.workerUrl) throw Object.assign(new Error('Spatial worker is not configured'), { code: 'worker_unavailable' });
      if (this.deps.capabilities) {
        await this.deps.capabilities.refreshIfStale();
        const health = this.deps.capabilities.getWorkerHealth();
        if (health.status !== 'ready') {
          throw Object.assign(new Error(health.detail || 'Spatial worker is not ready'), { code: 'worker_unavailable' });
        }
      }
      if (controller.signal.aborted || this.get(id).state === 'cancelled') return;
      const job = this.get(id);
      const capture = this.deps.captureStore.get(String(job.input.captureId));
      const outputDirectory = path.join(this.deps.dataRoot, 'private', 'jobs', id);
      await this.cleanup.own(id, job.type);
      const healthResponse = await fetch(`${this.deps.workerUrl}/health`, { signal: controller.signal });
      const workerHealth = await healthResponse.json() as { cleanupProtocol?: number; workerInstanceId?: string; inputModes?: unknown };
      if (!healthResponse.ok || workerHealth.cleanupProtocol !== 1 || !workerHealth.workerInstanceId) {
        throw Object.assign(new Error('Worker cleanup protocol is required'), { code: 'worker_cleanup_protocol_required' });
      }
      const inputMode = job.type === 'spatial.reconstruct' && typeof job.input.mode === 'string' ? job.input.mode : 'frames';
      // Every mode that is not a posed-frame package is prepared inside the worker.
      const videoJob = inputMode !== 'frames';
      const maskRequest = job.input.maskFaces as { photos?: boolean; video?: boolean } | undefined;
      if (maskRequest && (maskRequest.photos || maskRequest.video) && (workerHealth as { faceMasking?: unknown }).faceMasking !== true) {
        throw Object.assign(new Error('The spatial worker cannot mask faces; rebuild the worker image'), { code: 'worker_face_masking_unsupported' });
      }
      // A worker that masks but cannot name the images it flagged leaves the operator nothing to look at.
      if (maskRequest && (maskRequest.photos || maskRequest.video) && (workerHealth as { faceReviewImages?: unknown }).faceReviewImages !== true) {
        throw Object.assign(new Error('The spatial worker does not report which images need a look; rebuild the worker image'), { code: 'worker_face_review_unsupported' });
      }
      if (videoJob && !(Array.isArray(workerHealth.inputModes) && workerHealth.inputModes.includes(inputMode))) {
        throw Object.assign(new Error(`The spatial worker does not accept ${inputMode} input; rebuild the worker image`), { code: `worker_${inputMode}_unsupported` });
      }
      if (controller.signal.aborted || this.get(id).state === 'cancelled') return;
      await fs.mkdir(outputDirectory, { recursive: true, mode: 0o700 });
      await this.patchJob(id, (current) => {
        current.state = 'running'; current.stage = 'preparing_dataset'; current.progress = 0.05;
        current.startedAt = current.updatedAt = new Date().toISOString();
        current.logs.push({ at: current.updatedAt, level: 'info', message: videoJob ? `Preparing ${inputMode === 'video' ? 'video' : inputMode === 'photos' ? 'photos' : 'photos and video'} for the worker` : 'Preparing dataset from capture' });
      });
      this.recordAnalytics('started');

      // Only spatial.reconstruct trains from a raw capture; other job types
      // (optimize, generate_preview) operate on already-processed spatial
      // data and skip the kubus.capture/1 -> Nerfstudio translation.
      let workerCaptureDirectory = capture.directory;
      // A video capture is handed to the worker as is: frame extraction and
      // pose solving happen there, where ffmpeg and COLMAP live.
      if (job.type === 'spatial.reconstruct' && !videoJob) {
        const datasetDirectory = path.join(outputDirectory, 'dataset');
        const dataset = await buildNerfstudioDataset(capture.directory, datasetDirectory);
        workerCaptureDirectory = dataset.datasetDirectory;
        await this.patchJob(id, (current) => {
          current.logs.push({
            at: new Date().toISOString(),
            level: 'info',
            message: `Dataset ready: ${dataset.frameCount} view(s)${dataset.droppedFrameCount ? `, ${dataset.droppedFrameCount} frame(s) dropped as unusable` : ''}`,
          });
        });
      }

      await this.patchJob(id, (current) => {
        current.stage = 'starting_worker'; current.progress = 0.15; current.updatedAt = new Date().toISOString();
        current.logs.push({ at: current.updatedAt, level: 'info', message: 'Starting spatial worker' });
      });
      await this.patchJob(id, (current) => {
        // Training runs as a single blocking call in this worker version, so
        // there is no real interim percentage to report - an indeterminate
        // stage is honest, a fabricated one is not. A video job begins with
        // frame extraction; the worker's progress file moves it on.
        const first = !videoJob ? WORKER_STAGES.training! : inputMode === 'video' ? WORKER_STAGES.extracting_frames! : WORKER_STAGES.preparing_photos!;
        current.stage = first.stage; current.progress = null; current.updatedAt = new Date().toISOString();
        current.logs.push({ at: current.updatedAt, level: 'info', message: first.message });
      });
      const authorization = await this.deps.workerAuth.issue(id, job.type, { purpose: 'process', captureDirectory: workerCaptureDirectory, outputDirectory, input: job.input });
      if (controller.signal.aborted || this.get(id).state === 'cancelled') return;
      await this.cleanup.markWorkerAttempt(id, workerHealth.workerInstanceId);
      if (controller.signal.aborted || this.get(id).state === 'cancelled') return;
      // The worker answers when reconstruction is finished, which is far longer
      // than Node's default five-minute headers timeout allows.
      const stopWatching = this.watchWorkerProgress(id, outputDirectory, videoJob ? '' : 'training');
      let response: Response;
      let body: WorkerOutput & { detail?: unknown; error?: string };
      try {
        response = await longWorkerFetch(`${this.deps.workerUrl}/v1/process`, {
          method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Kubus-Worker-Authorization': authorization }, signal: controller.signal,
          body: JSON.stringify({ jobId: id, type: job.type, workerInstanceId: workerHealth.workerInstanceId, captureDirectory: workerCaptureDirectory, outputDirectory, input: job.input }),
        });
        body = await response.json().catch(() => ({})) as WorkerOutput & { detail?: unknown; error?: string };
      } finally {
        await stopWatching();
      }
      if (!response.ok) {
        // FastAPI reports the reason under `detail`, as a string or as a typed object.
        const failure = workerFailure(body, response.status);
        throw Object.assign(new Error(failure.message), { code: failure.code });
      }
      // Nothing is imported, and no record is made, for a result whose faces the worker did not mask.
      const unmasked = missingMasking(job.input.maskFaces as { photos?: boolean; video?: boolean } | undefined, body.provenance);
      if (unmasked.length) throw Object.assign(new Error(`The worker did not report face masking for: ${unmasked.join(', ')}`), { code: 'face_masking_failed' });
      await this.patchJob(id, (current) => {
        current.stage = 'importing'; current.progress = 0.9; current.updatedAt = new Date().toISOString();
        current.logs.push({ at: current.updatedAt, level: 'info', message: 'Importing spatial output into local Kubo' });
      });
      const spatial = await this.importOutputs(job, capture, outputDirectory, body);
      const derivation = this.derivationOf(capture, body.provenance);
      if (derivation) await this.logDerivation(id, derivation);
      await this.patchJob(id, (current) => {
        current.state = 'completed'; current.stage = 'completed'; current.progress = 1; current.output = spatial;
        if (derivation?.faceMasking) current.maskingDetail = derivation.faceMasking as Record<string, unknown>;
        current.completedAt = current.updatedAt = new Date().toISOString();
        current.logs.push({ at: current.updatedAt, level: 'info', message: 'Spatial outputs imported into local Kubo' });
      });
      const finished = this.get(id);
      const outputBytes = ((spatial as { manifest?: { variants?: Array<{ sizeBytes?: number }> } }).manifest?.variants || [])
        .reduce((sum, variant) => sum + (variant.sizeBytes || 0), 0);
      this.recordAnalytics('completed', { durationMs: durationOf(finished), inputBytes: capture.sizeBytes, outputBytes });
    } catch (error) {
      // cancel() already finalized state, stage, and analytics before
      // aborting; this rejection is just that abort reaching here.
      if (this.get(id).state === 'cancelled') return;
      const aborted = controller.signal.aborted;
      await this.patchJob(id, (current) => {
        current.state = aborted ? 'cancelled' : 'failed';
        current.stage = aborted ? 'cancelled' : 'failed';
        current.error = { code: String((error as { code?: string }).code || (aborted ? 'cancelled' : 'job_failed')), message: String((error as Error).message || error) };
        current.completedAt = current.updatedAt = new Date().toISOString();
        current.logs.push({ at: current.updatedAt, level: aborted ? 'warn' : 'error', message: current.error.message });
      });
      this.recordAnalytics(aborted ? 'cancelled' : 'failed', { durationMs: durationOf(this.get(id)) });
      this.deps.logger.warn({ jobId: id, code: (error as { code?: string }).code }, 'spatial job stopped');
    } finally {
      await this.cleanup.reconcile(id).catch(() => {
        this.deps.logger.warn({ jobId: id, code: 'cleanup_retry_required' }, 'spatial cleanup remains pending');
      });
      this.scheduleCleanupRetry();
    }
  }

  /**
   * Best-effort: analytics is a local, secondary concern. A write failure
   * here (disk full, permissions) must never fail or retry the job itself -
   * it is only logged.
   */
  private recordAnalytics(
    kind: 'started' | 'completed' | 'failed' | 'cancelled',
    extra: { durationMs?: number; inputBytes?: number; outputBytes?: number } = {},
  ): void {
    if (!this.deps.analytics) return;
    this.deps.analytics.recordProcessingEvent(kind, extra).catch((error) => {
      this.deps.logger.warn({ code: (error as Error).message }, 'failed to record processing analytics');
    });
  }

  /**
   * The revision block of a new record: its number, what it revises and what it
   * was built from. Always present, so a backend can bind a grant to
   * (`id`, `revision.number`) for every record, including the first.
   */
  private revisionOf(job: LocalJob, capture: ReturnType<CaptureStore['get']>, masking?: { ran?: boolean }): SpatialRevision {
    const previousId = typeof job.input.previousSpatialId === 'string' ? job.input.previousSpatialId : undefined;
    const previous = previousId ? (this.deps.store.snapshot().spatial?.[previousId] as { id: string; manifestCid?: string; manifest?: SpatialManifest } | undefined) : undefined;
    const inputs: SpatialRevision['inputs'] = { captureKind: capture.kind ?? 'frames' };
    if (capture.photos) inputs.photos = capture.photos.count;
    if (capture.video) inputs.video = true;
    if (!previous?.manifest) return { number: 1, reason: 'initial', inputs };
    const previousCapture = previous.manifest.captureId;
    const previousMasked = ((previous.manifest.captureProvenance.derivation?.faceMasking ?? {}) as { ran?: boolean }).ran === true;
    const note = typeof job.input.revisionNote === 'string' && job.input.revisionNote ? { note: job.input.revisionNote.slice(0, 200) } : {};
    // Decided first, whatever else this revision adds: a masked record must never name the unmasked record it
    // replaces (its id, manifest CID and private capture id), because a manifest is pinned and can be published.
    const fromUnmasked = masking?.ran === true && !previousMasked;
    // `face_masking` when the earlier record was reconstructed from unmasked images and this one from masked ones
    // (also when a video is added at the same time: `inputs` says so); otherwise `video_added` only when this
    // capture was built from the capture the previous record came from.
    const reason: SpatialRevision['reason'] = fromUnmasked ? 'face_masking' : capture.derivedFrom?.captureId === previousCapture ? 'video_added' : 'resolve';
    return {
      number: (previous.manifest.revision?.number ?? 1) + 1,
      reason,
      ...(note.note && noteNamesOperator(note.note, capture.capturedBy) ? {} : note),
      // No link back to the unmasked record for a revision that masks what its predecessor did not (see `SpatialRevision`).
      ...(fromUnmasked ? {} : {
        previousSpatialId: previous.id,
        ...(previous.manifestCid ? { previousManifestCid: previous.manifestCid } : {}),
        previousCaptureId: previousCapture,
      }),
      inputs,
    };
  }

  /** The worker's provenance, bounded, with the face-masking record of the capture added. */
  private derivationOf(capture: ReturnType<CaptureStore['get']>, provenance: unknown): Record<string, unknown> | undefined {
    const derivation = sanitizeProvenance(provenance);
    const masking = faceMaskingProvenance(capture, provenance);
    if (!masking) return derivation;
    return { ...(derivation ?? {}), faceMasking: masking };
  }

  private async importOutputs(job: LocalJob, capture: ReturnType<CaptureStore['get']>, outputDirectory: string, output: WorkerOutput): Promise<Record<string, unknown>> {
    const derivation = this.derivationOf(capture, output.provenance);
    if (!Array.isArray(output.variants) || output.variants.length === 0) throw Object.assign(new Error('Worker returned no variants'), { code: 'worker_output_invalid' });
    if (output.variants.length > 16) throw new Error('worker_output_variant_limit');
    const validated = await Promise.all(output.variants.map(async item => {
      if (!['spatial_preview', 'spatial_mobile', 'spatial_archive', 'model3d'].includes(item.role) ||
          !['hot', 'warm', 'cold'].includes(item.storageClass) ||
          typeof item.format !== 'string' || typeof item.mimeType !== 'string' ||
          !/^(?:application|model)\/[a-z0-9.+-]+$/i.test(item.mimeType) ||
          path.extname(item.path).slice(1).toLowerCase() !== item.format.toLowerCase()) {
        throw new Error('worker_output_variant_invalid');
      }
      return { item, target: await resolveWorkerOutputFile(outputDirectory, item.path) };
    }));
    const variants: SpatialVariant[] = [];
    const privateTarget = typeof job.input.privateOutputRequesterPublicKey === 'string' &&
      typeof job.input.remoteComputeJobId === 'string' ? {
        requesterPublicKey: job.input.privateOutputRequesterPublicKey,
        jobId: job.input.remoteComputeJobId,
        temporaryDirectory: outputDirectory,
        kubo: this.deps.kubo,
      } : null;
    // A prepared (managed) job returns the render derivative and at most a lightweight preview; a worker that still
    // returns the raw training file (`spatial_archive`) must not have it sealed and signed for the requester. Any other
    // private-output job (frames, photos, video) keeps its single archive: the worker only splits prepared output.
    if (privateTarget && capture.kind === 'prepared') assertSpatialOutputRoles(validated.map(({ item }) => item.role));
    if (privateTarget && maskingNeedsLookCounts(derivation?.faceMasking).images > 0) {
      throw Object.assign(new Error('remote_face_review_required'), { code: 'provider_face_review_required' });
    }
    const sealed: PrivateOutputBlob[] = [];
    const id = crypto.randomUUID();
    const pinOwner = privateTarget ? `provider-output:${privateTarget.jobId}` : `spatial:${id}`;
    // Before anything is added to Kubo: the flagged masked images are kept for the operator's look, and a record
    // whose review could not be done is never made.
    const faceReview = await this.keepFaceReview(id, job, capture, outputDirectory, derivation?.faceMasking);
    try {
      const managed = new ManagedPins(this.deps.kubo, this.deps.store);
      for (const { item, target } of validated) {
        if (privateTarget) {
          const blob = await sealOutputBlob({ ...privateTarget, source: target, role: item.role });
          sealed.push(blob);
          await this.pinEncryptedOutput(blob, pinOwner, privateTarget.jobId);
          variants.push({ role: item.role, cid: blob.cid, sizeBytes: blob.plaintextBytes,
            mimeType: item.mimeType, format: item.format, storageClass: item.storageClass });
          continue;
        }
        // Streamed from disk: a Gaussian splat PLY can be hundreds of megabytes
        // and must never be held whole in Node's memory just to re-emit it as
        // multipart form data.
        const { size: sizeBytes } = await fs.stat(target);
        const added = await this.deps.kubo.addFileStreamed(target, path.basename(target), undefined, { pin: false });
        if (!added.Hash) throw new Error('kubo_add_missing_cid');
        await managed.acquire(added.Hash, pinOwner);
        variants.push({ role: item.role, cid: added.Hash, sizeBytes, mimeType: item.mimeType, format: item.format, storageClass: item.storageClass });
      }
      const maskingSummary = publicMaskingSummary(derivation?.faceMasking as Record<string, unknown> | undefined);
      const manifest: SpatialManifest = {
        schema: 'kubus.spatial/1', type: 'gaussianSplat', id,
        artworkId: String(job.input.artworkId || capture.artworkId || ''), markerId: String(job.input.markerId || capture.markerId || '') || undefined,
        captureId: capture.id, captureProvenance: { source: 'localCapture', captureId: capture.id, ...(derivation ? { derivation: publicDerivation(derivation) } : {}) }, capturedAt: capture.capturedAt,
        capturedBy: typeof job.input.capturedBy === 'string' ? job.input.capturedBy : capture.capturedBy,
        variants, transform: output.transform, viewerDefaults: output.viewerDefaults,
        processing: { ...output.processing, ...(maskingSummary ? { faceMasking: maskingSummary } : {}) },
        createdAt: new Date().toISOString(),
        revision: this.revisionOf(job, capture, derivation?.faceMasking as { ran?: boolean } | undefined),
      };
      if (!manifest.artworkId) throw new Error('spatial_artwork_required');
      validateSpatialManifest(manifest);
      const manifestBytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`);
      if (privateTarget) {
        const source = path.join(outputDirectory, `${id}.spatial.json`);
        await fs.writeFile(source, manifestBytes, { mode: 0o600, flag: 'wx' });
        const blob = await sealOutputBlob({ ...privateTarget, source, role: 'manifest' });
        sealed.push(blob);
        const commitment = validatePrivateOutput({
          schema: PRIVATE_OUTPUT_PROTOCOL, manifestCid: blob.cid, blobs: sealed,
        }, privateTarget.jobId, blob.cid, sealed.map(item => item.cid));
        await this.pinEncryptedOutput(blob, pinOwner, privateTarget.jobId);
        return { privateOutput: commitment };
      }
      const added = await this.deps.kubo.addBytes(manifestBytes, `${id}.spatial.json`, { pin: false });
      if (!added.Hash) throw new Error('kubo_add_manifest_missing_cid');
      await managed.acquire(added.Hash, pinOwner);
      // Private to the Node (not in the manifest): what a human still has to look at before this record is published.
      const record = { id, state: 'local', manifestCid: added.Hash, manifest, createdAt: manifest.createdAt, privateSourceCapture: true, pinOwner, ...(faceReview ? { faceReview } : {}) };
      await this.deps.store.update((state) => { (state.spatial ??= {})[id] = record; });
      return record;
    } catch (error) {
      if (faceReview) await removeFaceReviewImages(this.deps.dataRoot, id);
      if (privateTarget) {
        const managed = new ManagedPins(this.deps.kubo, this.deps.store);
        for (const blob of sealed) await managed.release(blob.cid, pinOwner).catch(() => undefined);
      }
      throw error;
    }
  }

  private async pinEncryptedOutput(blob: PrivateOutputBlob, pinOwner: string, jobId: string): Promise<void> {
    await this.deps.store.update(state => {
      (state.privateComputeCids ??= {})[blob.cid] = {
        role: 'private_output', jobId, pinOwner, createdAt: new Date().toISOString(),
      };
    });
    await new ManagedPins(this.deps.kubo, this.deps.store).acquire(blob.cid, pinOwner);
  }

  /**
   * The review a record needs (see `spatial/faceReview.ts`): the images face masking flagged, copied (masked) out
   * of the job's working directory, which is removed when the job ends. `undefined` when nothing is flagged.
   */
  private async keepFaceReview(id: string, job: LocalJob, capture: ReturnType<CaptureStore['get']>, outputDirectory: string, masking: unknown): Promise<FaceReview | undefined> {
    const pending = maskingNeedsLookCounts(masking).images;
    if (!pending) return undefined;
    const sources: ReviewSource[] = [];
    let truncated = false;
    for (const part of ['photos', 'video'] as const) {
      const record = (masking as Record<string, { source?: string; needsLook?: NeedsLook } | undefined>)[part];
      const look = record?.needsLook;
      if (!look || !look.images) continue;
      if (look.itemsTruncated) truncated = true;
      for (const item of look.items ?? []) {
        let source: ReviewSource | undefined;
        if (record?.source === 'premasked') {
          // The photos were masked before import: the capture's own files are the masked images.
          const relative = await this.capturePhotoOf(capture, item.image);
          if (relative) source = { part, image: item.image, relative, root: capture.directory };
        } else if (item.file) {
          source = { part, image: item.image, relative: item.file, root: outputDirectory };
        }
        if (!source) throw Object.assign(new Error('A flagged image has no copy that can be kept for review; rebuild the worker image'), { code: 'face_review_images_unavailable' });
        sources.push({ ...source, ...(item.weakExcluded ? { weakExcluded: item.weakExcluded } : {}), ...(item.largeBelowCertain ? { largeBelowCertain: item.largeBelowCertain } : {}), ...(item.seconds !== undefined ? { seconds: item.seconds } : {}) });
      }
      // Images flagged but not listed (only when a list was cut) are counted in `pending`.
      if ((look.items?.length ?? 0) < look.images) truncated = true;
    }
    return storeFaceReview(this.deps.dataRoot, id, job.id, pending, sources, truncated);
  }

  /** `photos/NNNNN.<ext>` of a capture: the file of the photo with that 1-based number, when it exists. */
  private async capturePhotoOf(capture: ReturnType<CaptureStore['get']>, image: number): Promise<string | undefined> {
    const stem = String(image).padStart(5, '0');
    try {
      const entries = await fs.readdir(path.join(capture.directory, 'photos'));
      const match = entries.find((entry) => path.parse(entry).name === stem && /\.(jpe?g|png)$/i.test(entry));
      return match ? `photos/${match}` : undefined;
    } catch {
      return undefined;
    }
  }

  /**
   * Follows the stage the worker publishes while its single request is open.
   *
   * The worker writes `worker-progress.json` into the job's output directory,
   * which both containers share. Reading it keeps the job's stage truthful
   * (frame extraction, pose solving, training) without a second protocol and
   * without inventing percentages. Best effort: an unreadable file is simply
   * not a stage change. Returns a function that stops watching and waits for
   * any in-flight update, so nothing patches the job after the request ends.
   *
   * `alreadyLogged` is the stage the caller has already announced, so the first
   * poll does not repeat it (a frames job is announced as `training` before the
   * request; a video job keeps the worker's richer first line).
   */
  private watchWorkerProgress(id: string, outputDirectory: string, alreadyLogged = ''): () => Promise<void> {
    let last = alreadyLogged;
    let pending: Promise<void> = Promise.resolve();
    const poll = async (): Promise<void> => {
      let parsed: { stage?: unknown; detail?: unknown };
      try {
        parsed = JSON.parse(await fs.readFile(path.join(outputDirectory, 'worker-progress.json'), 'utf8'));
      } catch {
        return;
      }
      const stage = typeof parsed.stage === 'string' ? parsed.stage : '';
      if (!stage || stage === last) return;
      last = stage;
      const detail = (parsed.detail && typeof parsed.detail === 'object' ? parsed.detail : {}) as Record<string, unknown>;
      const mapped = WORKER_STAGES[stage];
      await this.patchJob(id, (current) => {
        const at = new Date().toISOString();
        if (mapped) { current.stage = mapped.stage; current.progress = null; current.updatedAt = at; }
        current.logs.push({ at, level: 'info', message: describeWorkerStage(stage, detail, mapped?.message) });
      }).catch(() => undefined);
    };
    const timer = setInterval(() => { pending = pending.then(poll); }, PROGRESS_POLL_MS);
    timer.unref?.();
    return async () => {
      clearInterval(timer);
      await pending;
      await poll();
    };
  }

  private async logDerivation(id: string, derivation: Record<string, unknown>): Promise<void> {
    const sfm = derivation.sfm as Record<string, unknown> | undefined;
    const parts: string[] = [];
    if (sfm && typeof sfm.registeredViews === 'number' && typeof sfm.submittedViews === 'number') {
      parts.push(`COLMAP registered ${sfm.registeredViews} of ${sfm.submittedViews} views`);
    }
    if (typeof derivation.splatCount === 'number') parts.push(`${derivation.splatCount} splats`);
    const orientation = derivation.orientation as Record<string, unknown> | undefined;
    if (orientation && typeof orientation.method === 'string') parts.push(`orientation by ${orientation.method}`);
    const crop = derivation.crop as Record<string, unknown> | undefined;
    if (crop?.applied === true && typeof crop.splatsBefore === 'number' && typeof crop.splatsAfter === 'number') {
      parts.push(`floater crop kept ${crop.splatsAfter} of ${crop.splatsBefore} splats`);
    }
    const toLook = maskingNeedsLookCounts(derivation.faceMasking);
    if (parts.length === 0 && toLook.images === 0) return;
    await this.patchJob(id, (current) => {
      const at = new Date().toISOString();
      if (parts.length) current.logs.push({ at, level: 'info', message: parts.join('; ') });
      // Face masking is tuned for recall but a run cannot decide everything; say so where the operator reads the job.
      if (toLook.images) {
        const kinds = [
          toLook.largeBelowCertain ? `${toLook.largeBelowCertain} large detection(s) it did not mask (a person close to the camera, or a painted head)` : '',
          toLook.weakExcluded ? `${toLook.weakExcluded} weaker detection(s) inside an exclude box (a real face next to a painted one)` : '',
        ].filter(Boolean).join('; ');
        current.logs.push({ at, level: 'warn', message: `Face masking left ${toLook.images} image(s) a human has to look at: ${kinds}. The job record lists which images; this record cannot be published until that look is acknowledged` });
      }
    }).catch(() => undefined);
  }

  private async patchJob(id: string, mutate: (job: LocalJob) => void): Promise<void> {
    await this.deps.store.update((state) => {
      const job = state.jobs?.[id] as LocalJob | undefined;
      if (!job) throw localError(404, 'job_not_found');
      if (job.state === 'cancelled') throw localError(409, 'job_cancelled');
      mutate(job);
    });
  }
}

function describeWorkerStage(stage: string, detail: Record<string, unknown>, fallback?: string): string {
  const number = (value: unknown) => (typeof value === 'number' && Number.isFinite(value) ? value : undefined);
  if (stage === 'extracting_frames') {
    const video = (detail.video ?? {}) as Record<string, unknown>;
    const seconds = number(video.durationSeconds);
    const size = number(video.width) && number(video.height) ? `${video.width}x${video.height}` : undefined;
    return `${fallback ?? stage}${seconds !== undefined ? ` (${seconds.toFixed(1)} s${size ? `, ${size}` : ''})` : ''}`;
  }
  if (stage === 'solving_poses') {
    const frames = (detail.frames ?? {}) as Record<string, unknown>;
    const counts = [
      number(frames.extracted) !== undefined ? `${frames.extracted} extracted` : '',
      number(frames.blurDropped) !== undefined ? `${frames.blurDropped} blurry dropped` : '',
      number(frames.duplicateDropped) !== undefined ? `${frames.duplicateDropped} near-duplicate dropped` : '',
      number(frames.selected) !== undefined ? `${frames.selected} kept` : '',
    ].filter(Boolean);
    return `${fallback ?? stage}${counts.length ? `: ${counts.join(', ')}` : ''}`;
  }
  if (stage === 'preparing_photos') {
    const photos = (detail.photos ?? {}) as Record<string, unknown>;
    return `${fallback ?? stage}${number(photos.submitted) !== undefined ? `: ${photos.submitted} photos` : ''}`;
  }
  if (stage === 'masking_faces') return `${fallback ?? 'Masking faces'}${number(detail.images) !== undefined ? ` in ${detail.images} images` : ''}`;
  if (stage === 'exporting') return 'Exporting the Gaussian splat';
  return fallback ?? stage;
}
