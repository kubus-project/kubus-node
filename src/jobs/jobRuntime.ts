import crypto from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { AnalyticsStore } from '../analytics/analyticsStore.js';
import type { CaptureStore } from '../captures/captureStore.js';
import type { KuboClient } from '../ipfs/kuboClient.js';
import { localError } from '../localApi/pairingService.js';
import type { Logger } from '../logging/logger.js';
import { buildNerfstudioDataset } from '../spatial/nerfstudioAdapter.js';
import { validateSpatialManifest, type SpatialManifest, type SpatialVariant } from '../spatial/models.js';
import type { LocalStore } from '../state/localStore.js';
import type { NetworkParticipationGate } from '../participation/networkParticipationGate.js';
import type { WorkerAuthService } from '../spatial/workerAuth.js';
import type { CapabilityRegistry } from '../capabilities/registry.js';

export type JobType = 'spatial.reconstruct' | 'spatial.optimize' | 'spatial.generate_preview';
export type JobState = 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';
/**
 * Truthful processing stages. `progress` stays a fixed, honest checkpoint for
 * bounded steps; it is `null` during `training`, the one stage whose real
 * duration and completion fraction this worker version does not report -
 * showing a fabricated percentage there would be worse than an indeterminate
 * spinner labelled with the real stage name.
 */
export type JobStage =
  | 'queued'
  | 'preparing_dataset'
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
  ) {}

  async start(): Promise<void> {
    await this.deps.store.update((state) => {
      for (const value of Object.values(state.jobs || {})) {
        const job = value as LocalJob;
        if (job.state === 'running') {
          job.state = 'queued';
          job.updatedAt = new Date().toISOString();
          job.logs.push({ at: job.updatedAt, level: 'warn', message: 'Recovered after node restart' });
        }
      }
    });
    this.schedule();
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
      return this.insert(type, input, captureId);
    });
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
    if (['completed', 'failed', 'cancelled'].includes(job.state)) return job;
    this.running.get(id)?.abort();
    await this.patchJob(id, (current) => {
      current.state = 'cancelled';
      current.stage = 'cancelled';
      current.completedAt = current.updatedAt = new Date().toISOString();
      current.logs.push({ at: current.updatedAt, level: 'warn', message: 'Job cancelled' });
    });
    // Finalized here, not in run()'s catch: by the time the abort causes
    // that fetch to reject, state is already 'cancelled' and its early
    // return (correctly) does nothing further, so this is the one place a
    // user-initiated cancellation - queued or running - gets counted.
    this.recordAnalytics('cancelled', { durationMs: durationOf(this.get(id)) });
    return this.get(id);
  }

  health(): { configured: boolean; running: number; queued: number; concurrency: number } {
    return { configured: Boolean(this.deps.workerUrl), running: this.running.size, queued: this.list().filter((job) => job.state === 'queued').length, concurrency: this.deps.concurrency };
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
        void this.run(next.id, controller).finally(() => { this.running.delete(next.id); this.schedule(); });
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
      const job = this.get(id);
      const capture = this.deps.captureStore.get(String(job.input.captureId));
      const outputDirectory = path.join(this.deps.dataRoot, 'private', 'jobs', id);
      await fs.mkdir(outputDirectory, { recursive: true, mode: 0o700 });
      await this.patchJob(id, (current) => {
        current.state = 'running'; current.stage = 'preparing_dataset'; current.progress = 0.05;
        current.startedAt = current.updatedAt = new Date().toISOString();
        current.logs.push({ at: current.updatedAt, level: 'info', message: 'Preparing dataset from capture' });
      });
      this.recordAnalytics('started');

      // Only spatial.reconstruct trains from a raw capture; other job types
      // (optimize, generate_preview) operate on already-processed spatial
      // data and skip the kubus.capture/1 -> Nerfstudio translation.
      let workerCaptureDirectory = capture.directory;
      if (job.type === 'spatial.reconstruct') {
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
        // stage is honest, a fabricated one is not.
        current.stage = 'training'; current.progress = null; current.updatedAt = new Date().toISOString();
        current.logs.push({ at: current.updatedAt, level: 'info', message: 'Training (this can take a while; progress is not reported mid-run by this worker version)' });
      });
      const response = await fetch(`${this.deps.workerUrl}/v1/process`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Kubus-Worker-Authorization': await this.deps.workerAuth.issue(id, job.type) }, signal: controller.signal,
        body: JSON.stringify({ jobId: id, type: job.type, captureDirectory: workerCaptureDirectory, outputDirectory, input: job.input }),
      });
      const body = await response.json().catch(() => ({})) as WorkerOutput & { error?: string };
      if (!response.ok) throw Object.assign(new Error(body.error || `worker_http_${response.status}`), { code: response.status === 503 ? 'worker_unsupported' : 'worker_failed' });
      await this.patchJob(id, (current) => {
        current.stage = 'importing'; current.progress = 0.9; current.updatedAt = new Date().toISOString();
        current.logs.push({ at: current.updatedAt, level: 'info', message: 'Importing spatial output into local Kubo' });
      });
      const spatial = await this.importOutputs(job, capture, outputDirectory, body);
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

  private async importOutputs(job: LocalJob, capture: ReturnType<CaptureStore['get']>, outputDirectory: string, output: WorkerOutput): Promise<Record<string, unknown>> {
    if (!Array.isArray(output.variants) || output.variants.length === 0) throw Object.assign(new Error('Worker returned no variants'), { code: 'worker_output_invalid' });
    const variants: SpatialVariant[] = [];
    for (const item of output.variants) {
      const target = path.resolve(outputDirectory, item.path);
      if (!target.startsWith(`${path.resolve(outputDirectory)}${path.sep}`)) throw new Error('worker_output_path_invalid');
      // Streamed from disk: a Gaussian splat PLY can be hundreds of megabytes
      // and must never be held whole in Node's memory just to re-emit it as
      // multipart form data.
      const { size: sizeBytes } = await fs.stat(target);
      const added = await this.deps.kubo.addFileStreamed(target, path.basename(target));
      if (!added.Hash) throw new Error('kubo_add_missing_cid');
      variants.push({ role: item.role, cid: added.Hash, sizeBytes, mimeType: item.mimeType, format: item.format, storageClass: item.storageClass });
    }
    const id = crypto.randomUUID();
    const manifest: SpatialManifest = {
      schema: 'kubus.spatial/1', type: 'gaussianSplat', id,
      artworkId: String(job.input.artworkId || capture.artworkId || ''), markerId: String(job.input.markerId || capture.markerId || '') || undefined,
      captureId: capture.id, captureProvenance: { source: 'localCapture', captureId: capture.id }, capturedAt: capture.capturedAt,
      capturedBy: typeof job.input.capturedBy === 'string' ? job.input.capturedBy : undefined,
      variants, transform: output.transform, viewerDefaults: output.viewerDefaults, processing: output.processing, createdAt: new Date().toISOString(),
    };
    if (!manifest.artworkId) throw new Error('spatial_artwork_required');
    validateSpatialManifest(manifest);
    const manifestBytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`);
    const added = await this.deps.kubo.addBytes(manifestBytes, `${id}.spatial.json`);
    if (!added.Hash) throw new Error('kubo_add_manifest_missing_cid');
    const record = { id, state: 'local', manifestCid: added.Hash, manifest, createdAt: manifest.createdAt, privateSourceCapture: true };
    await this.deps.store.update((state) => { (state.spatial ??= {})[id] = record; });
    return record;
  }

  private async patchJob(id: string, mutate: (job: LocalJob) => void): Promise<void> {
    await this.deps.store.update((state) => {
      const job = state.jobs?.[id] as LocalJob | undefined;
      if (!job) throw localError(404, 'job_not_found');
      mutate(job);
    });
  }
}
