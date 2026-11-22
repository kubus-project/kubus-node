import crypto from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { AnalyticsStore } from '../analytics/analyticsStore.js';
import type { CaptureStore } from '../captures/captureStore.js';
import type { KuboClient } from '../ipfs/kuboClient.js';
import { localError } from '../localApi/pairingService.js';
import type { Logger } from '../logging/logger.js';
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
};
const PROGRESS_POLL_MS = 2000;
const PROVENANCE_MAX_BYTES = 8 * 1024;

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
    this.schedule();
  }

  async reconcileCleanup(): Promise<void> {
    for (const [id, record] of Object.entries(this.deps.store.snapshot().jobCleanup || {})) {
      if (record.state === 'complete') continue;
      await this.cleanup.reconcile(id).catch(() => {
        this.deps.logger.warn({ jobId: id, code: 'cleanup_retry_required' }, 'spatial cleanup remains pending');
      });
    }
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
    if (Object.values(this.deps.store.snapshot().jobCleanup || {}).some(record => record.state === 'blocked')) {
      throw localError(409, 'worker_cleanup_pending');
    }
    // Network assignments retain participation authorization. A backend outage
    // must not revoke an owner's ability to process their own local capture.
    if (input.remoteComputeJobId) await this.deps.participationGate.assertUsefulOperation('remote_compute_execution');
    if (!['spatial.reconstruct', 'spatial.optimize', 'spatial.generate_preview'].includes(type)) throw localError(400, 'job_type_unsupported');
    const captureId = typeof input.captureId === 'string' ? input.captureId : '';
    if (!captureId) throw localError(400, 'job_capture_required');
    this.deps.captureStore.get(captureId);

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
      const prepared = { ...(mode === 'frames' ? input : { ...input, mode }), ...this.revisionInput(input, captureId) };
      return this.insert(type, prepared, captureId);
    });
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
    const capture = this.deps.captureStore.get(captureId);
    const records = Object.values(this.deps.store.snapshot().spatial || {}) as Array<{ id: string; createdAt: string; manifest?: SpatialManifest }>;
    if (input.previousSpatialId !== undefined) {
      if (typeof input.previousSpatialId !== 'string' || !input.previousSpatialId) throw localError(400, 'job_previous_spatial_invalid');
      const previous = records.find((record) => record.id === input.previousSpatialId);
      if (!previous?.manifest) throw localError(422, 'previous_spatial_not_found', { message: 'No local spatial record has that id' });
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
      const authorization = await this.deps.workerAuth.issue(id, job.type);
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
      await this.patchJob(id, (current) => {
        current.stage = 'importing'; current.progress = 0.9; current.updatedAt = new Date().toISOString();
        current.logs.push({ at: current.updatedAt, level: 'info', message: 'Importing spatial output into local Kubo' });
      });
      const spatial = await this.importOutputs(job, capture, outputDirectory, body);
      const derivation = sanitizeProvenance(body.provenance);
      if (derivation) await this.logDerivation(id, derivation);
      await this.patchJob(id, (current) => {
        current.state = 'completed'; current.stage = 'completed'; current.progress = 1; current.output = spatial;
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
  private revisionOf(job: LocalJob, capture: ReturnType<CaptureStore['get']>): SpatialRevision {
    const previousId = typeof job.input.previousSpatialId === 'string' ? job.input.previousSpatialId : undefined;
    const previous = previousId ? (this.deps.store.snapshot().spatial?.[previousId] as { id: string; manifestCid?: string; manifest?: SpatialManifest } | undefined) : undefined;
    const inputs: SpatialRevision['inputs'] = { captureKind: capture.kind ?? 'frames' };
    if (capture.photos) inputs.photos = capture.photos.count;
    if (capture.video) inputs.video = true;
    if (!previous?.manifest) return { number: 1, reason: 'initial', inputs };
    const previousCapture = previous.manifest.captureId;
    return {
      number: (previous.manifest.revision?.number ?? 1) + 1,
      // `video_added` only when this capture was built from the capture the previous record came from.
      reason: capture.derivedFrom?.captureId === previousCapture ? 'video_added' : 'resolve',
      previousSpatialId: previous.id,
      ...(previous.manifestCid ? { previousManifestCid: previous.manifestCid } : {}),
      previousCaptureId: previousCapture,
      inputs,
    };
  }

  private async importOutputs(job: LocalJob, capture: ReturnType<CaptureStore['get']>, outputDirectory: string, output: WorkerOutput): Promise<Record<string, unknown>> {
    const derivation = sanitizeProvenance(output.provenance);
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
    const id = crypto.randomUUID();
    const pinOwner = `spatial:${id}`;
    const managed = new ManagedPins(this.deps.kubo, this.deps.store);
    for (const { item, target } of validated) {
      // Streamed from disk: a Gaussian splat PLY can be hundreds of megabytes
      // and must never be held whole in Node's memory just to re-emit it as
      // multipart form data.
      const { size: sizeBytes } = await fs.stat(target);
      const added = await this.deps.kubo.addFileStreamed(target, path.basename(target), undefined, { pin: false });
      if (!added.Hash) throw new Error('kubo_add_missing_cid');
      await managed.acquire(added.Hash, pinOwner);
      variants.push({ role: item.role, cid: added.Hash, sizeBytes, mimeType: item.mimeType, format: item.format, storageClass: item.storageClass });
    }
    const manifest: SpatialManifest = {
      schema: 'kubus.spatial/1', type: 'gaussianSplat', id,
      artworkId: String(job.input.artworkId || capture.artworkId || ''), markerId: String(job.input.markerId || capture.markerId || '') || undefined,
      captureId: capture.id, captureProvenance: { source: 'localCapture', captureId: capture.id, ...(derivation ? { derivation } : {}) }, capturedAt: capture.capturedAt,
      capturedBy: typeof job.input.capturedBy === 'string' ? job.input.capturedBy : capture.capturedBy,
      variants, transform: output.transform, viewerDefaults: output.viewerDefaults, processing: output.processing, createdAt: new Date().toISOString(),
      revision: this.revisionOf(job, capture),
    };
    if (!manifest.artworkId) throw new Error('spatial_artwork_required');
    validateSpatialManifest(manifest);
    const manifestBytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`);
    const added = await this.deps.kubo.addBytes(manifestBytes, `${id}.spatial.json`, { pin: false });
    if (!added.Hash) throw new Error('kubo_add_manifest_missing_cid');
    await managed.acquire(added.Hash, pinOwner);
    const record = { id, state: 'local', manifestCid: added.Hash, manifest, createdAt: manifest.createdAt, privateSourceCapture: true, pinOwner };
    await this.deps.store.update((state) => { (state.spatial ??= {})[id] = record; });
    return record;
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
    if (parts.length === 0) return;
    await this.patchJob(id, (current) => {
      current.logs.push({ at: new Date().toISOString(), level: 'info', message: parts.join('; ') });
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
  if (stage === 'exporting') return 'Exporting the Gaussian splat';
  return fallback ?? stage;
}
