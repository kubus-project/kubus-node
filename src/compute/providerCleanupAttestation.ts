import crypto from 'node:crypto';
import stableStringify from 'json-stable-stringify';
import type { RemoteComputeJob } from '../backend/models.js';
import type { LocalState, LocalStore } from '../state/localStore.js';
import { jobIdPattern } from '../jobs/ownedWorkDirectory.js';
import type { Logger } from '../logging/logger.js';

/**
 * The provider's signed statement about what it did with a job's data once the job was over.
 *
 * Trust boundary: this is an authenticated statement by the provider Node, bound to one job and signed with the
 * key the backend pinned when it assigned the job. It is not cryptographic proof that bytes were physically
 * erased: a provider that wanted to keep data could sign `deleted` all the same. It exists so a requester and an
 * operator can see that a well-behaved provider finished, and see when one did not say so.
 */
export const PROVIDER_CLEANUP_SCHEMA = 'kubus.provider-cleanup/1';

export type CleanupItemStatus = 'deleted' | 'not_present' | 'failed';
export type OutputPinStatus = 'released' | 'not_present' | 'failed';
export const TERMINAL_JOB_STATES = ['COMPLETED', 'FAILED', 'EXPIRED', 'DECLINED', 'CANCELLED', 'DISPUTED'] as const;

export interface ProviderCleanupPayload {
  schema: typeof PROVIDER_CLEANUP_SCHEMA;
  jobId: string;
  providerNodeId: string;
  inputHash: string;
  finalState: string;
  receivedAt: string;
  workerStartedAt: string | null;
  workerFinishedAt: string | null;
  cancelledAt: string | null;
  items: { decryptedInput: CleanupItemStatus; workDirectory: CleanupItemStatus; plaintextOutputs: CleanupItemStatus; sealedOutputs: CleanupItemStatus };
  outputPins: OutputPinStatus;
  state: 'complete' | 'failed';
  reason: string | null;
  completedAt: string;
}

export interface ProviderCleanupAttestation { payload: ProviderCleanupPayload; signature: string }

const ITEM_STATUSES = new Set<string>(['deleted', 'not_present', 'failed']);
const PIN_STATUSES = new Set<string>(['released', 'not_present', 'failed']);
const ITEM_KEYS = ['decryptedInput', 'workDirectory', 'plaintextOutputs', 'sealedOutputs'] as const;
const REASON = /^[a-z0-9_:.-]{1,80}$/;

/** The signed bytes: a domain prefix, then the canonical payload. A job receipt is signed over bare JSON, so the two never collide. */
export function cleanupAttestationMessage(payload: ProviderCleanupPayload): Buffer {
  return Buffer.from(`${PROVIDER_CLEANUP_SCHEMA}\n${stableStringify(payload) ?? ''}`, 'utf8');
}

/** `complete` iff no item and no output pin failed. */
export function cleanupState(items: ProviderCleanupPayload['items'], outputPins: OutputPinStatus): 'complete' | 'failed' {
  return outputPins === 'failed' || Object.values(items).includes('failed') ? 'failed' : 'complete';
}

function invalid(code: string): Error {
  return Object.assign(new Error(code), { code });
}

const isoOrNull = (value: unknown) => value === null || (typeof value === 'string' && value.length <= 40 && Number.isFinite(Date.parse(value)));

/**
 * Checks a provider cleanup attestation against the job view and the provider's pinned signing key: schema, the job
 * it names, the provider and input it binds to, the job's terminal state, internal consistency and the signature.
 * The backend runs the same checks; the requester repeats them before it records the statement.
 */
export function verifyProviderCleanupAttestation(
  job: Pick<RemoteComputeJob, 'id' | 'providerNodeId' | 'inputHash' | 'state' | 'verification'>,
  attestation: unknown,
): ProviderCleanupPayload {
  const value = attestation as Partial<ProviderCleanupAttestation> | null;
  const payload = value?.payload as ProviderCleanupPayload | undefined;
  if (!payload || typeof payload !== 'object' || typeof value?.signature !== 'string') throw invalid('provider_cleanup_attestation_malformed');
  if (payload.schema !== PROVIDER_CLEANUP_SCHEMA) throw invalid('provider_cleanup_schema_invalid');
  if (payload.jobId !== job.id || !jobIdPattern.test(payload.jobId)) throw invalid('provider_cleanup_job_mismatch');
  if (payload.providerNodeId !== job.providerNodeId) throw invalid('provider_cleanup_provider_mismatch');
  if (payload.inputHash !== job.inputHash) throw invalid('provider_cleanup_input_mismatch');
  if (!(TERMINAL_JOB_STATES as readonly string[]).includes(job.state) || payload.finalState !== job.state) throw invalid('provider_cleanup_state_mismatch');
  const items = payload.items as ProviderCleanupPayload['items'] | undefined;
  if (!items || ITEM_KEYS.some(key => !ITEM_STATUSES.has(items[key])) || !PIN_STATUSES.has(payload.outputPins)) throw invalid('provider_cleanup_items_invalid');
  if (payload.state !== cleanupState(items, payload.outputPins)) throw invalid('provider_cleanup_state_inconsistent');
  if (payload.reason !== null && (typeof payload.reason !== 'string' || !REASON.test(payload.reason))) throw invalid('provider_cleanup_reason_invalid');
  if (typeof payload.receivedAt !== 'string' || !isoOrNull(payload.receivedAt) || typeof payload.completedAt !== 'string' || !isoOrNull(payload.completedAt) ||
      !isoOrNull(payload.workerStartedAt) || !isoOrNull(payload.workerFinishedAt) || !isoOrNull(payload.cancelledAt)) throw invalid('provider_cleanup_time_invalid');
  const key = job.verification?.providerSigningPublicKey;
  if (typeof key !== 'string') throw invalid('provider_cleanup_key_unavailable');
  try {
    const publicKey = crypto.createPublicKey({ key: Buffer.from(key, 'base64'), format: 'der', type: 'spki' });
    if (publicKey.asymmetricKeyType !== 'ed25519' ||
        !crypto.verify(null, cleanupAttestationMessage(payload), publicKey, Buffer.from(value.signature, 'base64'))) throw invalid('provider_cleanup_signature_invalid');
  } catch (error) {
    throw (error as { code?: string }).code ? error : invalid('provider_cleanup_signature_invalid');
  }
  return payload;
}

/** What this Node stores for one job's attestation until the backend has accepted it. */
export interface StoredCleanupAttestation extends ProviderCleanupAttestation {
  status: 'pending' | 'accepted' | 'rejected';
  attempts: number;
  nextAttemptAt: string;
  createdAt: string;
  acceptedAt?: string;
  lastError?: string;
}

type LocalJobView = { id?: string; input?: { remoteComputeJobId?: string }; startedAt?: string; completedAt?: string };
type ProviderRecordView = { role?: string; localJobId?: string; cleanup?: { plaintext?: string; receivedAt?: string; decryptedInputRemoved?: boolean; requestedAt?: string } };

const RETRY_BASE_MS = 5_000;
const RETRY_MAX_MS = 15 * 60_000;
const MAX_JOB_AGE_MS = 30 * 24 * 60 * 60_000;
/** A 4xx other than these is a statement the backend will never accept; retrying it would only repeat the refusal. */
const RETRYABLE_STATUS = new Set([401, 403, 408, 425, 429]);

export interface AttestorDeps {
  store: Pick<LocalStore, 'snapshot' | 'update'>;
  nodeId: () => string | undefined;
  sign: (payload: ProviderCleanupPayload) => Promise<string>;
  submit: (jobId: string, body: { nodeId: string; attestation: ProviderCleanupAttestation }) => Promise<unknown>;
  logger: Pick<Logger, 'warn' | 'info'>;
  now?: () => number;
}

/**
 * Builds, signs, persists and delivers the provider's cleanup attestation. It runs only for a terminal job, after the
 * local cleanup and the sealed output release have been attempted, and reads the outcome from the local journals so a
 * statement can only say what those journals say. A pending statement survives a restart and is retried with backoff.
 */
export class ProviderCleanupAttestor {
  private readonly inFlight = new Map<string, Promise<void>>();
  constructor(private readonly deps: AttestorDeps) {}

  private now(): number { return this.deps.now ? this.deps.now() : Date.now(); }

  /** Evaluates the local journals for a terminal job and queues a signed statement; delivery is attempted at once. */
  async attest(job: RemoteComputeJob): Promise<void> {
    if (!(TERMINAL_JOB_STATES as readonly string[]).includes(job.state) || !jobIdPattern.test(job.id)) return;
    const nodeId = this.deps.nodeId();
    if (!nodeId || job.providerNodeId !== nodeId) return;
    const state = this.deps.store.snapshot();
    const record = state.remoteJobs?.[job.id] as ProviderRecordView | undefined;
    // A job this Node never journaled is only attested when it is a managed job it saw end recently: there was nothing to clean.
    if (record && (record.role !== 'provider' || !record.cleanup)) return;
    if (!record && (Date.now() - Date.parse(job.createdAt || '') > MAX_JOB_AGE_MS || !isManagedJob(job))) return;
    const stored = state.providerCleanupAttestations?.[job.id];
    if (stored?.status === 'rejected' || stored?.status === 'pending') return;
    if (stored?.status === 'accepted' && stored.payload.state === 'complete') return;
    const evaluated = this.evaluate(job, record, state);
    // A `failed` statement is replaced only by a better one; the same failure again is not re-sent.
    if (stored && evaluated.state === 'failed') return;
    const payload: ProviderCleanupPayload = {
      schema: PROVIDER_CLEANUP_SCHEMA, jobId: job.id, providerNodeId: nodeId, inputHash: job.inputHash, finalState: job.state,
      receivedAt: evaluated.receivedAt, workerStartedAt: evaluated.workerStartedAt, workerFinishedAt: evaluated.workerFinishedAt,
      cancelledAt: job.state === 'CANCELLED' ? (stored?.payload.cancelledAt ?? new Date(this.now()).toISOString()) : null,
      items: evaluated.items, outputPins: evaluated.outputPins, state: evaluated.state, reason: evaluated.reason,
      completedAt: new Date(this.now()).toISOString(),
    };
    const signature = await this.deps.sign(payload);
    const nowIso = new Date(this.now()).toISOString();
    await this.deps.store.update(next => {
      (next.providerCleanupAttestations ??= {})[job.id] = { payload, signature, status: 'pending', attempts: 0, nextAttemptAt: nowIso, createdAt: nowIso };
    });
    await this.flush(job.id);
  }

  /** Re-sends every pending statement whose backoff has elapsed. */
  async retryDue(): Promise<void> {
    for (const [jobId, item] of Object.entries(this.deps.store.snapshot().providerCleanupAttestations ?? {})) {
      if (item.status === 'pending' && Date.parse(item.nextAttemptAt) <= this.now()) await this.flush(jobId);
    }
  }

  pendingCount(): number {
    return Object.values(this.deps.store.snapshot().providerCleanupAttestations ?? {}).filter(item => item.status === 'pending').length;
  }

  private flush(jobId: string): Promise<void> {
    const active = this.inFlight.get(jobId);
    if (active) return active;
    const work = this.deliver(jobId).finally(() => this.inFlight.delete(jobId));
    this.inFlight.set(jobId, work);
    return work;
  }

  private async deliver(jobId: string): Promise<void> {
    const nodeId = this.deps.nodeId();
    const item = this.deps.store.snapshot().providerCleanupAttestations?.[jobId];
    if (!nodeId || !item || item.status !== 'pending') return;
    try {
      await this.deps.submit(jobId, { nodeId, attestation: { payload: item.payload, signature: item.signature } });
      await this.deps.store.update(next => {
        const saved = next.providerCleanupAttestations?.[jobId];
        if (saved) { saved.status = 'accepted'; saved.acceptedAt = new Date(this.now()).toISOString(); saved.lastError = undefined; }
      });
    } catch (error) {
      const status = (error as { status?: number }).status;
      const permanent = typeof status === 'number' && status >= 400 && status < 500 && !RETRYABLE_STATUS.has(status);
      const code = String((error as { code?: string; details?: { code?: string } }).details?.code ?? (error as { code?: string }).code ?? status ?? 'submit_failed').slice(0, 60);
      await this.deps.store.update(next => {
        const saved = next.providerCleanupAttestations?.[jobId];
        if (!saved) return;
        saved.attempts += 1;
        saved.lastError = code;
        if (permanent) saved.status = 'rejected';
        else saved.nextAttemptAt = new Date(this.now() + Math.min(RETRY_MAX_MS, RETRY_BASE_MS * 2 ** Math.min(saved.attempts - 1, 10))).toISOString();
      });
      this.deps.logger.warn({ code: permanent ? 'provider_cleanup_attestation_rejected' : 'provider_cleanup_attestation_retry', jobId, error: code }, 'provider cleanup attestation not accepted');
    }
  }

  private evaluate(job: RemoteComputeJob, record: ProviderRecordView | undefined, state: LocalState) {
    const jobs = Object.values(state.jobs ?? {}) as LocalJobView[];
    const children = jobs.filter(local => local.input?.remoteComputeJobId === job.id || (record?.localJobId && local.id === record.localJobId));
    const decryptedInput: CleanupItemStatus = !record ? 'not_present'
      : record.cleanup?.plaintext === 'complete' ? (record.cleanup.decryptedInputRemoved === false ? 'not_present' : 'deleted') : 'failed';
    let workDirectory: CleanupItemStatus = 'not_present';
    for (const child of children) {
      const journal = child.id ? state.jobCleanup?.[child.id] : undefined;
      const status: CleanupItemStatus = !journal ? (child.startedAt ? 'failed' : 'not_present')
        : journal.state !== 'complete' ? 'failed' : (journal.removed === false ? 'not_present' : 'deleted');
      if (status === 'failed' || workDirectory === 'failed') workDirectory = 'failed';
      else if (status === 'deleted') workDirectory = 'deleted';
    }
    // The worker's plaintext outputs are written under the job's own work directory and go with it.
    const plaintextOutputs = workDirectory;
    const sealed = Object.entries(state.privateComputeCids ?? {}).filter(([, saved]) => saved.role === 'private_output' && saved.jobId === job.id);
    const released = sealed.every(([cid]) => state.managedPins?.[cid]?.state === 'released');
    const outputPins: OutputPinStatus = !sealed.length ? 'not_present' : released ? 'released' : 'failed';
    const sealedOutputs: CleanupItemStatus = !sealed.length ? 'not_present' : released ? 'deleted' : 'failed';
    const items = { decryptedInput, workDirectory, plaintextOutputs, sealedOutputs };
    const failedKey = ITEM_KEYS.find(key => items[key] === 'failed');
    const resultState = cleanupState(items, outputPins);
    const timed = (value?: string) => (value && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : null);
    return {
      items, outputPins, state: resultState,
      reason: resultState === 'complete' ? null : failedKey ? `${failedKey.replace(/[A-Z]/g, letter => `_${letter.toLowerCase()}`)}_not_cleaned` : 'output_pins_not_released',
      receivedAt: timed(record?.cleanup?.receivedAt) ?? timed(job.createdAt) ?? new Date(this.now()).toISOString(),
      workerStartedAt: timed(children.map(child => child.startedAt).filter(Boolean).sort()[0]),
      workerFinishedAt: timed(children.map(child => child.completedAt).filter(Boolean).sort().at(-1)),
    };
  }
}

function isManagedJob(job: RemoteComputeJob): boolean {
  return (job.canonicalJobSpec?.processing as { outputMode?: unknown } | undefined)?.outputMode === 'kubus.private-output/1';
}
