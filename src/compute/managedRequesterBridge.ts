import crypto from 'node:crypto';
import { createReadStream, promises as fs } from 'node:fs';
import path from 'node:path';
import { KubusApiError, type KubusApiClient } from '../backend/kubusApiClient.js';
import type { ComputeCandidate, ManagedReconstruction, RemoteComputeJob } from '../backend/models.js';
import type { CaptureRecord, CaptureStore } from '../captures/captureStore.js';
import type { Logger } from '../logging/logger.js';
import type { WorkerAuthService } from '../spatial/workerAuth.js';
import { longWorkerFetch, workerFailure } from '../spatial/workerClient.js';
import { PRIVATE_OUTPUT_PROTOCOL } from './privateOutputTransport.js';
import type { PrivatePayloadTransport } from './privatePayloadTransport.js';
import type { RemoteComputeRuntime } from './remoteComputeRuntime.js';

/**
 * The Kubus-operated requester Node's side of the browser pilot.
 *
 * The backend binds each attempt to the walletless artist, the artwork and a source revision; this Node only sees
 * file digests and bytes. For each attempt it downloads and verifies the source files, prepares them on its own
 * worker (photos and clips to a masked, posed dataset, with per-input feedback), encrypts that dataset to an
 * eligible provider that supports `kubus.private-output/1`, verifies and stages the encrypted result, acknowledges
 * it, and uploads the signed variant as the artist's new private candidate. Raw photos and video never leave this
 * Node. Source copies stay until the backend's retention list says they may go (seven days after the last attempt).
 */

export type InputFeedback = { fileId: string; usable: boolean; usableViews: number | null; reason: string | null };

export type PrepareOutcome =
  | { ok: true; datasetDirectory: string; inputs: InputFeedback[]; sfm: Record<string, unknown> }
  | { ok: false; code: string; inputs: InputFeedback[]; details: Record<string, unknown> };

export interface ManagedRequesterDeps {
  api: Pick<KubusApiClient, 'claimReconstruction' | 'reconstructionRetention' | 'readReconstructionChunk' | 'reconstructionCall' | 'getReconstructionComputeJob' | 'appendReconstructionCandidate'>;
  nodeId: () => string | undefined;
  dataRoot: string;
  prepare: (input: { jobId: string; captureDirectory: string; outputDirectory: string; fileIds: Map<string, string> }) => Promise<PrepareOutcome>;
  captures: Pick<CaptureStore, 'registerRemote' | 'removeRemote'>;
  transport: Pick<PrivatePayloadTransport, 'encryptCapture'>;
  remote: Pick<RemoteComputeRuntime, 'signedAcknowledgement' | 'stagePrivateOutput' | 'releaseInput'>;
  logger: Logger;
  maxProviderAttempts?: number;
  intervalMs?: number;
}

interface LocalState { excludedProviders: string[]; captureId?: string; inputBytes?: number }

const FINISHED_JOB = new Set(['FAILED', 'EXPIRED', 'DECLINED', 'DISPUTED', 'CANCELLED']);
const EXTENSIONS: Record<string, string> = { jpeg: 'jpg', png: 'png', mp4: 'mp4', mov: 'mov' };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function bridgeCode(error: unknown): string | undefined {
  const details = error instanceof KubusApiError ? error.details as { code?: unknown } | undefined : undefined;
  return typeof details?.code === 'string' ? details.code : undefined;
}

async function sha256File(file: string): Promise<{ sha256: string; size: number }> {
  const hash = crypto.createHash('sha256');
  let size = 0;
  for await (const chunk of createReadStream(file)) { hash.update(chunk as Buffer); size += (chunk as Buffer).length; }
  return { sha256: hash.digest('hex'), size };
}

export class ManagedRequesterBridge {
  private timer?: NodeJS.Timeout;
  private running = false;
  private lastRetentionAt = 0;

  constructor(private readonly deps: ManagedRequesterDeps) {}

  start(): void {
    if (this.timer) return;
    const tick = () => void this.tick().catch(error => this.deps.logger.warn({ code: 'managed_requester_tick_failed', error: String((error as Error)?.message || error) }, 'managed requester tick failed'));
    this.timer = setInterval(tick, this.deps.intervalMs ?? 15_000);
    this.timer.unref();
    tick();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  private root(id: string): string {
    if (!UUID.test(id)) throw new Error('reconstruction_id_invalid');
    return path.join(this.deps.dataRoot, 'private', 'reconstructions', id);
  }

  /** One pass: purge expired copies, then claim (or resume) one attempt and move it as far as it can go. */
  async tick(): Promise<void> {
    if (this.running) return;
    const nodeId = this.deps.nodeId();
    if (!nodeId) return;
    this.running = true;
    try {
      if (Date.now() - this.lastRetentionAt > 10 * 60_000) await this.purgeExpired(nodeId);
      const attempt = await this.deps.api.claimReconstruction(nodeId);
      if (attempt) await this.advance(nodeId, attempt);
    } finally {
      this.running = false;
    }
  }

  async purgeExpired(nodeId: string): Promise<string[]> {
    const { purge } = await this.deps.api.reconstructionRetention(nodeId);
    for (const id of purge) {
      if (UUID.test(id)) await fs.rm(this.root(id), { recursive: true, force: true });
    }
    this.lastRetentionAt = Date.now();
    return purge;
  }

  async advance(nodeId: string, attempt: ManagedReconstruction): Promise<void> {
    try {
      if (attempt.cancelRequested) return await this.cancel(nodeId, attempt);
      if (attempt.state === 'preparing') {
        const prepared = await this.prepare(nodeId, attempt);
        if (!prepared) return;
        return await this.match(nodeId, attempt);
      }
      if (attempt.state === 'waiting_for_node') return await this.match(nodeId, attempt);
      if (attempt.state === 'processing') return await this.follow(nodeId, attempt);
      if (attempt.state === 'importing') return await this.importCandidate(nodeId, attempt, await this.deps.api.getReconstructionComputeJob(attempt.id, nodeId));
    } catch (error) {
      const code = bridgeCode(error);
      // The artist cancelled between two calls: the next claim carries the request and this pass ends.
      if (code === 'SPATIAL_RECONSTRUCTION_CANCEL_REQUESTED') return;
      throw error;
    }
  }

  private async readState(id: string): Promise<LocalState> {
    try { return JSON.parse(await fs.readFile(path.join(this.root(id), 'state.json'), 'utf8')) as LocalState; } catch { return { excludedProviders: [] }; }
  }

  private async writeState(id: string, state: LocalState): Promise<void> {
    await fs.mkdir(this.root(id), { recursive: true, mode: 0o700 });
    await fs.writeFile(path.join(this.root(id), 'state.json'), JSON.stringify(state), { mode: 0o600 });
  }

  /** Downloads every snapshot file once, verifying size and digest; a resumed attempt keeps verified files. */
  private async download(nodeId: string, attempt: ManagedReconstruction): Promise<{ set: string; fileIds: Map<string, string> }> {
    const set = path.join(this.root(attempt.id), 'set');
    const fileIds = new Map<string, string>();
    for (const file of attempt.files) {
      const folder = file.format === 'mp4' || file.format === 'mov' ? 'videos' : 'photos';
      const relative = `${folder}/${file.id}.${EXTENSIONS[file.format]}`;
      const target = path.join(set, relative);
      fileIds.set(relative, file.id);
      await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
      const existing = await sha256File(target).catch(() => null);
      if (existing?.sha256 === file.sha256 && existing.size === file.sizeBytes) continue;
      const partial = `${target}.partial`;
      await fs.rm(partial, { force: true });
      const hash = crypto.createHash('sha256');
      for (let offset = 0; offset < file.sizeBytes; offset += attempt.chunkSizeBytes) {
        const bytes = await this.deps.api.readReconstructionChunk(attempt.id, file.id, offset, nodeId);
        if (bytes.length !== Math.min(attempt.chunkSizeBytes, file.sizeBytes - offset)) throw Object.assign(new Error('source_chunk_size_mismatch'), { code: 'source_chunk_size_mismatch' });
        hash.update(bytes);
        await fs.appendFile(partial, bytes, { mode: 0o600 });
      }
      if (hash.digest('hex') !== file.sha256) {
        await fs.rm(partial, { force: true });
        throw Object.assign(new Error('source_digest_mismatch'), { code: 'source_digest_mismatch' });
      }
      await fs.rename(partial, target);
    }
    return { set, fileIds };
  }

  /** Returns true when a prepared capture is registered and ready to send. */
  private async prepare(nodeId: string, attempt: ManagedReconstruction): Promise<boolean> {
    const state = await this.readState(attempt.id);
    if (state.captureId) return true;
    await this.progress(nodeId, attempt, 'preparing', 'downloading_sources');
    const { set, fileIds } = await this.download(nodeId, attempt);
    await this.progress(nodeId, attempt, 'preparing', 'solving_poses');
    const work = path.join(this.root(attempt.id), `prepare-${attempt.attempt}`);
    await fs.rm(work, { recursive: true, force: true });
    await fs.mkdir(work, { recursive: true, mode: 0o700 });
    const outcome = await this.deps.prepare({ jobId: attempt.id, captureDirectory: set, outputDirectory: work, fileIds });
    if (!outcome.ok) {
      await this.deps.api.reconstructionCall(attempt.id, 'failure', { nodeId, code: outcome.code, feedback: this.feedback(outcome.inputs, outcome.details) });
      await fs.rm(work, { recursive: true, force: true });
      return false;
    }
    // The capture that leaves this Node: capture.json and the masked dataset, nothing else.
    const captureDirectory = path.join(this.root(attempt.id), 'capture');
    await fs.rm(captureDirectory, { recursive: true, force: true });
    await fs.mkdir(captureDirectory, { recursive: true, mode: 0o700 });
    await fs.rename(outcome.datasetDirectory, path.join(captureDirectory, 'dataset'));
    await fs.rm(work, { recursive: true, force: true });
    const files = await this.listFiles(captureDirectory);
    await fs.writeFile(path.join(captureDirectory, 'capture.json'), JSON.stringify({
      schema: 'kubus.capture/1', artworkId: attempt.artworkId, capturedAt: new Date().toISOString(), files: files.map(file => ({ path: file })),
    }), { mode: 0o600 });
    const captureId = `managed-${attempt.id}`;
    let sizeBytes = 0;
    for (const file of files) sizeBytes += (await fs.stat(path.join(captureDirectory, file))).size;
    const record: CaptureRecord = {
      id: captureId, schema: 'kubus.capture/1', state: 'stored', private: true, artworkId: attempt.artworkId, kind: 'prepared',
      capturedAt: new Date().toISOString(), createdAt: new Date().toISOString(), sizeBytes, fileCount: files.length + 1, directory: captureDirectory,
    } as CaptureRecord;
    await this.deps.captures.registerRemote(record);
    await this.writeState(attempt.id, { ...state, captureId, inputBytes: sizeBytes });
    await this.progress(nodeId, attempt, 'preparing', 'prepared', this.feedback(outcome.inputs, { usableViews: outcome.sfm.registeredViews, submittedViews: outcome.sfm.submittedViews }));
    return true;
  }

  private async listFiles(root: string, prefix = ''): Promise<string[]> {
    const out: string[] = [];
    for (const entry of await fs.readdir(path.join(root, prefix), { withFileTypes: true })) {
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) out.push(...await this.listFiles(root, relative));
      else if (entry.isFile()) out.push(relative);
    }
    return out.sort();
  }

  private feedback(inputs: InputFeedback[], details: Record<string, unknown>): Record<string, unknown> {
    const count = (value: unknown) => (Number.isSafeInteger(value) && (value as number) >= 0 ? value : undefined);
    return {
      submittedViews: count(details.submittedViews), usableViews: count(details.registeredViews ?? details.usableViews),
      requiredViews: count(details.requiredViews), inputs: inputs.map(item => ({ ...item, usableViews: item.usableViews ?? undefined, reason: item.reason ?? undefined })),
    };
  }

  private async progress(nodeId: string, attempt: ManagedReconstruction, state: 'preparing' | 'waiting_for_node' | 'processing', stage: string | null, feedback?: Record<string, unknown>): Promise<ManagedReconstruction> {
    const updated = await this.deps.api.reconstructionCall<ManagedReconstruction>(attempt.id, 'progress', { nodeId, state, stage, ...(feedback ? { feedback } : {}) });
    attempt.state = updated.state;
    attempt.cancelRequested = updated.cancelRequested;
    return updated;
  }

  /** Picks an eligible provider and sends it the encrypted dataset, or reports Waiting for a node. */
  private async match(nodeId: string, attempt: ManagedReconstruction): Promise<void> {
    const state = await this.readState(attempt.id);
    if (!state.captureId) {
      // Local copies were lost (disk replaced): prepare again from the backend's verified files.
      await this.progress(nodeId, attempt, 'preparing', null);
      if (!(await this.prepare(nodeId, attempt))) return;
      return this.match(nodeId, attempt);
    }
    const nodes = await this.deps.api.reconstructionCall<ComputeCandidate[]>(attempt.id, 'providers', {
      nodeId, inputBytes: state.inputBytes, excludeNodeIds: state.excludedProviders,
    });
    const provider = (Array.isArray(nodes) ? nodes : []).find(node => node.privateOutputProtocol === PRIVATE_OUTPUT_PROTOCOL);
    if (!provider) {
      // Also renews the lease while no eligible provider has capacity.
      await this.progress(nodeId, attempt, 'waiting_for_node', 'waiting_for_node');
      return;
    }
    const encrypted = await this.deps.transport.encryptCapture(state.captureId, provider.nodeId, provider.encryptionPublicKey);
    await this.deps.api.reconstructionCall(attempt.id, 'compute-job', {
      nodeId, providerNodeId: provider.nodeId, type: 'spatial.reconstruct',
      requirements: { qualityTier: 'standard', iterationTier: 'standard' }, ...encrypted,
      jobSpec: { ...encrypted.jobSpec, outputMode: PRIVATE_OUTPUT_PROTOCOL, inputMode: 'prepared' },
      expiresInSeconds: 86400,
    });
    attempt.state = 'processing';
  }

  /** Follows the provider's job; a lost or failed provider returns the attempt to matching with that node excluded. */
  private async follow(nodeId: string, attempt: ManagedReconstruction): Promise<void> {
    const job = await this.deps.api.getReconstructionComputeJob(attempt.id, nodeId);
    if (job.state === 'COMPLETED') return this.importCandidate(nodeId, attempt, job);
    if (job.state === 'OUTPUT_READY') {
      let accepted = true;
      try { await this.deps.remote.stagePrivateOutput(job); } catch (error) {
        // A result that fails verification is disputed, never imported.
        accepted = false;
        this.deps.logger.warn({ code: 'managed_requester_output_rejected', jobId: job.id, error: String((error as { code?: string }).code || (error as Error).message) }, 'provider output failed verification');
      }
      const receipt = await this.deps.remote.signedAcknowledgement(job, accepted, accepted ? undefined : 'output_verification_failed');
      const updated = await this.deps.api.reconstructionCall<RemoteComputeJob>(attempt.id, 'compute-job/acknowledge', { nodeId, accepted, receipt });
      if (updated.state === 'COMPLETED') return this.importCandidate(nodeId, attempt, updated);
      return this.providerLost(nodeId, attempt, updated);
    }
    if (FINISHED_JOB.has(job.state)) return this.providerLost(nodeId, attempt, job);
    await this.progress(nodeId, attempt, 'processing', job.state === 'RUNNING' ? 'training' : 'provider_accepting');
  }

  private async providerLost(nodeId: string, attempt: ManagedReconstruction, job: RemoteComputeJob): Promise<void> {
    await this.deps.remote.releaseInput(job);
    const state = await this.readState(attempt.id);
    const excludedProviders = Array.from(new Set([...state.excludedProviders, job.providerNodeId]));
    await this.writeState(attempt.id, { ...state, excludedProviders });
    if (excludedProviders.length >= (this.deps.maxProviderAttempts ?? 3)) {
      await this.deps.api.reconstructionCall(attempt.id, 'failure', { nodeId, code: 'no_provider_completed' });
      await this.purgeWork(attempt.id, state.captureId);
      return;
    }
    await this.progress(nodeId, attempt, 'waiting_for_node', 'provider_lost');
  }

  /** Uploads the provider-signed variant as the artist's new private candidate, resuming at the server's offset. */
  private async importCandidate(nodeId: string, attempt: ManagedReconstruction, job: RemoteComputeJob): Promise<void> {
    const { directory } = await this.deps.remote.stagePrivateOutput(job);
    const role = ['spatial_archive', 'spatial_mobile', 'spatial_preview'].find(name => (job.providerReceipt?.payload as { privateOutput?: { blobs?: Array<{ role: string }> } } | undefined)?.privateOutput?.blobs?.some(blob => blob.role === name));
    if (!role) throw Object.assign(new Error('private_output_variant_missing'), { code: 'private_output_variant_missing' });
    const file = path.join(directory, role);
    const { sha256, size } = await sha256File(file);
    const created = await this.deps.api.reconstructionCall<{ reconstruction: ManagedReconstruction; candidate: { receivedBytes: number; state: string } }>(attempt.id, 'candidate', {
      nodeId, fileName: 'reconstruction.ply', format: 'ply', sizeBytes: size, sha256,
    });
    let received = created.candidate.receivedBytes || 0;
    let finished = created.candidate.state === 'ready';
    const handle = await fs.open(file, 'r');
    try {
      while (!finished && received < size) {
        const length = Math.min(attempt.chunkSizeBytes, size - received);
        const buffer = Buffer.alloc(length);
        await handle.read(buffer, 0, length, received);
        const result = await this.deps.api.appendReconstructionCandidate(attempt.id, received, buffer, nodeId);
        received += length;
        finished = result.candidate.state === 'ready';
      }
    } finally { await handle.close(); }
    await this.deps.remote.releaseInput(job);
    const state = await this.readState(attempt.id);
    await this.purgeWork(attempt.id, state.captureId);
    await this.deps.api.reconstructionCall(attempt.id, 'cleanup', { nodeId, state: 'complete' }).catch(() => undefined);
  }

  private async cancel(nodeId: string, attempt: ManagedReconstruction): Promise<void> {
    if (attempt.computeJobId) {
      const job = await this.deps.api.reconstructionCall<RemoteComputeJob>(attempt.id, 'compute-job/cancel', { nodeId });
      await this.deps.remote.releaseInput(job).catch(error => this.deps.logger.warn({ code: 'managed_requester_input_release_failed', error: String((error as Error).message) }, 'encrypted input release requires retry'));
    }
    const state = await this.readState(attempt.id);
    await this.purgeWork(attempt.id, state.captureId);
    await this.deps.api.reconstructionCall(attempt.id, 'cancelled', { nodeId });
  }

  /** Removes everything but the verified source copies, which retention removes later. */
  private async purgeWork(id: string, captureId?: string): Promise<void> {
    if (captureId) await this.deps.captures.removeRemote(captureId).catch(() => undefined);
    const root = this.root(id);
    for (const entry of await fs.readdir(root).catch(() => [] as string[])) {
      if (entry !== 'set') await fs.rm(path.join(root, entry), { recursive: true, force: true });
    }
  }
}

/**
 * The prepare stage on this Node's own worker: `source_set` mode, faces always masked (the attempt is bound to an
 * artwork), stopping before training. Typed failures carry per-input feedback, mapped back to the backend's file ids.
 */
export function workerPrepare(deps: { workerUrl: string; workerAuth: WorkerAuthService }): ManagedRequesterDeps['prepare'] {
  return async ({ jobId, captureDirectory, outputDirectory, fileIds }) => {
    const health = await (await fetch(`${deps.workerUrl}/health`)).json() as { status?: string; inputModes?: unknown; workerInstanceId?: string; faceMasking?: unknown };
    if (health.status !== 'ready' || !Array.isArray(health.inputModes) || !health.inputModes.includes('source_set') || health.faceMasking !== true || !health.workerInstanceId) {
      throw Object.assign(new Error('The requester worker cannot prepare source sets; rebuild the worker image'), { code: 'worker_source_set_unsupported' });
    }
    const type = 'spatial.reconstruct';
    const response = await longWorkerFetch(`${deps.workerUrl}/v1/process`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Kubus-Worker-Authorization': await deps.workerAuth.issue(jobId, type) },
      body: JSON.stringify({ jobId, type, workerInstanceId: health.workerInstanceId, captureDirectory, outputDirectory, input: { mode: 'source_set', maskFaces: { photos: true, video: true } } }),
    });
    const body = await response.json().catch(() => ({})) as { prepared?: { path?: string; inputs?: unknown; sfm?: Record<string, unknown> }; detail?: { code?: string; details?: Record<string, unknown> } };
    const mapInputs = (raw: unknown): InputFeedback[] => (Array.isArray(raw) ? raw : []).flatMap(item => {
      const fileId = fileIds.get(String((item as { input?: unknown }).input));
      if (!fileId) return [];
      const entry = item as { usable?: unknown; usableViews?: unknown; reason?: unknown };
      return [{ fileId, usable: entry.usable === true, usableViews: Number.isSafeInteger(entry.usableViews) ? entry.usableViews as number : null,
        reason: typeof entry.reason === 'string' && /^[a-z_]{1,60}$/.test(entry.reason) ? entry.reason : null }];
    });
    if (!response.ok) {
      const typed = body.detail && typeof body.detail === 'object' ? body.detail : undefined;
      const code = typeof typed?.code === 'string' && /^[a-z_]{1,60}$/.test(typed.code) ? typed.code : workerFailure(body, response.status).code;
      return { ok: false, code, inputs: mapInputs(typed?.details?.inputs), details: typed?.details ?? {} };
    }
    const relative = String(body.prepared?.path || '');
    if (relative !== 'dataset') throw Object.assign(new Error('prepared_dataset_missing'), { code: 'prepared_dataset_missing' });
    return { ok: true, datasetDirectory: path.join(outputDirectory, relative), inputs: mapInputs(body.prepared?.inputs), sfm: body.prepared?.sfm ?? {} };
  };
}
