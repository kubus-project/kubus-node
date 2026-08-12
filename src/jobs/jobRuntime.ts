import crypto from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { CaptureStore } from '../captures/captureStore.js';
import type { KuboClient } from '../ipfs/kuboClient.js';
import { localError } from '../localApi/pairingService.js';
import type { Logger } from '../logging/logger.js';
import { validateSpatialManifest, type SpatialManifest, type SpatialVariant } from '../spatial/models.js';
import type { LocalStore } from '../state/localStore.js';
import type { NetworkParticipationGate } from '../participation/networkParticipationGate.js';
import type { WorkerAuthService } from '../spatial/workerAuth.js';
import type { CapabilityRegistry } from '../capabilities/registry.js';

export type JobType = 'spatial.reconstruct' | 'spatial.optimize' | 'spatial.generate_preview';
export type JobState = 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';
export interface LocalJob {
  id: string;
  type: JobType;
  capability: string;
  state: JobState;
  progress: number;
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

export class JobRuntime {
  private running = new Map<string, AbortController>();
  private dispatching = false;
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
    await this.deps.participationGate.assertUsefulOperation(type);
    if (!['spatial.reconstruct', 'spatial.optimize', 'spatial.generate_preview'].includes(type)) throw localError(400, 'job_type_unsupported');
    const captureId = typeof input.captureId === 'string' ? input.captureId : '';
    if (!captureId) throw localError(400, 'job_capture_required');
    this.deps.captureStore.get(captureId);
    const now = new Date().toISOString();
    const job: LocalJob = {
      id: crypto.randomUUID(), type, capability: capabilityFor(type), state: 'queued', progress: 0,
      input: structuredClone(input), createdAt: now, updatedAt: now,
      logs: [{ at: now, level: 'info', message: 'Job queued' }],
    };
    await this.deps.store.update((state) => { (state.jobs ??= {})[job.id] = job; });
    this.schedule();
    return job;
  }

  async cancel(id: string): Promise<LocalJob> {
    const job = this.get(id);
    if (['completed', 'failed', 'cancelled'].includes(job.state)) return job;
    this.running.get(id)?.abort();
    await this.patchJob(id, (current) => {
      current.state = 'cancelled';
      current.completedAt = current.updatedAt = new Date().toISOString();
      current.logs.push({ at: current.updatedAt, level: 'warn', message: 'Job cancelled' });
    });
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
      await this.deps.participationGate.assertUsefulOperation(this.get(id).type);
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
        current.state = 'running'; current.progress = 0.05; current.startedAt = current.updatedAt = new Date().toISOString();
        current.logs.push({ at: current.updatedAt, level: 'info', message: 'Spatial worker started' });
      });
      const response = await fetch(`${this.deps.workerUrl}/v1/process`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Kubus-Worker-Authorization': await this.deps.workerAuth.issue(id, job.type) }, signal: controller.signal,
        body: JSON.stringify({ jobId: id, type: job.type, captureDirectory: capture.directory, outputDirectory, input: job.input }),
      });
      const body = await response.json().catch(() => ({})) as WorkerOutput & { error?: string };
      if (!response.ok) throw Object.assign(new Error(body.error || `worker_http_${response.status}`), { code: response.status === 503 ? 'worker_unsupported' : 'worker_failed' });
      const spatial = await this.importOutputs(job, capture, outputDirectory, body);
      await this.patchJob(id, (current) => {
        current.state = 'completed'; current.progress = 1; current.output = spatial; current.completedAt = current.updatedAt = new Date().toISOString();
        current.logs.push({ at: current.updatedAt, level: 'info', message: 'Spatial outputs imported into local Kubo' });
      });
    } catch (error) {
      if (this.get(id).state === 'cancelled') return;
      const aborted = controller.signal.aborted;
      await this.patchJob(id, (current) => {
        current.state = aborted ? 'cancelled' : 'failed';
        current.error = { code: String((error as { code?: string }).code || (aborted ? 'cancelled' : 'job_failed')), message: String((error as Error).message || error) };
        current.completedAt = current.updatedAt = new Date().toISOString();
        current.logs.push({ at: current.updatedAt, level: aborted ? 'warn' : 'error', message: current.error.message });
      });
      this.deps.logger.warn({ jobId: id, code: (error as { code?: string }).code }, 'spatial job stopped');
    }
  }

  private async importOutputs(job: LocalJob, capture: ReturnType<CaptureStore['get']>, outputDirectory: string, output: WorkerOutput): Promise<Record<string, unknown>> {
    if (!Array.isArray(output.variants) || output.variants.length === 0) throw Object.assign(new Error('Worker returned no variants'), { code: 'worker_output_invalid' });
    const variants: SpatialVariant[] = [];
    for (const item of output.variants) {
      const target = path.resolve(outputDirectory, item.path);
      if (!target.startsWith(`${path.resolve(outputDirectory)}${path.sep}`)) throw new Error('worker_output_path_invalid');
      const bytes = await fs.readFile(target);
      const added = await this.deps.kubo.addBytes(bytes, path.basename(target));
      if (!added.Hash) throw new Error('kubo_add_missing_cid');
      variants.push({ role: item.role, cid: added.Hash, sizeBytes: bytes.byteLength, mimeType: item.mimeType, format: item.format, storageClass: item.storageClass });
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
