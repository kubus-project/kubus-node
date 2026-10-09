import crypto from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { AnalyticsStore, ProcessingEventExtra } from '../analytics/analyticsStore.js';
import type { CaptureStore } from '../captures/captureStore.js';
import type { KuboClient } from '../ipfs/kuboClient.js';
import { localError } from '../localApi/pairingService.js';
import type { Logger } from '../logging/logger.js';
import { buildNerfstudioDataset } from '../spatial/nerfstudioAdapter.js';
import { importWorkerVariant, ImportError, provenanceFrom, type WorkerDerivative, type WorkerVariant } from '../spatial/derivativeImport.js';
import { validateSpatialManifest, type SpatialManifest } from '../spatial/models.js';
import {
  DERIVATIVE_ROLE,
  SpatialRecords,
  summarizeDerivatives,
  type DerivativeKind,
  type SpatialStoreRecord,
} from '../spatial/spatialRecords.js';
import type { LocalStore } from '../state/localStore.js';
import type { NetworkParticipationGate } from '../participation/networkParticipationGate.js';
import type { WorkerAuthService } from '../spatial/workerAuth.js';
import type { CapabilityRegistry } from '../capabilities/registry.js';

export type JobType = 'spatial.reconstruct' | 'spatial.optimize' | 'spatial.generate_preview';
export type JobState = 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';
/**
 * Truthful processing stages. `progress` is a fixed, honest checkpoint for
 * bounded steps and `null` for the stages whose real duration and completion
 * fraction the worker does not report - showing a fabricated percentage there
 * would be worse than an indeterminate bar labelled with the real stage name.
 *
 * A reconstruction passes through, in order: preparing_dataset, starting_worker,
 * training, importing (the master), generating_preview, optimizing_runtime,
 * cleaning_workspace, completed. A derivative job (re-run on a preserved master)
 * starts at preparing_master.
 */
export type JobStage =
  | 'queued'
  | 'preparing_dataset'
  | 'preparing_master'
  | 'starting_worker'
  | 'training'
  | 'importing'
  | 'generating_preview'
  | 'optimizing_runtime'
  | 'cleaning_workspace'
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
  /**
   * Written once the reconstruction master is durable in Kubo. A job that is
   * re-queued after a crash resumes from here instead of training again and
   * creating a second scene.
   */
  checkpoint?: { spatialId: string };
  createdAt: string;
  updatedAt: string;
  startedAt?: string;
  completedAt?: string;
  logs: Array<{ at: string; level: 'info' | 'warn' | 'error'; message: string }>;
}

interface WorkerOutput {
  variants: WorkerVariant[];
  transform?: SpatialManifest['transform'];
  viewerDefaults?: Record<string, unknown>;
  processing?: Partial<SpatialManifest['processing']>;
  derivative?: WorkerDerivative;
  measurements?: { masterBytes?: number; masterSplats?: number; trainingMs?: number; exportMs?: number };
  error?: string;
  detail?: string | { code?: string; message?: string };
}

const WORKER_TYPE: Record<DerivativeKind, JobType> = { preview: 'spatial.generate_preview', runtime: 'spatial.optimize' };
const DERIVATIVE_STAGE: Record<DerivativeKind, JobStage> = { preview: 'generating_preview', runtime: 'optimizing_runtime' };
const DERIVATIVE_CAPABILITY: Record<DerivativeKind, string> = { preview: 'spatial.generate_preview', runtime: 'spatial.optimize' };
const DERIVATIVE_ORDER: DerivativeKind[] = ['preview', 'runtime'];
const DERIVATION_TYPES: JobType[] = ['spatial.optimize', 'spatial.generate_preview'];

const capabilityFor = (type: JobType) => type === 'spatial.reconstruct' ? 'spatial.reconstruction' : 'spatial.optimization';

/** Wall-clock duration from real start/end timestamps, or undefined if the job never actually started running. */
function durationOf(job: LocalJob): number | undefined {
  if (!job.startedAt || !job.completedAt) return undefined;
  return Date.parse(job.completedAt) - Date.parse(job.startedAt);
}

/** Worker failures arrive as FastAPI `{detail:{code,message}}`, or the older `{error}`. */
function workerFailure(status: number, body: WorkerOutput): { code: string; message: string } {
  const detail = body.detail;
  if (detail && typeof detail === 'object' && typeof detail.code === 'string') {
    return { code: detail.code, message: String(detail.message || detail.code) };
  }
  const text = typeof detail === 'string' ? detail : body.error;
  return { code: status === 503 ? 'worker_unsupported' : 'worker_failed', message: text || `worker_http_${status}` };
}

export class JobRuntime {
  private running = new Map<string, AbortController>();
  private dispatching = false;
  /** Tail of the in-flight reconstruction request per capture id. */
  private readonly captureLocks = new Map<string, Promise<void>>();
  private readonly records: SpatialRecords;
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
      /** Make the preview and runtime derivatives as part of a reconstruction. On unless an operator turns it off. */
      autoDerivatives?: boolean;
    },
  ) {
    this.records = new SpatialRecords({ store: deps.store, kubo: deps.kubo });
  }

  /** Where every job's scratch space lives. Nothing here is ever a durable output. */
  private get workspaceRoot(): string {
    return path.join(this.deps.dataRoot, 'private', 'jobs');
  }

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
    await this.records.clearStaleRunning();
    // Whatever a previous process left behind is unreachable: a re-queued job
    // rebuilds its workspace from scratch (or from the preserved master), so
    // nothing in here is worth keeping and all of it is worth the disk back.
    await this.reclaimWorkspaces();
    this.schedule();
  }

  /** Removes every job workspace on disk. Called when nothing can be running. */
  async reclaimWorkspaces(): Promise<number> {
    let removed = 0;
    let entries: string[];
    try {
      entries = await fs.readdir(this.workspaceRoot);
    } catch {
      return 0;
    }
    for (const entry of entries) {
      if (this.running.has(entry)) continue;
      await fs.rm(path.join(this.workspaceRoot, entry), { recursive: true, force: true }).then(() => { removed += 1; }, (error) => {
        this.deps.logger.warn({ code: (error as NodeJS.ErrnoException).code }, 'could not remove a stale job workspace');
      });
    }
    return removed;
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

    if (DERIVATION_TYPES.includes(type)) return this.createDerivation(type, input);

    const captureId = typeof input.captureId === 'string' ? input.captureId : '';
    if (!captureId) throw localError(400, 'job_capture_required');
    this.deps.captureStore.get(captureId);

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
   * A derivative job regenerates the preview and/or runtime representation of a
   * scene whose master is already preserved. It never trains: it exists so a
   * failed derivative can be retried, a better optimiser can be applied later,
   * and a scene made before derivatives existed can be converted on request.
   */
  private async createDerivation(type: JobType, input: Record<string, unknown>): Promise<LocalJob> {
    const spatialId = typeof input.spatialId === 'string' ? input.spatialId : '';
    if (!spatialId) throw localError(400, 'job_spatial_required');
    const record = this.records.get(spatialId);
    if (!record.manifest.variants.some((variant) => variant.role === 'spatial_archive')) {
      // Without the master there is nothing to derive from, and inventing one
      // from a derivative would present a degraded copy as the original.
      throw localError(422, 'master_unavailable', { message: 'This scene has no preserved reconstruction to derive from.' });
    }
    const active = this.activeDerivation(this.deps.store.snapshot().jobs, spatialId);
    if (active) return structuredClone(active);
    const kinds = this.requestedKinds(type, input, record);
    if (kinds.length === 0) throw localError(409, 'derivatives_already_ready');
    return this.insert(type, { ...input, spatialId, captureId: record.manifest.captureId, derivatives: kinds });
  }

  private requestedKinds(type: JobType, input: Record<string, unknown>, record: SpatialStoreRecord): DerivativeKind[] {
    const defaults: DerivativeKind[] = type === 'spatial.generate_preview' ? ['preview'] : ['preview', 'runtime'];
    const asked = Array.isArray(input.derivatives)
      ? DERIVATIVE_ORDER.filter((kind) => (input.derivatives as unknown[]).includes(kind))
      : defaults;
    const summary = summarizeDerivatives(record);
    // `force` regenerates something that already exists, e.g. with a better optimiser.
    return asked.filter((kind) => input.force === true || summary[kind].state !== 'ready');
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
      if (!existing && DERIVATION_TYPES.includes(type)) existing = this.activeDerivation(state.jobs, String(input.spatialId));
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

  private activeDerivation(jobs: Record<string, unknown> | undefined, spatialId: string): LocalJob | undefined {
    return (Object.values(jobs || {}) as LocalJob[]).find((job) =>
      DERIVATION_TYPES.includes(job.type)
      && (job.input as { spatialId?: unknown } | undefined)?.spatialId === spatialId
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
    const workspace = path.join(this.workspaceRoot, id);
    const metrics: ProcessingEventExtra = {};
    let workspaceCreated = false;
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
      // A fresh workspace every time: a re-queued job must never inherit the
      // half-written files of the attempt a restart interrupted.
      await fs.rm(workspace, { recursive: true, force: true });
      await fs.mkdir(workspace, { recursive: true, mode: 0o700 });
      workspaceCreated = true;
      await this.patchJob(id, (current) => {
        current.state = 'running';
        current.startedAt = current.updatedAt = new Date().toISOString();
      });
      this.recordAnalytics('started');

      let record: SpatialStoreRecord;
      let master: string;
      if (job.type === 'spatial.reconstruct') {
        ({ record, master } = await this.reconstruct(job, workspace, controller, metrics));
      } else {
        record = this.records.get(String(job.input.spatialId));
        master = await this.materializeMaster(job.id, record, workspace);
      }

      const kinds = job.type === 'spatial.reconstruct'
        ? (this.deps.autoDerivatives === false ? [] : DERIVATIVE_ORDER)
        : (job.input.derivatives as DerivativeKind[]);
      record = await this.derive(job, record, workspace, master, kinds, controller, metrics);

      await this.stage(id, 'cleaning_workspace', 0.97, 'Removing temporary processing files');
      await this.removeWorkspace(id, workspace);
      const output = { ...record, derivativeSummary: summarizeDerivatives(record) };
      await this.patchJob(id, (current) => {
        current.state = 'completed'; current.stage = 'completed'; current.progress = 1; current.output = output as unknown as Record<string, unknown>;
        current.completedAt = current.updatedAt = new Date().toISOString();
        current.logs.push({ at: current.updatedAt, level: 'info', message: 'Spatial outputs imported into local Kubo' });
      });
      const finished = this.get(id);
      const outputBytes = record.manifest.variants.reduce((sum, variant) => sum + (variant.sizeBytes || 0), 0);
      let inputBytes = 0;
      try { inputBytes = this.deps.captureStore.get(String(record.manifest.captureId)).sizeBytes; } catch { /* the capture may have been removed since */ }
      this.recordAnalytics('completed', { ...metrics, durationMs: durationOf(finished), inputBytes, outputBytes });
    } catch (error) {
      // Whatever happened, the scratch space goes: a durable output is already
      // in Kubo, and anything that is not will be rebuilt by a retry.
      if (workspaceCreated) await this.removeWorkspace(id, workspace);
      // cancel() already finalized state, stage, and analytics before
      // aborting; this rejection is just that abort reaching here.
      if (this.get(id).state === 'cancelled') return;
      const aborted = controller.signal.aborted;
      const failure = error instanceof ImportError ? { code: error.code, message: error.message } : undefined;
      await this.patchJob(id, (current) => {
        current.state = aborted ? 'cancelled' : 'failed';
        current.stage = aborted ? 'cancelled' : 'failed';
        current.error = failure ?? { code: String((error as { code?: string }).code || (aborted ? 'cancelled' : 'job_failed')), message: String((error as Error).message || error) };
        current.completedAt = current.updatedAt = new Date().toISOString();
        current.logs.push({ at: current.updatedAt, level: aborted ? 'warn' : 'error', message: current.error.message });
      });
      this.recordAnalytics(aborted ? 'cancelled' : 'failed', { durationMs: durationOf(this.get(id)) });
      this.deps.logger.warn({ jobId: id, code: (error as { code?: string }).code }, 'spatial job stopped');
    }
  }

  /**
   * Trains the scene, imports the master into Kubo and creates the scene's
   * record. From the moment this returns the master is durable: whatever
   * happens to a derivative afterwards, the reconstruction is not lost.
   */
  private async reconstruct(
    job: LocalJob,
    workspace: string,
    controller: AbortController,
    metrics: ProcessingEventExtra,
  ): Promise<{ record: SpatialStoreRecord; master: string }> {
    const resumed = job.checkpoint?.spatialId ? this.records.find(job.checkpoint.spatialId) : undefined;
    if (resumed) {
      // A crash after the master was saved: the scene exists, only its
      // derivatives are missing. Training again would create a second scene.
      await this.patchJob(job.id, (current) => {
        current.logs.push({ at: new Date().toISOString(), level: 'info', message: 'Resuming from the preserved master after a restart' });
      });
      return { record: resumed, master: await this.materializeMaster(job.id, resumed, workspace) };
    }

    const capture = this.deps.captureStore.get(String(job.input.captureId));
    await this.stage(job.id, 'preparing_dataset', 0.05, 'Preparing dataset from capture');
    const dataset = await buildNerfstudioDataset(capture.directory, path.join(workspace, 'dataset'));
    await this.patchJob(job.id, (current) => {
      current.logs.push({
        at: new Date().toISOString(),
        level: 'info',
        message: `Dataset ready: ${dataset.frameCount} view(s)${dataset.droppedFrameCount ? `, ${dataset.droppedFrameCount} frame(s) dropped as unusable` : ''}`,
      });
    });

    await this.stage(job.id, 'starting_worker', 0.15, 'Starting spatial worker');
    // Training runs as a single blocking call in this worker version, so
    // there is no real interim percentage to report - an indeterminate
    // stage is honest, a fabricated one is not.
    await this.stage(job.id, 'training', null, 'Reconstructing (this can take a while; progress is not reported mid-run by this worker version)');
    const body = await this.callWorker(job.id, 'spatial.reconstruct', dataset.datasetDirectory, workspace, job.input, controller);

    await this.stage(job.id, 'importing', 0.8, 'Saving the reconstruction to local Kubo');
    const archiveItem = body.variants?.find((variant) => variant.role === 'spatial_archive');
    if (!archiveItem) throw Object.assign(new Error('Worker returned no reconstruction master'), { code: 'worker_output_invalid' });
    const archive = await importWorkerVariant(this.deps.kubo, workspace, archiveItem, 'spatial_archive');
    metrics.masterBytes = archive.sizeBytes;

    const id = crypto.randomUUID();
    const manifest: SpatialManifest = {
      schema: 'kubus.spatial/1', type: 'gaussianSplat', id,
      artworkId: String(job.input.artworkId || capture.artworkId || ''), markerId: String(job.input.markerId || capture.markerId || '') || undefined,
      captureId: capture.id, captureProvenance: { source: 'localCapture', captureId: capture.id }, capturedAt: capture.capturedAt,
      capturedBy: typeof job.input.capturedBy === 'string' ? job.input.capturedBy : undefined,
      variants: [archive], transform: body.transform,
      // The master is archival. Viewers choose a representation themselves and
      // fall back to the master only when the person asks for it.
      viewerDefaults: body.viewerDefaults ?? { quality: 'auto' },
      processing: body.processing as SpatialManifest['processing'],
      createdAt: new Date().toISOString(),
    };
    if (!manifest.artworkId) throw new Error('spatial_artwork_required');
    validateSpatialManifest(manifest);
    const record = await this.records.create(manifest);
    await this.patchJob(job.id, (current) => {
      current.checkpoint = { spatialId: id };
      current.logs.push({ at: new Date().toISOString(), level: 'info', message: 'Reconstruction master saved' });
    });
    return { record, master: archiveItem.path as string };
  }

  /** Brings a preserved master back from Kubo into the workspace; returns its path relative to the workspace. */
  private async materializeMaster(jobId: string, record: SpatialStoreRecord, workspace: string): Promise<string> {
    const archive = record.manifest.variants.find((variant) => variant.role === 'spatial_archive');
    if (!archive?.cid) throw Object.assign(new Error('This scene has no preserved reconstruction'), { code: 'master_unavailable' });
    await this.stage(jobId, 'preparing_master', 0.1, 'Retrieving the preserved reconstruction');
    await fs.mkdir(path.join(workspace, 'master'), { recursive: true });
    await this.deps.kubo.catToFile(archive.cid, path.join(workspace, 'master', 'master.ply'));
    return path.join('master', 'master.ply');
  }

  /**
   * Creates the requested derivatives one after another. A derivative that
   * fails is recorded against the scene and does not stop the others, and never
   * touches the master: each is independently retryable without training again.
   */
  private async derive(
    job: LocalJob,
    record: SpatialStoreRecord,
    workspace: string,
    master: string,
    kinds: DerivativeKind[],
    controller: AbortController,
    metrics: ProcessingEventExtra,
  ): Promise<SpatialStoreRecord> {
    let current = record;
    for (const kind of kinds) {
      if (controller.signal.aborted) break;
      if (summarizeDerivatives(current)[kind].state === 'ready' && job.input.force !== true) continue;
      const label = kind === 'preview' ? 'preview' : 'runtime representation';
      const health = this.deps.capabilities?.getWorkerHealth();
      if (health && !health.capabilities.includes(DERIVATIVE_CAPABILITY[kind])) {
        const error = { code: 'worker_cannot_derive', message: `This Node's worker cannot create the ${label}. Update the worker to enable it.` };
        await this.records.markDerivative(current.id, kind, { state: 'failed', jobId: job.id, at: new Date().toISOString(), error });
        await this.patchJob(job.id, (entry) => { entry.logs.push({ at: new Date().toISOString(), level: 'warn', message: error.message }); });
        current = this.records.get(current.id);
        continue;
      }
      await this.stage(job.id, DERIVATIVE_STAGE[kind], null, kind === 'preview' ? 'Creating the preview' : 'Optimizing for viewing');
      await this.records.markDerivative(current.id, kind, { state: 'running', jobId: job.id, at: new Date().toISOString() });
      try {
        const body = await this.callWorker(job.id, WORKER_TYPE[kind], workspace, workspace, { master }, controller);
        const item = body.variants?.find((variant) => variant.role === DERIVATIVE_ROLE[kind]);
        if (!item || !body.derivative) throw Object.assign(new Error(`Worker returned no ${label}`), { code: 'worker_output_invalid' });
        const variant = await importWorkerVariant(this.deps.kubo, workspace, item, DERIVATIVE_ROLE[kind]);
        current = await this.records.attachVariant(current.id, variant, kind, provenanceFrom(body.derivative, variant.sizeBytes));
        if (kind === 'preview') { metrics.previewBytes = variant.sizeBytes; metrics.previewMs = body.derivative.durationMs; }
        else { metrics.runtimeBytes = variant.sizeBytes; metrics.runtimeMs = body.derivative.durationMs; }
        await this.patchJob(job.id, (entry) => { entry.logs.push({ at: new Date().toISOString(), level: 'info', message: `The ${label} is ready (${variant.sizeBytes} bytes)` }); });
      } catch (error) {
        if (controller.signal.aborted) throw error;
        const failure = error instanceof ImportError
          ? { code: error.code, message: error.message }
          : { code: String((error as { code?: string }).code || 'derivative_failed'), message: String((error as Error).message || error) };
        await this.records.markDerivative(current.id, kind, { state: 'failed', jobId: job.id, at: new Date().toISOString(), error: failure });
        await this.patchJob(job.id, (entry) => { entry.logs.push({ at: new Date().toISOString(), level: 'warn', message: `The ${label} could not be created: ${failure.message}` }); });
        current = this.records.get(current.id);
      }
    }
    return current;
  }

  /** One call to the worker. Throws a coded error for any failure, carrying the worker's own code when it sent one. */
  private async callWorker(
    jobId: string,
    type: JobType,
    captureDirectory: string,
    outputDirectory: string,
    input: Record<string, unknown>,
    controller: AbortController,
  ): Promise<WorkerOutput> {
    const response = await fetch(`${this.deps.workerUrl}/v1/process`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Kubus-Worker-Authorization': await this.deps.workerAuth.issue(jobId, type) },
      signal: controller.signal,
      body: JSON.stringify({ jobId, type, captureDirectory, outputDirectory, input }),
    });
    const body = await response.json().catch(() => ({})) as WorkerOutput;
    if (!response.ok) {
      const failure = workerFailure(response.status, body);
      throw Object.assign(new Error(failure.message), { code: failure.code });
    }
    return body;
  }

  /** Deletes a job workspace, retrying briefly: a worker that was just cancelled can still hold a file open. */
  private async removeWorkspace(jobId: string, workspace: string): Promise<void> {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        await fs.rm(workspace, { recursive: true, force: true });
        return;
      } catch (error) {
        if (attempt === 2) this.deps.logger.warn({ jobId, code: (error as NodeJS.ErrnoException).code }, 'could not remove a job workspace; the next start will');
        else await new Promise((resolve) => setTimeout(resolve, 200 * (attempt + 1)));
      }
    }
  }

  private async stage(id: string, stage: JobStage, progress: number | null, message: string): Promise<void> {
    await this.patchJob(id, (current) => {
      current.stage = stage; current.progress = progress; current.updatedAt = new Date().toISOString();
      current.logs.push({ at: current.updatedAt, level: 'info', message });
    });
  }

  /**
   * Best-effort: analytics is a local, secondary concern. A write failure
   * here (disk full, permissions) must never fail or retry the job itself -
   * it is only logged.
   */
  private recordAnalytics(
    kind: 'started' | 'completed' | 'failed' | 'cancelled',
    extra: ProcessingEventExtra = {},
  ): void {
    if (!this.deps.analytics) return;
    this.deps.analytics.recordProcessingEvent(kind, extra).catch((error) => {
      this.deps.logger.warn({ code: (error as Error).message }, 'failed to record processing analytics');
    });
  }

  private async patchJob(id: string, mutate: (job: LocalJob) => void): Promise<void> {
    await this.deps.store.update((state) => {
      const job = state.jobs?.[id] as LocalJob | undefined;
      if (!job) throw localError(404, 'job_not_found');
      mutate(job);
    });
  }
}
