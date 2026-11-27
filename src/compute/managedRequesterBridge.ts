import crypto from 'node:crypto';
import { createReadStream, promises as fs } from 'node:fs';
import path from 'node:path';
import { KubusApiError, type KubusApiClient } from '../backend/kubusApiClient.js';
import type { ComputeCandidate, ManagedReconstruction, RemoteComputeJob } from '../backend/models.js';
import type { CaptureRecord, CaptureStore } from '../captures/captureStore.js';
import type { Logger } from '../logging/logger.js';
import type { WorkerAuthService } from '../spatial/workerAuth.js';
import { longWorkerFetch, workerFailure } from '../spatial/workerClient.js';
import { PRIVATE_OUTPUT_PROTOCOL, SPATIAL_OUTPUT_PROTOCOL, spatialOutputShape, type PrivateOutputCommitment } from './privateOutputTransport.js';
import { verifyProviderCleanupAttestation, type ProviderCleanupPayload } from './providerCleanupAttestation.js';
import type { PrivatePayloadTransport } from './privatePayloadTransport.js';
import type { RemoteComputeRuntime } from './remoteComputeRuntime.js';

/**
 * The Kubus-operated requester Node's side of the browser pilot.
 *
 * The backend binds each attempt to the walletless artist, the artwork and a source revision; this Node only sees
 * file digests and bytes. For each attempt it downloads and verifies the source files, prepares them on its own
 * worker (photos and clips to a masked, posed dataset, with per-input feedback), encrypts that dataset to an
 * eligible provider that supports `kubus.private-output/1` and `kubus.spatial-output/2`, verifies and stages the
 * encrypted result, acknowledges it, and uploads the signed full variant (and the lightweight one, when the provider
 * made it) as the artist's new private candidate. Raw photos and video never leave this
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

/** What this Node knows of one provider job's cleanup statement. Only a verified statement is ever recorded as a result. */
export interface ProviderCleanupRecord {
  jobId: string;
  providerNodeId: string;
  finalState: string;
  status: 'awaiting' | 'verified' | 'invalid' | 'unconfirmed';
  attempts: number;
  nextCheckAt?: string;
  since: string;
  /** What verifies the provider's statement later, taken from the job view while the job was this attempt's current one. */
  inputHash?: string;
  providerSigningPublicKey?: string;
  code?: string;
  attestation?: Pick<ProviderCleanupPayload, 'state' | 'items' | 'outputPins' | 'reason' | 'completedAt' | 'finalState'> & { verifiedAt: string };
}

interface LocalState {
  excludedProviders: string[];
  /** Providers whose result was the legacy raw-archive shape; they are excluded like any other and named in the final failure. */
  outdatedProviders?: string[];
  captureId?: string;
  inputBytes?: number;
  providerCleanups?: Record<string, ProviderCleanupRecord>;
  /** What this requester reported for its own cleanup of the attempt (`complete` or `failed`). */
  requesterCleanup?: 'complete' | 'failed';
}

/** The backend refuses a lightweight companion for a full file at or under this size; the full file serves as its own preview. */
export const LIGHTWEIGHT_MAX_BYTES = 20 * 1024 * 1024;
const ATTESTATION_RETRY_BASE_MS = 60_000;
const ATTESTATION_RETRY_MAX_MS = 30 * 60_000;
const ATTESTATION_GIVE_UP_MS = 48 * 60 * 60_000;

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
      await this.collectAttestations(nodeId).catch(error => this.deps.logger.warn({ code: 'managed_requester_attestation_scan_failed', error: String((error as Error)?.message || error) }, 'provider cleanup attestation scan failed'));
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
      await this.finish(nodeId, attempt.id, state.captureId, async () => { await fs.rm(work, { recursive: true, force: true }); });
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
    // Only a provider whose worker writes the full and lightweight variants (`kubus.spatial-output/2`) is eligible;
    // one that does not report it is a legacy provider and would return the raw training file.
    const provider = (Array.isArray(nodes) ? nodes : []).find(node =>
      node.privateOutputProtocol === PRIVATE_OUTPUT_PROTOCOL && node.spatialOutputProtocol === SPATIAL_OUTPUT_PROTOCOL);
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
      let reason: string | undefined;
      try {
        await this.deps.remote.stagePrivateOutput(job);
        // The commitment is signed and verified by the staging above; only now is its shape read.
        const shape = this.outputShape(job);
        if (shape.kind === 'legacy') { accepted = false; reason = 'provider_output_outdated'; }
        else if (shape.kind === 'invalid') { accepted = false; reason = 'output_verification_failed'; }
      } catch (error) {
        // A result that fails verification is disputed, never imported.
        accepted = false;
        reason = 'output_verification_failed';
        this.deps.logger.warn({ code: 'managed_requester_output_rejected', jobId: job.id, error: String((error as { code?: string }).code || (error as Error).message) }, 'provider output failed verification');
      }
      if (reason === 'provider_output_outdated') {
        this.deps.logger.warn({ code: 'managed_requester_output_outdated', jobId: job.id, providerNodeId: job.providerNodeId }, 'provider returned the legacy raw output and is excluded');
        const state = await this.readState(attempt.id);
        await this.writeState(attempt.id, { ...state, outdatedProviders: Array.from(new Set([...(state.outdatedProviders ?? []), job.providerNodeId])) });
      }
      const receipt = await this.deps.remote.signedAcknowledgement(job, accepted, reason);
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
    await this.trackProviderJob(attempt.id, job);
    if (excludedProviders.length >= (this.deps.maxProviderAttempts ?? 3)) {
      // Every provider that was tried returned the legacy output: say that, not a generic loss.
      const outdated = state.outdatedProviders ?? [];
      const code = excludedProviders.every(id => outdated.includes(id)) ? 'provider_output_outdated' : 'no_provider_completed';
      await this.deps.api.reconstructionCall(attempt.id, 'failure', { nodeId, code });
      await this.finish(nodeId, attempt.id, state.captureId);
      return;
    }
    await this.progress(nodeId, attempt, 'waiting_for_node', 'provider_lost');
  }

  /** The shape of the signed commitment the provider sealed (call only after the commitment has been verified). */
  private outputShape(job: RemoteComputeJob) {
    const commitment = (job.providerReceipt?.payload as { privateOutput?: Pick<PrivateOutputCommitment, 'blobs'> } | undefined)?.privateOutput;
    return commitment && Array.isArray(commitment.blobs) ? spatialOutputShape(commitment) : { kind: 'invalid' as const };
  }

  /**
   * Uploads the provider-signed full variant, and the lightweight one when there is one, as the artist's new private
   * candidate. Each file resumes at the server's own `receivedBytes`. Local files and the provider's input are released,
   * and requester cleanup is reported, only once the server says the attempt is `ready`.
   */
  private async importCandidate(nodeId: string, attempt: ManagedReconstruction, job: RemoteComputeJob): Promise<void> {
    const staged = await this.deps.remote.stagePrivateOutput(job);
    const shape = this.outputShape(job);
    // Never import what this requester did not acknowledge as accepted, nor a raw archive from a legacy provider.
    if (shape.kind === 'legacy') return this.failImport(nodeId, attempt, job, 'provider_output_outdated');
    if (shape.kind !== 'v2') return this.failImport(nodeId, attempt, job, 'provider_output_invalid');
    const binding = (staged.record as { binding?: unknown } | undefined)?.binding;
    const receipt = job.requesterReceipt as { payload?: { accepted?: unknown; jobId?: unknown; privateOutputBinding?: unknown } } | undefined;
    if (job.state !== 'COMPLETED' || receipt?.payload?.accepted !== true || receipt.payload.jobId !== job.id ||
        typeof binding !== 'string' || receipt.payload.privateOutputBinding !== binding) {
      this.deps.logger.warn({ code: 'managed_requester_completed_unacknowledged', jobId: job.id }, 'a completed job is not backed by this requester\'s acknowledgement of the staged output');
      return this.failImport(nodeId, attempt, job, 'provider_output_unverified');
    }
    const fullFile = path.join(staged.directory, 'spatial_mobile');
    const full = await sha256File(fullFile);
    let lightFile: string | undefined;
    let light: { sha256: string; size: number } | undefined;
    if (shape.lightweight) {
      lightFile = path.join(staged.directory, 'spatial_preview');
      light = await sha256File(lightFile);
      if (light.size > LIGHTWEIGHT_MAX_BYTES) return this.failImport(nodeId, attempt, job, 'provider_output_invalid');
      // The full file is within the limit: it is its own preview and the backend would refuse a companion.
      if (full.size <= LIGHTWEIGHT_MAX_BYTES) { lightFile = undefined; light = undefined; }
    }
    const created = await this.deps.api.reconstructionCall<{ reconstruction?: ManagedReconstruction; candidate: { receivedBytes?: number; state: string; lightweight?: { receivedBytes?: number; state: string } | null } }>(attempt.id, 'candidate', {
      nodeId, fileName: 'reconstruction.ply', format: 'ply', sizeBytes: full.size, sha256: full.sha256,
      ...(light ? { lightweight: { fileName: 'reconstruction-light.ply', format: 'ply', sizeBytes: light.size, sha256: light.sha256 } } : {}),
    });
    let reconstruction = created.reconstruction;
    reconstruction = await this.upload(nodeId, attempt, fullFile, full.size, created.candidate, undefined) ?? reconstruction;
    if (lightFile && light) {
      reconstruction = await this.upload(nodeId, attempt, lightFile, light.size, created.candidate.lightweight ?? { state: 'uploading', receivedBytes: 0 }, 'lightweight') ?? reconstruction;
    }
    if (reconstruction?.state !== 'ready') {
      // Not ready yet (a file is incomplete or the server has not finished): nothing is released; the next pass resumes.
      throw Object.assign(new Error('candidate_not_ready'), { code: 'candidate_not_ready' });
    }
    await this.trackProviderJob(attempt.id, job);
    const state = await this.readState(attempt.id);
    await this.finish(nodeId, attempt.id, state.captureId, async () => { await this.deps.remote.releaseInput(job); });
  }

  /** Sends one file's missing bytes, each next offset being the one the server reports. Returns the last reconstruction view. */
  private async upload(nodeId: string, attempt: ManagedReconstruction, file: string, size: number, start: { receivedBytes?: number; state: string }, variant: 'lightweight' | undefined): Promise<ManagedReconstruction | undefined> {
    let received = Number.isSafeInteger(start.receivedBytes) ? start.receivedBytes as number : 0;
    let finished = start.state === 'ready';
    let last: ManagedReconstruction | undefined;
    const handle = await fs.open(file, 'r');
    try {
      while (!finished && received < size) {
        const length = Math.min(attempt.chunkSizeBytes, size - received);
        const buffer = Buffer.alloc(length);
        await handle.read(buffer, 0, length, received);
        const result = await this.deps.api.appendReconstructionCandidate(attempt.id, received, buffer, nodeId, variant);
        last = result.reconstruction;
        const next = result.candidate.receivedBytes;
        // The server's count decides where the next chunk starts; a count that did not advance would loop forever.
        if (!Number.isSafeInteger(next) || (next as number) <= received || (next as number) > size) {
          throw Object.assign(new Error('candidate_progress_unreadable'), { code: 'candidate_progress_unreadable' });
        }
        received = next as number;
        finished = result.candidate.state === 'ready';
      }
    } finally { await handle.close(); }
    return last;
  }

  /** A result that cannot be imported ends the attempt as a provider failure; requester cleanup is still reported. */
  private async failImport(nodeId: string, attempt: ManagedReconstruction, job: RemoteComputeJob, code: string): Promise<void> {
    await this.trackProviderJob(attempt.id, job);
    await this.deps.api.reconstructionCall(attempt.id, 'failure', { nodeId, code });
    const state = await this.readState(attempt.id);
    await this.finish(nodeId, attempt.id, state.captureId, async () => { await this.deps.remote.releaseInput(job); });
  }

  private async cancel(nodeId: string, attempt: ManagedReconstruction): Promise<void> {
    let release: (() => Promise<void>) | undefined;
    if (attempt.computeJobId) {
      const job = await this.deps.api.reconstructionCall<RemoteComputeJob>(attempt.id, 'compute-job/cancel', { nodeId });
      await this.trackProviderJob(attempt.id, job);
      release = async () => { await this.deps.remote.releaseInput(job); };
    }
    const state = await this.readState(attempt.id);
    await this.deps.api.reconstructionCall(attempt.id, 'cancelled', { nodeId });
    await this.finish(nodeId, attempt.id, state.captureId, release);
  }

  /**
   * The attempt is over, whichever way it ended. Releases what this requester holds (the provider input pin, the
   * prepared capture, every work file but the source copies and the attempt's own record), then reports the outcome of
   * that cleanup (the staged provider result included). It is reported on every terminal path: ready, failed, needs more
   * views and cancelled.
   */
  private async finish(nodeId: string, id: string, captureId: string | undefined, release?: () => Promise<void>): Promise<void> {
    let outcome: 'complete' | 'failed' = 'complete';
    try {
      await release?.();
    } catch (error) {
      outcome = 'failed';
      this.deps.logger.warn({ code: 'managed_requester_input_release_failed', error: String((error as Error).message) }, 'encrypted input release requires retry');
    }
    try {
      // The provider's decrypted result, staged here to verify and import it, goes with the rest.
      for (const jobId of Object.keys((await this.readState(id)).providerCleanups ?? {})) {
        if (UUID.test(jobId)) await fs.rm(path.join(this.deps.dataRoot, 'private', 'remote-results', jobId), { recursive: true, force: true });
      }
      await this.purgeWork(id, captureId);
    } catch (error) {
      outcome = 'failed';
      this.deps.logger.warn({ code: 'managed_requester_work_purge_failed', error: String((error as Error).message) }, 'requester work files remain for retention');
    }
    await this.writeState(id, { ...(await this.readState(id)), requesterCleanup: outcome }).catch(() => undefined);
    await this.deps.api.reconstructionCall(id, 'cleanup', { nodeId, state: outcome })
      .catch(error => this.deps.logger.warn({ code: 'managed_requester_cleanup_report_failed', error: String((error as Error).message) }, 'requester cleanup could not be reported'));
  }

  /**
   * Remembers that a provider job ended and looks for the provider's cleanup statement. The statement arrives after the
   * job is terminal, usually after this attempt has finished, so what is not there yet is looked for again later.
   */
  private async trackProviderJob(id: string, job: RemoteComputeJob): Promise<void> {
    const state = await this.readState(id);
    const records = { ...(state.providerCleanups ?? {}) };
    records[job.id] ??= {
      jobId: job.id, providerNodeId: job.providerNodeId, finalState: job.state, status: 'awaiting', attempts: 0, since: new Date().toISOString(),
      ...(typeof job.inputHash === 'string' ? { inputHash: job.inputHash } : {}),
      ...(typeof job.verification?.providerSigningPublicKey === 'string' ? { providerSigningPublicKey: job.verification.providerSigningPublicKey } : {}),
    };
    await this.writeState(id, { ...state, providerCleanups: records });
    await this.recordAttestation(id, job);
  }

  /** Verifies the statement on a terminal job view against the provider's pinned key and records it; never trusts an unverified one. */
  private async recordAttestation(id: string, job: RemoteComputeJob): Promise<void> {
    const state = await this.readState(id);
    const current = state.providerCleanups?.[job.id];
    if (!current || current.status === 'invalid' || current.status === 'unconfirmed') return;
    // A verified `complete` statement is final. A verified `failed` one may be replaced by the provider's later
    // statement (the contract allows it once the step that failed has been done), so it keeps being looked at.
    const replaceable = current.status === 'verified' && current.attestation?.state === 'failed';
    if (current.status === 'verified' && !replaceable) return;
    const attestation = job.providerCleanup?.attestation;
    let next: ProviderCleanupRecord = { ...current, finalState: job.state };
    let changed = false;
    if (attestation) {
      try {
        const payload = verifyProviderCleanupAttestation(job, attestation);
        // A replacement never goes back in time, and the same statement again is nothing new.
        const stale = replaceable && Date.parse(payload.completedAt) <= Date.parse(current.attestation!.completedAt);
        if (!stale) {
          changed = true;
          next = { ...next, status: 'verified', code: undefined, nextCheckAt: payload.state === 'failed' ? new Date(Date.now() + ATTESTATION_RETRY_BASE_MS).toISOString() : undefined, attestation: { state: payload.state, items: payload.items, outputPins: payload.outputPins, reason: payload.reason, completedAt: payload.completedAt, finalState: payload.finalState, verifiedAt: new Date().toISOString() } };
        }
      } catch (error) {
        const code = String((error as { code?: string }).code || 'provider_cleanup_attestation_invalid');
        this.deps.logger.warn({ code, jobId: job.id }, 'provider cleanup attestation did not verify');
        // A replacement that does not verify leaves the statement that did verify in place.
        if (!replaceable) { changed = true; next = { ...next, status: 'invalid', code }; }
      }
    }
    if (!changed) {
      // Nothing new verified: keep looking with backoff, and stop at the end of the window.
      const attempts = current.attempts + 1;
      const age = Date.now() - Date.parse(current.since);
      if (age > ATTESTATION_GIVE_UP_MS) next = { ...next, attempts, nextCheckAt: undefined, ...(replaceable ? {} : { status: 'unconfirmed' as const }) };
      else next = { ...next, attempts, nextCheckAt: new Date(Date.now() + Math.min(ATTESTATION_RETRY_MAX_MS, ATTESTATION_RETRY_BASE_MS * 2 ** Math.min(attempts - 1, 6))).toISOString() };
    }
    await this.writeState(id, { ...state, providerCleanups: { ...state.providerCleanups, [job.id]: next } });
  }

  /** Looks again for provider statements that had not arrived when an attempt finished, or that may still be replaced. */
  async collectAttestations(nodeId: string): Promise<void> {
    const base = path.join(this.deps.dataRoot, 'private', 'reconstructions');
    for (const id of await fs.readdir(base).catch(() => [] as string[])) {
      if (!UUID.test(id)) continue;
      const state = await this.readState(id);
      for (const record of Object.values(state.providerCleanups ?? {})) {
        const age = Date.now() - Date.parse(record.since);
        const watching = record.status === 'awaiting' || (record.status === 'verified' && record.attestation?.state === 'failed' && age <= ATTESTATION_GIVE_UP_MS);
        if (!watching || (record.nextCheckAt && Date.parse(record.nextCheckAt) > Date.now())) continue;
        // Asked for by job id: an earlier, excluded provider job is no longer the attempt's current one.
        const fetched = await this.deps.api.getReconstructionComputeJob(id, nodeId, record.jobId).catch(() => null);
        const view = fetched && fetched.id === record.jobId ? fetched : null;
        // A backend that answers with the current job (it does not read the job id) cannot give an earlier job's statement:
        // the record says so instead of looking merely late, and nothing is verified from the other job.
        if (!view && fetched) await this.markViewUnavailable(id, record.jobId);
        // Verified against what was pinned while the job was current, never against a view of a different job.
        const verification = { ...(view?.verification ?? {}), ...(record.providerSigningPublicKey ? { providerSigningPublicKey: record.providerSigningPublicKey } : {}) };
        await this.recordAttestation(id, {
          ...(view ?? {}), id: record.jobId, providerNodeId: record.providerNodeId, state: record.finalState,
          ...(record.inputHash ? { inputHash: record.inputHash } : {}), verification,
        } as RemoteComputeJob);
      }
    }
  }

  /** Notes on an awaiting record that the backend could not return that job, so an incomplete record explains itself. */
  private async markViewUnavailable(id: string, jobId: string): Promise<void> {
    const state = await this.readState(id);
    const current = state.providerCleanups?.[jobId];
    if (!current || current.status !== 'awaiting' || current.code === 'provider_job_view_unavailable') return;
    await this.writeState(id, { ...state, providerCleanups: { ...state.providerCleanups, [jobId]: { ...current, code: 'provider_job_view_unavailable' } } });
  }

  /** Removes everything but the verified source copies, which retention removes later. */
  private async purgeWork(id: string, captureId?: string): Promise<void> {
    if (captureId) await this.deps.captures.removeRemote(captureId).catch(() => undefined);
    const root = this.root(id);
    for (const entry of await fs.readdir(root).catch(() => [] as string[])) {
      if (entry !== 'set' && entry !== 'state.json') await fs.rm(path.join(root, entry), { recursive: true, force: true });
    }
    // The attempt's record stays (provider statements, cleanup outcome) but no longer names a prepared capture.
    const kept = await this.readState(id);
    if (kept.captureId || kept.inputBytes !== undefined) {
      const { captureId: _captureId, inputBytes: _inputBytes, ...rest } = kept;
      await this.writeState(id, rest);
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
