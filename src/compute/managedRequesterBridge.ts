import crypto from 'node:crypto';
import { createReadStream, promises as fs } from 'node:fs';
import path from 'node:path';
import { KubusApiError, type KubusApiClient } from '../backend/kubusApiClient.js';
import type { ComputeCandidate, ManagedReconstruction, RemoteComputeJob } from '../backend/models.js';
import type { CaptureRecord, CaptureStore } from '../captures/captureStore.js';
import type { Logger } from '../logging/logger.js';
import type { WorkerAuthService } from '../spatial/workerAuth.js';
import { longWorkerFetch, workerFailure } from '../spatial/workerClient.js';
import { PRIVATE_OUTPUT_PROTOCOL, SPATIAL_OUTPUT_PROTOCOL, isOutputVerificationFailure, spatialOutputShape, type PrivateOutputCommitment } from './privateOutputTransport.js';
import { verifyProviderCleanupAttestation, type ProviderCleanupPayload } from './providerCleanupAttestation.js';
import type { PrivatePayloadTransport } from './privatePayloadTransport.js';
import type { InputReleaseOutcome, RemoteComputeRuntime } from './remoteComputeRuntime.js';

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

/** `faceReview` is how many of the input's images the face masker flagged for a human look (absent when none). */
export type InputFeedback = { fileId: string; usable: boolean; usableViews: number | null; reason: string | null; faceReview?: number };

export type PrepareOutcome =
  | { ok: true; datasetDirectory: string; inputs: InputFeedback[]; sfm: Record<string, unknown> }
  | { ok: false; code: string; inputs: InputFeedback[]; details: Record<string, unknown> };

export interface ManagedRequesterDeps {
  api: Pick<KubusApiClient, 'claimReconstruction' | 'reconstructionRetention' | 'ackReconstructionRetention' | 'readReconstructionChunk' | 'reconstructionCall' | 'getReconstructionComputeJob' | 'appendReconstructionCandidate'>;
  nodeId: () => string | undefined;
  dataRoot: string;
  prepare: (input: { jobId: string; captureDirectory: string; outputDirectory: string; fileIds: Map<string, string> }) => Promise<PrepareOutcome>;
  /** Stops a prepare run on the worker and waits until it has quiesced; used for a run an earlier process started and never saw end. */
  cancelPrepare: (jobId: string) => Promise<void>;
  captures: Pick<CaptureStore, 'registerRemote' | 'removeRemote'>;
  transport: Pick<PrivatePayloadTransport, 'encryptCapture'>;
  remote: Pick<RemoteComputeRuntime, 'signedAcknowledgement' | 'stagePrivateOutput' | 'releaseInput' | 'releaseUnusedInput' | 'releaseInputsOwnedBy'>;
  logger: Logger;
  maxProviderAttempts?: number;
  intervalMs?: number;
  /** How often a long prepare renews the attempt's lease (the contract asks for at least every five minutes). */
  leaseRenewMs?: number;
  /** An unfinished attempt this Node has not advanced for this long can no longer be claimed in practice and is cleaned up. */
  abandonedAfterMs?: number;
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

/**
 * The encrypted job input made for one provider, kept until a job holds it. Encrypting picks a fresh key and so a fresh
 * CID, and every CID is pinned: a tick that encrypted again after a failed or unanswered `compute-job` call leaked one
 * pin per tick. The descriptor is reused verbatim for the same capture, provider and provider key (the backend answers a
 * repeated request for it with the same job), and released when it is replaced or the attempt ends. The key envelope is
 * wrapped to the provider's key and the file is private to this Node (0600); nothing here is ever logged.
 */
export interface PendingJobInput {
  captureId: string;
  providerNodeId: string;
  providerEncryptionPublicKey: string;
  inputCid: string;
  inputBytes: number;
  inputHash: string;
  inputKeyEnvelope: unknown;
  jobSpec: Record<string, unknown>;
}

interface LocalState {
  excludedProviders: string[];
  /** The encrypted input prepared for the provider this attempt is sending to; absent once a job holds it. */
  pendingInput?: PendingJobInput;
  /**
   * What still has to be released, retried until it is: input CIDs no job holds whose pin release failed or is switched
   * off, and `requester-input:` owners whose pin the process may have made before it died.
   */
  unusedInputs?: string[];
  /** Input CIDs jobs were created from. Never needed to send, only to release every pin the attempt owns when it is cleaned up. */
  heldInputs?: string[];
  /** The pin owner chosen for an input that is being encrypted; set before, cleared once the descriptor is stored. */
  encryptingOwner?: string;
  /** The worker job of a prepare run that has not answered yet, so a restarted Node can stop it before it starts another. */
  prepareJobId?: string;
  /** Provider jobs whose decrypted result was staged (or may have been) on this Node. */
  stagedJobs?: string[];
  /** When this Node last advanced the attempt (refreshed at most every five minutes). */
  lastAdvancedAt?: string;
  /** Providers whose result was the legacy raw-archive shape; they are excluded like any other and named in the final failure. */
  outdatedProviders?: string[];
  captureId?: string;
  inputBytes?: number;
  providerCleanups?: Record<string, ProviderCleanupRecord>;
  /** What this requester reported for its own cleanup of the attempt: everything released (`complete`), a pin still held because release is switched off (`pending`), or a step that failed (`failed`). */
  requesterCleanup?: 'complete' | 'pending' | 'failed';
}

/** The backend refuses a lightweight companion for a full file at or under this size; the full file serves as its own preview. */
export const LIGHTWEIGHT_MAX_BYTES = 20 * 1024 * 1024;
const ATTESTATION_RETRY_BASE_MS = 60_000;
const ATTESTATION_RETRY_MAX_MS = 30 * 60_000;
const ATTESTATION_GIVE_UP_MS = 48 * 60 * 60_000;
export const DEFAULT_LEASE_RENEW_MS = 4 * 60_000;
const DEFAULT_ABANDONED_AFTER_MS = 6 * 60 * 60_000;
const STAMP_EVERY_MS = 5 * 60_000;
const SWEEP_EVERY_MS = 60_000;
const ACK_BATCH = 100;
/** The provider worker refused a dataset flagged for a face review; the requester's attempt ends, no other provider is tried. */
const PROVIDER_FACE_REVIEW = 'provider_face_review_required';
type CleanupOutcome = 'complete' | 'pending' | 'failed';
const WORSE: Record<CleanupOutcome, number> = { complete: 0, pending: 1, failed: 2 };
const worse = (a: CleanupOutcome, b: CleanupOutcome): CleanupOutcome => (WORSE[b] > WORSE[a] ? b : a);

const FINISHED_JOB = new Set(['FAILED', 'EXPIRED', 'DECLINED', 'DISPUTED', 'CANCELLED']);
const EXTENSIONS: Record<string, string> = { jpeg: 'jpg', png: 'png', mp4: 'mp4', mov: 'mov' };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** The code of a provider job's failure, wherever the backend's job view carries it. */
function providerFailureCode(job: RemoteComputeJob): string | undefined {
  const failure = job.failure as { code?: unknown; reason?: unknown; metadata?: { code?: unknown } } | undefined;
  const code = failure?.code ?? failure?.metadata?.code ?? failure?.reason;
  return typeof code === 'string' ? code : undefined;
}

/** The worker's per-input feedback mapped to the backend's file ids; inputs the attempt does not know are left out. */
export function mapInputFeedback(raw: unknown, fileIds: Map<string, string>): InputFeedback[] {
  return (Array.isArray(raw) ? raw : []).flatMap(item => {
    const fileId = fileIds.get(String((item as { input?: unknown }).input));
    if (!fileId) return [];
    const entry = item as { usable?: unknown; usableViews?: unknown; reason?: unknown; faceReview?: unknown };
    return [{ fileId, usable: entry.usable === true, usableViews: Number.isSafeInteger(entry.usableViews) ? entry.usableViews as number : null,
      reason: typeof entry.reason === 'string' && /^[a-z_]{1,60}$/.test(entry.reason) ? entry.reason : null,
      ...(Number.isSafeInteger(entry.faceReview) && (entry.faceReview as number) > 0 ? { faceReview: entry.faceReview as number } : {}) }];
  });
}

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
  private lastSweepAt = 0;

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
      if (Date.now() - this.lastSweepAt > SWEEP_EVERY_MS) {
        this.lastSweepAt = Date.now();
        await this.sweep(nodeId).catch(error => this.deps.logger.warn({ code: 'managed_requester_sweep_failed', error: String((error as Error)?.message || error) }, 'requester cleanup sweep failed'));
      }
      const attempt = await this.deps.api.claimReconstruction(nodeId);
      if (attempt) await this.advance(nodeId, attempt);
    } finally {
      this.running = false;
    }
  }

  /**
   * Purges every attempt the backend lists as past retention, then tells the backend which ones are gone. An attempt is
   * acknowledged only after everything it held here is released: its input pins (unused and job-held), the decrypted
   * provider results staged for it, its prepared capture and its root. One whose pins cannot be released yet, or whose
   * record cannot be read, is kept and not acknowledged, so the next purge tries again. Returns the purged ids.
   */
  async purgeExpired(nodeId: string): Promise<string[]> {
    const { purge } = await this.deps.api.reconstructionRetention(nodeId);
    const purged: string[] = [];
    for (const id of purge) {
      if (!UUID.test(id)) continue;
      try {
        if (await this.purgeAttempt(id)) purged.push(id);
      } catch (error) {
        this.deps.logger.warn({ code: 'managed_requester_purge_failed', reconstructionId: id, error: String((error as Error)?.message || error) }, 'requester attempt could not be purged; it stays for the next pass');
      }
    }
    this.lastRetentionAt = Date.now();
    for (let offset = 0; offset < purged.length; offset += ACK_BATCH) {
      const batch = purged.slice(offset, offset + ACK_BATCH);
      await this.deps.api.ackReconstructionRetention(nodeId, batch)
        .catch(error => this.deps.logger.warn({ code: 'managed_requester_retention_ack_failed', error: String((error as Error)?.message || error) }, 'retention acknowledgement failed; the backend lists the attempts again'));
    }
    return purged;
  }

  private async purgeAttempt(id: string): Promise<boolean> {
    const directory = this.root(id);
    // Already gone: only the acknowledgement was lost.
    if (!(await fs.stat(directory).then(() => true, () => false))) return true;
    let state: LocalState;
    try { state = await this.readState(id); } catch (error) {
      if ((error as { code?: string })?.code !== 'reconstruction_state_unreadable') throw error;
      // What it holds (pins, staged results) cannot be known: it is left for review, neither purged nor acknowledged.
      // The raw sources are known and past retention, so they go regardless.
      this.deps.logger.warn({ code: 'reconstruction_state_unreadable', reconstructionId: id }, 'attempt record cannot be read; not purged');
      await this.removeSources(id);
      return false;
    }
    const outcome = await this.cleanupAttempt(id, state).catch(error => {
      this.deps.logger.warn({ code: 'managed_requester_purge_cleanup_failed', reconstructionId: id, error: String((error as Error)?.message || error) }, 'attempt cleanup failed during purge');
      return 'failed' as CleanupOutcome;
    });
    // The artist's raw photos and clips are deleted at retention whatever else is still held: a pin that cannot be released
    // (release switched off, Kubo down) keeps only the record, with the CID, unacknowledged, so the next pass retries it.
    await this.removeSources(id);
    if (outcome !== 'complete') return false;
    await fs.rm(directory, { recursive: true, force: true });
    return true;
  }

  /** Deletes the verified raw source copies of an attempt (the `set` directory); the record and everything else stay. */
  private async removeSources(id: string): Promise<void> {
    await fs.rm(path.join(this.root(id), 'set'), { recursive: true, force: true });
  }

  /**
   * Releases what an attempt still holds on this Node, whether or not it can ever be claimed again: every input pin it
   * owns (the retry list, job-held inputs and a stored descriptor), the decrypted provider results staged for it, its
   * prepared capture and its work files. The source copies and the record stay (retention removes them). Reports
   * `pending` when a pin is still held because pin release is switched off, `failed` when a step failed.
   */
  private async cleanupAttempt(id: string, state: LocalState): Promise<CleanupOutcome> {
    let outcome: CleanupOutcome = 'complete';
    const entries = Array.from(new Set([
      ...(state.unusedInputs ?? []), ...(state.heldInputs ?? []),
      ...(state.pendingInput ? [state.pendingInput.inputCid] : []), ...(state.encryptingOwner ? [state.encryptingOwner] : []),
    ]));
    for (const entry of entries) {
      const released = await this.releaseEntry(entry);
      if (released === 'released') await this.unlist(id, entry);
      else outcome = worse(outcome, released);
    }
    try {
      await this.removeStaged(id);
      await this.purgeWork(id, state.captureId);
    } catch (error) {
      outcome = 'failed';
      this.deps.logger.warn({ code: 'managed_requester_work_purge_failed', error: String((error as Error).message) }, 'requester work files remain for retention');
    }
    return outcome;
  }

  /**
   * Cleans up attempts that need it without anything claiming them: a finished attempt whose cleanup was reported as
   * pending or failed (retried, and reported again once it changes), and one that was never finished but that this Node
   * has not advanced for hours. The backend fails such an attempt once its lease lapses and never hands it out again,
   * so nothing else would remove its staged plaintext result or release its pins before retention.
   */
  async sweep(nodeId: string): Promise<void> {
    const base = path.join(this.deps.dataRoot, 'private', 'reconstructions');
    const abandonedAfter = this.deps.abandonedAfterMs ?? DEFAULT_ABANDONED_AFTER_MS;
    for (const id of await fs.readdir(base).catch(() => [] as string[])) {
      if (!UUID.test(id)) continue;
      const state = await this.readState(id).catch(() => null);
      if (!state || state.requesterCleanup === 'complete') continue;
      const finished = state.requesterCleanup !== undefined;
      const idle = state.lastAdvancedAt ? Date.now() - Date.parse(state.lastAdvancedAt) : 0;
      if (!finished && !(idle > abandonedAfter)) continue;
      const outcome = await this.cleanupAttempt(id, state);
      if (outcome === state.requesterCleanup) continue;
      await this.writeState(id, { ...(await this.readState(id)), requesterCleanup: outcome });
      await this.deps.api.reconstructionCall(id, 'cleanup', { nodeId, state: outcome })
        .catch(error => this.deps.logger.warn({ code: 'managed_requester_cleanup_report_failed', error: String((error as Error).message) }, 'requester cleanup could not be reported'));
    }
  }

  async advance(nodeId: string, attempt: ManagedReconstruction): Promise<void> {
    try {
      await this.stamp(attempt.id);
      if (attempt.cancelRequested) return await this.cancel(nodeId, attempt);
      if (attempt.state === 'preparing') {
        const prepared = await this.prepare(nodeId, attempt);
        if (!prepared) return;
        // The backend may have reported a cancel while the worker was busy.
        if (attempt.cancelRequested) return await this.cancel(nodeId, attempt);
        return await this.match(nodeId, attempt);
      }
      if (attempt.state === 'waiting_for_node') return await this.match(nodeId, attempt);
      if (attempt.state === 'processing') return await this.follow(nodeId, attempt);
      if (attempt.state === 'importing') return await this.importCandidate(nodeId, attempt, await this.deps.api.getReconstructionComputeJob(attempt.id, nodeId));
    } catch (error) {
      const code = bridgeCode(error);
      // The artist cancelled between two calls: the next claim carries the request and this pass ends.
      if (code === 'SPATIAL_RECONSTRUCTION_CANCEL_REQUESTED') return;
      // The record names what this Node holds for the attempt and cannot be rebuilt: the attempt is reported as failed (a
      // platform failure the operator may retry) instead of failing every claim until the lease lapses. The file stays.
      if ((error as { code?: string })?.code === 'reconstruction_state_unreadable') {
        this.deps.logger.warn({ code: 'reconstruction_state_unreadable', reconstructionId: attempt.id }, 'attempt record cannot be read; the attempt is reported as failed');
        await this.deps.api.reconstructionCall(attempt.id, 'failure', { nodeId, code: 'requester_unavailable' });
        return;
      }
      throw error;
    }
  }

  /** Remembers that this Node is working on the attempt, so one it stops advancing can be told from a live one. */
  private async stamp(id: string): Promise<void> {
    const state = await this.readState(id);
    if (state.lastAdvancedAt && Date.now() - Date.parse(state.lastAdvancedAt) < STAMP_EVERY_MS) return;
    await this.writeState(id, { ...state, lastAdvancedAt: new Date().toISOString() });
  }

  private async readState(id: string): Promise<LocalState> {
    let raw: string;
    try { raw = await fs.readFile(path.join(this.root(id), 'state.json'), 'utf8'); } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return { excludedProviders: [] };
      throw error;
    }
    // A record that cannot be read is never treated as a new attempt: it names the prepared capture and the unused input
    // pin, and starting over would orphan both. The file is left in place for review.
    try { return JSON.parse(raw) as LocalState; } catch {
      throw Object.assign(new Error('reconstruction_state_unreadable'), { code: 'reconstruction_state_unreadable' });
    }
  }

  private async writeState(id: string, state: LocalState): Promise<void> {
    await fs.mkdir(this.root(id), { recursive: true, mode: 0o700 });
    // Written next to the record and renamed over it, so a crash never leaves half a record behind.
    const target = path.join(this.root(id), 'state.json');
    const temporary = `${target}.${process.pid}.tmp`;
    try {
      await fs.writeFile(temporary, JSON.stringify(state), { mode: 0o600 });
      await fs.rename(temporary, target);
    } catch (error) {
      await fs.rm(temporary, { force: true }).catch(() => undefined);
      throw error;
    }
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

  /**
   * Keeps the attempt's lease while a long step runs. The worker can take over an hour to pose a set, and the backend
   * fails an attempt whose lease lapses, so the step reports progress on an interval for as long as it runs. A report
   * that fails is logged, never fatal; one that carries a cancel sets it on the attempt for the caller to act on.
   */
  private async withLease<T>(nodeId: string, attempt: ManagedReconstruction, stage: string, work: () => Promise<T>): Promise<T> {
    let busy = false;
    const timer = setInterval(() => {
      if (busy) return;
      busy = true;
      this.progress(nodeId, attempt, 'preparing', stage)
        .catch(error => this.deps.logger.warn({ code: 'managed_requester_lease_renewal_failed', error: String((error as Error)?.message || error) }, 'lease renewal failed'))
        .finally(() => { busy = false; });
    }, this.deps.leaseRenewMs ?? DEFAULT_LEASE_RENEW_MS);
    timer.unref();
    try { return await work(); } finally { clearInterval(timer); }
  }

  /** Reports a prepared set that must not be sent, drops what was prepared, and reports the requester cleanup. */
  private async failPrepared(nodeId: string, attempt: ManagedReconstruction, code: string, inputs: InputFeedback[], details: Record<string, unknown>, captureId?: string): Promise<void> {
    await this.deps.api.reconstructionCall(attempt.id, 'failure', { nodeId, code, feedback: this.feedback(inputs, details) });
    await this.finish(nodeId, attempt.id, captureId);
  }

  /**
   * The face-review gate for a prepared dataset: reads `prepared.json` (the worker's record of what it masked and what the
   * masker flagged for a human look) and answers whether the dataset may leave this Node. A dataset with any flagged image,
   * or whose record is missing, unreadable or does not show that masking ran, is not sent to anyone.
   */
  private async faceGate(datasetDirectory: string): Promise<{ kind: 'clean' } | { kind: 'flagged'; flagged: number } | { kind: 'unverified' }> {
    let record: { faceMasking?: unknown };
    try { record = JSON.parse(await fs.readFile(path.join(datasetDirectory, 'prepared.json'), 'utf8')); } catch { return { kind: 'unverified' }; }
    const masking = record && typeof record === 'object' ? record.faceMasking : undefined;
    if (!masking || typeof masking !== 'object') return { kind: 'unverified' };
    const parts = [(masking as Record<string, unknown>).photos, (masking as Record<string, unknown>).video].filter(part => part && typeof part === 'object') as Array<{ needsLook?: unknown }>;
    if (!parts.length) return { kind: 'unverified' };
    const count = (value: unknown) => (typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0);
    let flagged = 0;
    for (const part of parts) {
      const look = part.needsLook as { images?: unknown; weakExcluded?: unknown; largeBelowCertain?: unknown; items?: unknown; itemsTruncated?: unknown } | undefined;
      if (!look || typeof look !== 'object') return { kind: 'unverified' };
      flagged += Math.max(count(look.images), count(look.weakExcluded), count(look.largeBelowCertain), Array.isArray(look.items) ? look.items.length : 0, look.itemsTruncated ? 1 : 0);
    }
    return flagged ? { kind: 'flagged', flagged } : { kind: 'clean' };
  }

  /** The files that were uploaded for an attempt, by the relative path they are stored under. */
  private fileIdsOf(attempt: ManagedReconstruction): Map<string, string> {
    return new Map(attempt.files.map(file => [`${file.format === 'mp4' || file.format === 'mov' ? 'videos' : 'photos'}/${file.id}.${EXTENSIONS[file.format]}`, file.id]));
  }

  /** The feedback for a dataset flagged for a face review: each file with flagged images says so (`face_review`), the others stay as they were. */
  private faceReviewInputs(inputs: InputFeedback[]): InputFeedback[] {
    return inputs.map(item => (item.faceReview ? { ...item, usable: false, reason: 'face_review' } : item));
  }

  /** Returns true when a prepared capture is registered and ready to send. */
  private async prepare(nodeId: string, attempt: ManagedReconstruction): Promise<boolean> {
    let state = await this.readState(attempt.id);
    if (state.captureId) return true;
    if (state.prepareJobId) {
      // A run an earlier process started and never saw end may still be writing into the work directory: it is stopped
      // (and waited for) before the directory is touched. When the worker cannot be asked, the pass fails and is retried.
      await this.deps.cancelPrepare(state.prepareJobId);
      const { prepareJobId: _stopped, ...rest } = await this.readState(attempt.id);
      state = rest;
      await this.writeState(attempt.id, state);
    }
    await this.progress(nodeId, attempt, 'preparing', 'downloading_sources');
    const { set, fileIds } = await this.withLease(nodeId, attempt, 'downloading_sources', () => this.download(nodeId, attempt));
    await this.progress(nodeId, attempt, 'preparing', 'solving_poses');
    const work = path.join(this.root(attempt.id), `prepare-${attempt.attempt}`);
    await fs.rm(work, { recursive: true, force: true });
    await fs.mkdir(work, { recursive: true, mode: 0o700 });
    // Each run has its own worker job id: the worker refuses a second run of an id that is still active, and a run that
    // outlived its Node is found again through this record.
    const prepareJobId = crypto.randomUUID();
    await this.writeState(attempt.id, { ...state, prepareJobId });
    const outcome = await this.withLease(nodeId, attempt, 'solving_poses', () => this.deps.prepare({ jobId: prepareJobId, captureDirectory: set, outputDirectory: work, fileIds }));
    // An answer, whichever it is: nothing is left running under this id.
    const { prepareJobId: _answered, ...answered } = await this.readState(attempt.id);
    await this.writeState(attempt.id, answered);
    state = answered;
    if (!outcome.ok) {
      await this.deps.api.reconstructionCall(attempt.id, 'failure', { nodeId, code: outcome.code, feedback: this.feedback(outcome.inputs, outcome.details) });
      await this.finish(nodeId, attempt.id, state.captureId);
      return false;
    }
    // Nothing leaves this Node with an image the face masker flagged for a human look, or that nobody checked.
    const gate = await this.faceGate(outcome.datasetDirectory);
    if (gate.kind !== 'clean') {
      this.deps.logger.warn({ code: gate.kind === 'flagged' ? 'managed_requester_face_review_required' : 'managed_requester_face_masking_unverified', reconstructionId: attempt.id }, 'prepared dataset is not sent');
      const details = { submittedViews: outcome.sfm.submittedViews, usableViews: outcome.sfm.registeredViews };
      await this.failPrepared(nodeId, attempt, gate.kind === 'flagged' ? 'face_review_required' : 'face_masking_failed', gate.kind === 'flagged' ? this.faceReviewInputs(outcome.inputs) : outcome.inputs, details, state.captureId);
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
      requiredViews: count(details.requiredViews), inputs: inputs.map(item => ({ fileId: item.fileId, usable: item.usable, usableViews: item.usableViews ?? undefined, reason: item.reason ?? undefined })),
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
    // A prepared capture kept from before the gate existed (or one that changed on disk) is checked again before any
    // provider is asked for: the dataset in the capture is what would be encrypted.
    const gate = await this.faceGate(path.join(this.root(attempt.id), 'capture', 'dataset'));
    if (gate.kind !== 'clean') {
      this.deps.logger.warn({ code: gate.kind === 'flagged' ? 'managed_requester_face_review_required' : 'managed_requester_face_masking_unverified', reconstructionId: attempt.id }, 'prepared dataset is not sent');
      const inputs = await this.storedInputs(attempt);
      await this.failPrepared(nodeId, attempt, gate.kind === 'flagged' ? 'face_review_required' : 'face_masking_failed', gate.kind === 'flagged' ? this.faceReviewInputs(inputs) : inputs, {}, state.captureId);
      return;
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
    const encrypted = await this.inputFor(nodeId, attempt.id, state, provider);
    await this.deps.api.reconstructionCall(attempt.id, 'compute-job', {
      nodeId, providerNodeId: encrypted.providerNodeId, type: 'spatial.reconstruct',
      requirements: { qualityTier: 'standard', iterationTier: 'standard' },
      inputCid: encrypted.inputCid, inputBytes: encrypted.inputBytes, inputHash: encrypted.inputHash, inputKeyEnvelope: encrypted.inputKeyEnvelope,
      jobSpec: { ...encrypted.jobSpec, outputMode: PRIVATE_OUTPUT_PROTOCOL, inputMode: 'prepared' },
      expiresInSeconds: 86400,
    });
    // The job holds the input now (and releases it with the job); it is no longer an unused one.
    await this.clearPendingInput(attempt.id, encrypted.inputCid);
    attempt.state = 'processing';
  }

  /** The per-input feedback the worker recorded in the stored dataset's `prepared.json`, mapped to the backend's file ids. */
  private async storedInputs(attempt: ManagedReconstruction): Promise<InputFeedback[]> {
    try {
      const record = JSON.parse(await fs.readFile(path.join(this.root(attempt.id), 'capture', 'dataset', 'prepared.json'), 'utf8')) as { inputs?: unknown };
      return mapInputFeedback(record.inputs, this.fileIdsOf(attempt));
    } catch { return []; }
  }

  /**
   * The encrypted input for this provider: the stored one when it was made for the same capture, provider and provider
   * key, otherwise a new one, after the stored one (made for something else) has been released. A stored input is only
   * "never sent" when the backend has no job holding it: a request whose answer was lost still created the job, so
   * before releasing, the attempt's job is asked for. When one holds the stored input it is returned as it is (its
   * `providerNodeId` is the job's provider) and the repeated request binds the same job to the attempt.
   */
  private async inputFor(nodeId: string, id: string, state: LocalState, provider: ComputeCandidate): Promise<PendingJobInput> {
    // A pin owner chosen for an encryption that never stored its descriptor (the process died, or the transport failed):
    // whatever was pinned under it is released like any unused input.
    await this.listInterruptedOwner(id);
    await this.retryUnusedInputs(id);
    const stored = state.pendingInput;
    if (stored && stored.captureId === state.captureId && stored.providerNodeId === provider.nodeId && stored.providerEncryptionPublicKey === provider.encryptionPublicKey) return stored;
    if (stored) {
      if (await this.jobHoldingInput(nodeId, id, stored.inputCid)) return stored;
      // Moved to the retry list before the release is tried, so a failing release neither blocks matching nor loses the pin.
      const current = await this.readState(id);
      await this.writeState(id, { ...current, pendingInput: undefined, unusedInputs: Array.from(new Set([...(current.unusedInputs ?? []), stored.inputCid])) });
      await this.releaseListed(id, stored.inputCid);
    }
    // The pin's owner is recorded before the ciphertext is made, so a crash between pinning and storing the descriptor
    // cannot leave a pin nothing names: the next pass releases it by owner.
    const pinOwner = `requester-input:${crypto.randomUUID()}`;
    await this.writeState(id, { ...(await this.readState(id)), encryptingOwner: pinOwner });
    const made = await this.deps.transport.encryptCapture(state.captureId!, provider.nodeId, provider.encryptionPublicKey, { pinOwner });
    const input: PendingJobInput = {
      captureId: state.captureId!, providerNodeId: provider.nodeId, providerEncryptionPublicKey: provider.encryptionPublicKey,
      inputCid: made.inputCid, inputBytes: made.inputBytes, inputHash: made.inputHash, inputKeyEnvelope: made.inputKeyEnvelope, jobSpec: made.jobSpec,
    };
    // Written before the request that uses it, so a failed or unanswered request (or a restart) finds it again.
    await this.writeState(id, { ...(await this.readState(id)), pendingInput: input, encryptingOwner: undefined });
    return input;
  }

  /**
   * The attempt's provider job when it was created from this input, otherwise null. Also null for a backend that has no
   * job for the attempt (404). Any other failure propagates: whether a job holds the input is then unknown, and an
   * input is released only when it is known that none does.
   */
  private async jobHoldingInput(nodeId: string, id: string, inputCid: string): Promise<RemoteComputeJob | null> {
    let held: RemoteComputeJob | null | undefined;
    try { held = await this.deps.api.getReconstructionComputeJob(id, nodeId); } catch (error) {
      if (error instanceof KubusApiError && error.status === 404) return null;
      throw error;
    }
    return held && typeof held.inputCid === 'string' && held.inputCid === inputCid ? held : null;
  }

  /**
   * Releases one listed entry: an input CID, or a `requester-input:` owner (whatever was pinned under it). `released`
   * when it is gone, `pending` when a pin is still held because pin release is switched off, `failed` when it threw.
   */
  private async releaseEntry(entry: string): Promise<'released' | 'pending' | 'failed'> {
    try {
      const outcome: InputReleaseOutcome | void = entry.startsWith('requester-input:') ? await this.deps.remote.releaseInputsOwnedBy(entry) : await this.deps.remote.releaseUnusedInput(entry);
      return outcome && outcome.released === false ? 'pending' : 'released';
    } catch (error) {
      this.deps.logger.warn({ code: 'managed_requester_input_release_failed', error: String((error as { code?: string }).code || (error as Error).message) }, 'unused encrypted input release requires retry');
      return 'failed';
    }
  }

  private async unlist(id: string, entry: string): Promise<void> {
    const state = await this.readState(id).catch(() => null);
    if (!state?.unusedInputs?.includes(entry)) return;
    await this.writeState(id, { ...state, unusedInputs: state.unusedInputs.filter(item => item !== entry) });
  }

  /** Moves the pin owner of an interrupted encryption to the retry list, so whatever was pinned under it is released. */
  private async listInterruptedOwner(id: string): Promise<void> {
    const current = await this.readState(id);
    if (!current.encryptingOwner) return;
    await this.writeState(id, { ...current, encryptingOwner: undefined, unusedInputs: Array.from(new Set([...(current.unusedInputs ?? []), current.encryptingOwner])) });
  }

  /** Puts an entry on the retry list (every pass and the sweep try it again until it is released). */
  private async list(id: string, entry: string): Promise<void> {
    const state = await this.readState(id);
    if (state.unusedInputs?.includes(entry)) return;
    await this.writeState(id, { ...state, unusedInputs: [...(state.unusedInputs ?? []), entry] });
  }

  /** Releases one listed entry; one that is not released stays listed for the next try. */
  private async releaseListed(id: string, entry: string): Promise<'released' | 'pending' | 'failed'> {
    const released = await this.releaseEntry(entry);
    if (released === 'released') await this.unlist(id, entry);
    return released;
  }

  /** Tries every listed entry again. `failed` when any threw, else `pending` when any is still held, else `released`. */
  private async retryUnusedInputs(id: string): Promise<'released' | 'pending' | 'failed'> {
    let result: 'released' | 'pending' | 'failed' = 'released';
    for (const entry of (await this.readState(id)).unusedInputs ?? []) {
      const released = await this.releaseListed(id, entry);
      if (released === 'failed') result = 'failed';
      else if (released === 'pending' && result !== 'failed') result = 'pending';
    }
    return result;
  }

  /** Remembers that a job holds the stored input from now on (it is released with the job, or when the attempt is cleaned up). */
  private async clearPendingInput(id: string, onlyCid: string | undefined): Promise<void> {
    if (typeof onlyCid !== 'string' || !onlyCid) return;
    const state = await this.readState(id);
    if (!state.pendingInput || state.pendingInput.inputCid !== onlyCid) return;
    await this.writeState(id, { ...state, pendingInput: undefined, heldInputs: Array.from(new Set([...(state.heldInputs ?? []), onlyCid])) });
  }

  /** Records that a provider job's result is, or may be, staged here, so cleaning the attempt up finds and removes it. */
  private async noteStaged(id: string, jobId: string): Promise<void> {
    const state = await this.readState(id);
    if (state.stagedJobs?.includes(jobId)) return;
    await this.writeState(id, { ...state, stagedJobs: [...(state.stagedJobs ?? []), jobId] });
  }

  /** Removes the decrypted provider results staged for an attempt's jobs. */
  private async removeStaged(id: string): Promise<void> {
    const state = await this.readState(id);
    for (const jobId of new Set([...Object.keys(state.providerCleanups ?? {}), ...(state.stagedJobs ?? [])])) {
      if (UUID.test(jobId)) await fs.rm(path.join(this.deps.dataRoot, 'private', 'remote-results', jobId), { recursive: true, force: true });
    }
  }

  /** Follows the provider's job; a lost or failed provider returns the attempt to matching with that node excluded. */
  private async follow(nodeId: string, attempt: ManagedReconstruction): Promise<void> {
    const job = await this.deps.api.getReconstructionComputeJob(attempt.id, nodeId);
    // A request whose answer was lost still created the job: its input is the job's now, whatever the state recorded.
    await this.clearPendingInput(attempt.id, job.inputCid);
    if (job.state === 'COMPLETED') return this.importCandidate(nodeId, attempt, job);
    if (job.state === 'OUTPUT_READY') {
      let accepted = true;
      let reason: string | undefined;
      try {
        await this.noteStaged(attempt.id, job.id);
        await this.deps.remote.stagePrivateOutput(job);
        // The commitment is signed and verified by the staging above; only now is its shape read.
        const shape = this.outputShape(job);
        if (shape.kind === 'legacy') { accepted = false; reason = 'provider_output_outdated'; }
        else if (shape.kind === 'invalid') { accepted = false; reason = 'output_verification_failed'; }
      } catch (error) {
        // Only a result that is wrong is disputed (a dispute ends the provider's job for good, and its sealed outputs go
        // with it). A fetch that timed out or a full disk or a Kubo that is down says nothing about the result: that is
        // retried on a later pass without acknowledging anything.
        if (!isOutputVerificationFailure(error)) throw error;
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
    if (FINISHED_JOB.has(job.state)) {
      // The provider's worker refused the dataset for a face review: the dataset must not go to anyone else either.
      if (providerFailureCode(job) === PROVIDER_FACE_REVIEW) {
        // The requester passed its own gate on this dataset before sending it, so a refusal it cannot confirm says something
        // about the provider, not the artist's files: that provider is lost like any other. Only a flagged (or no longer
        // verifiable) local record ends the attempt.
        const gate = await this.faceGate(path.join(this.root(attempt.id), 'capture', 'dataset'));
        if (gate.kind === 'clean') {
          this.deps.logger.warn({ code: 'managed_requester_provider_face_review_unconfirmed', jobId: job.id, providerNodeId: job.providerNodeId }, 'a provider reported a face review that the local dataset does not show; it is treated as lost');
          return this.providerLost(nodeId, attempt, job);
        }
        return this.faceReviewRefused(nodeId, attempt, job, gate.kind === 'flagged');
      }
      return this.providerLost(nodeId, attempt, job);
    }
    await this.progress(nodeId, attempt, 'processing', job.state === 'RUNNING' ? 'training' : 'provider_accepting');
  }

  /** A provider refused a dataset the requester's own check also flags (or can no longer verify): terminal. No provider is excluded and none is tried next. */
  private async faceReviewRefused(nodeId: string, attempt: ManagedReconstruction, job: RemoteComputeJob, flagged: boolean): Promise<void> {
    this.deps.logger.warn({ code: 'managed_requester_provider_face_review_required', jobId: job.id, providerNodeId: job.providerNodeId }, 'a provider refused the dataset for a face review; the attempt ends');
    await this.trackProviderJob(attempt.id, job);
    // A flagged local record names the files to look at; one that cannot be read any more has nothing to say about them.
    const feedback = flagged ? this.feedback(this.faceReviewInputs(await this.storedInputs(attempt)), {}) : undefined;
    await this.deps.api.reconstructionCall(attempt.id, 'failure', { nodeId, code: 'face_review_required', ...(feedback ? { feedback } : {}) });
    const state = await this.readState(attempt.id);
    await this.finish(nodeId, attempt.id, state.captureId, job);
  }

  private async providerLost(nodeId: string, attempt: ManagedReconstruction, job: RemoteComputeJob): Promise<void> {
    const released = await this.deps.remote.releaseInput(job);
    // Pin release switched off: the pin stays, so it is listed and retried instead of being forgotten.
    if (released && released.released === false) await this.list(attempt.id, job.inputCid);
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
    await this.noteStaged(attempt.id, job.id);
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
    await this.finish(nodeId, attempt.id, state.captureId, job);
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
        // The backend answers every chunk with the full draft at the top level and the companion under `lightweight`.
        const progress = variant === 'lightweight' ? result.candidate.lightweight : result.candidate;
        if (!progress) throw Object.assign(new Error('candidate_progress_unreadable'), { code: 'candidate_progress_unreadable' });
        const next = progress.receivedBytes;
        // The server's count decides where the next chunk starts; a count that did not advance would loop forever.
        if (!Number.isSafeInteger(next) || (next as number) <= received || (next as number) > size) {
          throw Object.assign(new Error('candidate_progress_unreadable'), { code: 'candidate_progress_unreadable' });
        }
        received = next as number;
        finished = progress.state === 'ready';
      }
    } finally { await handle.close(); }
    return last;
  }

  /** A result that cannot be imported ends the attempt as a provider failure; requester cleanup is still reported. */
  private async failImport(nodeId: string, attempt: ManagedReconstruction, job: RemoteComputeJob, code: string): Promise<void> {
    await this.trackProviderJob(attempt.id, job);
    await this.deps.api.reconstructionCall(attempt.id, 'failure', { nodeId, code });
    const state = await this.readState(attempt.id);
    await this.finish(nodeId, attempt.id, state.captureId, job);
  }

  private async cancel(nodeId: string, attempt: ManagedReconstruction): Promise<void> {
    let job: RemoteComputeJob | undefined;
    // A request whose answer was lost may have created a job the attempt does not name yet: it is cancelled like any other.
    const pending = attempt.computeJobId ? undefined : (await this.readState(attempt.id)).pendingInput;
    if (attempt.computeJobId || (pending && await this.jobHoldingInput(nodeId, attempt.id, pending.inputCid))) {
      job = await this.deps.api.reconstructionCall<RemoteComputeJob>(attempt.id, 'compute-job/cancel', { nodeId });
      await this.trackProviderJob(attempt.id, job);
    }
    const state = await this.readState(attempt.id);
    await this.deps.api.reconstructionCall(attempt.id, 'cancelled', { nodeId });
    await this.finish(nodeId, attempt.id, state.captureId, job);
  }

  /**
   * The attempt is over, whichever way it ended. Releases what this requester holds (the provider job's input pin, an input
   * no job holds, the prepared capture, every work file but the source copies and the attempt's own record), then reports
   * the outcome of that cleanup (the staged provider result included): `complete` only when every pin was released,
   * `pending` while a pin is held because pin release is switched off, `failed` when a step failed. A pin that is not
   * released is listed and retried by later passes and the sweep. Reported on every terminal path: ready, failed, needs
   * more views and cancelled.
   */
  private async finish(nodeId: string, id: string, captureId: string | undefined, job?: RemoteComputeJob): Promise<void> {
    let outcome: CleanupOutcome = 'complete';
    try {
      // An input prepared for a provider but never held by a job has no job to release it: release it here.
      // A job the backend created from it (the answer was lost) owns it and releases it with the job, not here.
      const unused = (await this.readState(id)).pendingInput;
      if (unused) {
        if (await this.jobHoldingInput(nodeId, id, unused.inputCid)) await this.clearPendingInput(id, unused.inputCid);
        else {
          const current = await this.readState(id);
          await this.writeState(id, { ...current, pendingInput: undefined, unusedInputs: Array.from(new Set([...(current.unusedInputs ?? []), unused.inputCid])) });
        }
      }
      await this.listInterruptedOwner(id);
      const retried = await this.retryUnusedInputs(id);
      if (retried === 'failed') throw new Error('unused_input_release_failed');
      if (retried === 'pending') outcome = 'pending';
    } catch (error) {
      outcome = 'failed';
      this.deps.logger.warn({ code: 'managed_requester_input_release_failed', error: String((error as Error).message) }, 'unused encrypted input release requires retry');
    }
    if (job) {
      try {
        const released = await this.deps.remote.releaseInput(job);
        if (released && released.released === false) { outcome = worse(outcome, 'pending'); await this.list(id, job.inputCid); }
      } catch (error) {
        outcome = 'failed';
        await this.list(id, job.inputCid).catch(() => undefined);
        this.deps.logger.warn({ code: 'managed_requester_input_release_failed', error: String((error as Error).message) }, 'encrypted input release requires retry');
      }
    }
    try {
      // The provider's decrypted result, staged here to verify and import it, goes with the rest.
      await this.removeStaged(id);
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
      // An attempt record that cannot be read is skipped (and left for review), not allowed to stop the other attempts' scan.
      const state = await this.readState(id).catch(() => ({ excludedProviders: [] }) as LocalState);
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
    const input = { mode: 'source_set', maskFaces: { photos: true, video: true } };
    const response = await longWorkerFetch(`${deps.workerUrl}/v1/process`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Kubus-Worker-Authorization': await deps.workerAuth.issue(jobId, type, { purpose: 'process', captureDirectory, outputDirectory, input }) },
      body: JSON.stringify({ jobId, type, workerInstanceId: health.workerInstanceId, captureDirectory, outputDirectory, input }),
    });
    const body = await response.json().catch(() => ({})) as { prepared?: { path?: string; inputs?: unknown; sfm?: Record<string, unknown> }; detail?: { code?: string; details?: Record<string, unknown> } };
    const mapInputs = (raw: unknown): InputFeedback[] => mapInputFeedback(raw, fileIds);
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

/**
 * Stops a prepare run on the requester's own worker and waits for it to quiesce: the cancel endpoint answers only once
 * the worker's process is gone (it leaves a tombstone for that job id, which is why every run has a fresh one). Throws
 * when the worker cannot be reached or does not confirm, so the caller leaves the run's work directory alone.
 */
export function workerCancelPrepare(deps: { workerUrl: string; workerAuth: WorkerAuthService }): ManagedRequesterDeps['cancelPrepare'] {
  return async jobId => {
    const health = await (await fetch(`${deps.workerUrl}/health`, { signal: AbortSignal.timeout(20_000) })).json() as { workerInstanceId?: string };
    if (!health.workerInstanceId) throw Object.assign(new Error('worker_identity_unavailable'), { code: 'worker_identity_unavailable' });
    const type = 'spatial.reconstruct';
    const response = await fetch(`${deps.workerUrl}/v1/jobs/cancel`, {
      method: 'POST', signal: AbortSignal.timeout(20_000),
      headers: { 'Content-Type': 'application/json', 'X-Kubus-Worker-Authorization': await deps.workerAuth.issue(jobId, type, { purpose: 'cancel' }) },
      body: JSON.stringify({ jobId, type, workerInstanceId: health.workerInstanceId }),
    });
    const receipt = await response.json().catch(() => ({})) as Record<string, unknown>;
    if (!response.ok || receipt.jobId !== jobId || receipt.cleanupProtocol !== 1 || receipt.quiescent !== true || receipt.workerInstanceId !== health.workerInstanceId) {
      throw Object.assign(new Error('worker_quiescence_unverified'), { code: 'worker_quiescence_unverified' });
    }
  };
}
