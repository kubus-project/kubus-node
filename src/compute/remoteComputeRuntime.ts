import crypto from 'node:crypto';
import { promises as fs } from 'node:fs';
import stableStringify from 'json-stable-stringify';
import path from 'node:path';
import type { KubusApiClient } from '../backend/kubusApiClient.js';
import type { ComputeCandidate, RemoteComputeJob } from '../backend/models.js';
import type { CaptureRecord, CaptureStore } from '../captures/captureStore.js';
import type { AppConfig } from '../config/schema.js';
import type { KuboClient } from '../ipfs/kuboClient.js';
import type { JobRuntime, LocalJob } from '../jobs/jobRuntime.js';
import { localError } from '../localApi/pairingService.js';
import type { Logger } from '../logging/logger.js';
import type { NetworkParticipationGate } from '../participation/networkParticipationGate.js';
import { validateSpatialManifest, type SpatialManifest } from '../spatial/models.js';
import { inspectCapturePackage } from '../captures/capturePackage.js';
import { redactSecrets } from '../logging/logBuffer.js';
import { Backoff } from '../scheduler/backoff.js';
import type { LocalStore } from '../state/localStore.js';
import { credentialFingerprint, computeAuthorizationRequired } from './credentialFingerprint.js';
import type { ComputeIdentityService } from './computeIdentity.js';
import { PrivatePayloadTransport, type ComputeKeyEnvelope } from './privatePayloadTransport.js';
import { effectiveComputeProviderSettings, validateComputeProviderSettings, type ComputeProviderSettings } from './providerSettings.js';

import { ProviderCleanup, type RemoteRuntimeRecord } from './providerCleanup.js';
import { ProviderCleanupAttestor } from './providerCleanupAttestation.js';
import { ManagedPins } from '../ipfs/managedPins.js';
import { jobIdPattern } from '../jobs/ownedWorkDirectory.js';
import {
  PRIVATE_OUTPUT_PROTOCOL, openOutputBlob, outputCommitmentDigest, validatePrivateOutput, type PrivateOutputCommitment,
} from './privateOutputTransport.js';

/** Whether a requester's encrypted input pin was really released. A pin whose release is switched off stays held. */
export interface InputReleaseOutcome { released: boolean; reason?: string }

function isPrivateOutput(job: RemoteComputeJob): boolean {
  return (job.canonicalJobSpec?.processing as { outputMode?: unknown } | undefined)?.outputMode === PRIVATE_OUTPUT_PROTOCOL;
}

function signedPrivateOutput(job: RemoteComputeJob): PrivateOutputCommitment {
  if (!jobIdPattern.test(job.id) || !job.outputManifestCid) throw localError(422, 'private_output_job_invalid');
  const receipt = job.providerReceipt as { payload?: Record<string, unknown>; signature?: unknown } | undefined;
  const payload = receipt?.payload;
  const key = job.verification?.providerSigningPublicKey;
  if (!payload || typeof key !== 'string' || typeof receipt?.signature !== 'string' ||
      payload.jobId !== job.id || payload.inputHash !== job.inputHash || payload.jobSpecHash !== job.jobSpecHash ||
      payload.protocolVersion !== job.protocolVersion || !Array.isArray(payload.outputCids) ||
      stableStringify([...payload.outputCids].sort()) !== stableStringify([...job.outputCids].sort())) {
    throw localError(422, 'private_output_signature_binding_invalid');
  }
  const publicKey = crypto.createPublicKey({ key: Buffer.from(key, 'base64'), format: 'der', type: 'spki' });
  if (publicKey.asymmetricKeyType !== 'ed25519' ||
      !crypto.verify(null, Buffer.from(stableStringify(payload) ?? ''), publicKey, Buffer.from(receipt.signature, 'base64'))) {
    throw localError(422, 'private_output_signature_invalid');
  }
  return validatePrivateOutput(payload.privateOutput, job.id, job.outputManifestCid, job.outputCids);
}

const POLL_INTERVAL_MS = 5000;
const POLL_MAX_BACKOFF_MS = 60000;
/** Re-emit a "still failing" summary at most this often, instead of one warning per tick. */
const FAILURE_SUMMARY_INTERVAL_MS = 60000;

export class RemoteComputeRuntime {
  private timer?: NodeJS.Timeout;
  private cleanupTimer?: NodeJS.Timeout;
  private readonly providerCleanup: ProviderCleanup;
  private readonly attestor: ProviderCleanupAttestor;
  private polling = false;
  private stopped = true;
  private readonly backoff = new Backoff(POLL_INTERVAL_MS, POLL_MAX_BACKOFF_MS);
  private consecutiveFailures = 0;
  private lastFailureLoggedAt = 0;

  constructor(private readonly deps: {
    api: KubusApiClient; kubo: KuboClient; store: LocalStore; config: AppConfig; captures: CaptureStore; jobs: JobRuntime;
    gate: NetworkParticipationGate; identity: ComputeIdentityService; transport: PrivatePayloadTransport; logger: Logger;
  }) {
    this.providerCleanup = new ProviderCleanup(deps.store, deps.jobs, deps.config.localDataPath, async (cid, owner) => {
      await new ManagedPins(deps.kubo, deps.store, { allowUnpin: deps.config.managedPinReleaseEnabled === true }).release(cid, owner);
    });
    this.attestor = new ProviderCleanupAttestor({
      store: deps.store, nodeId: () => deps.store.snapshot().nodeId, logger: deps.logger,
      sign: payload => deps.identity.signProviderCleanup(payload),
      submit: (jobId, body) => deps.api.submitProviderCleanupAttestation(jobId, body),
    });
  }

  start(): void {
    if (!this.cleanupTimer) {
      void this.reconcileProviderCleanup().catch(() => this.deps.logger.warn({ code: 'provider_cleanup_retry_required' }, 'provider cleanup could not run'));
      this.cleanupTimer = setInterval(() => void this.reconcileProviderCleanup().catch(() => this.deps.logger.warn({ code: 'provider_cleanup_retry_required' }, 'provider cleanup could not run')), POLL_INTERVAL_MS);
      this.cleanupTimer.unref();
    }
    if (!this.stopped) return;
    // A blocked verdict recorded against the credential still in use survives a
    // restart. Starting the loop anyway would re-learn the same 403 the hard
    // way and put the request back on the backend, which is exactly the
    // once-a-minute-forever behaviour this exists to end. A verdict recorded
    // against a *different* credential says nothing about this one, so
    // `isAuthorizationBlocked` clears itself when the fingerprint moves.
    if (this.isAuthorizationBlocked()) {
      this.deps.logger.warn(
        {
          op: 'remote_compute_poll',
          state: 'AUTHORIZATION_REQUIRED',
          requiresOperatorAction: true,
          ...this.authorizationDiagnostics(),
        },
        'remote compute provider polling not started — node authorization required',
      );
      return;
    }
    this.stopped = false;
    this.scheduleNextPoll(0);
  }

  stop(): void {
    this.stopProviderPolling();
    if (this.cleanupTimer) clearInterval(this.cleanupTimer);
    this.cleanupTimer = undefined;
  }

  private stopProviderPolling(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
  }

  cleanupDiagnostics(): { plaintextPending: number; plaintextBlocked: number; inputPinReleasesPending: number; managedInputUnpinsPending: number; requesterSubmissionsUnconfirmed: number; legacyReviewRequired: number } {
    const state = this.deps.store.snapshot();
    const records = (Object.values(state.remoteJobs || {}) as RemoteRuntimeRecord[]).filter(record => record.role === 'provider');
    return { plaintextPending: records.filter(record => record.cleanup && record.cleanup.plaintext !== 'complete').length,
      plaintextBlocked: records.filter(record => record.cleanup?.plaintext === 'blocked').length,
      inputPinReleasesPending: records.filter(record => record.cleanup?.inputPinReleasePending).length,
      managedInputUnpinsPending: Object.values(state.managedPins || {}).filter(record =>
        ['release_pending', 'releasing', 'release_uncertain'].includes(record.state) && /^(provider-input|requester-input):/.test(record.lastReleasedOwner || '')).length,
      requesterSubmissionsUnconfirmed: Object.values(state.privateComputeCids || {}).filter(record => record.submissionReconciliationRequired).length,
      legacyReviewRequired: records.filter(record => !record.cleanup || (!record.cleanup.pinOwner && record.cleanup.inputPinReleasePending)).length };
  }

  async reconcileProviderCleanup(): Promise<ReturnType<RemoteComputeRuntime['cleanupDiagnostics']>> {
    const managed = new ManagedPins(this.deps.kubo, this.deps.store, { allowUnpin: this.deps.config.managedPinReleaseEnabled === true });
    // Retry old private-input releases without requiring backend access or a
    // new canonical archive response. A pin RPC failure must not prevent
    // removal of independently owned readable source directories.
    await managed.reconcile({ ownerPrefix: 'provider-input:' }).catch(() => undefined);
    await managed.reconcile({ ownerPrefix: 'requester-input:' }).catch(() => undefined);
    await managed.reconcile({ ownerPrefix: 'provider-output:' }).catch(() => undefined);
    await this.providerCleanup.reconcilePending();
    // A statement the backend has not accepted yet survives a restart and is re-sent once its backoff elapses.
    await this.attestor.retryDue().catch(() => undefined);
    return this.cleanupDiagnostics();
  }

  private scheduleNextPoll(delayMs: number): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.runPollCycle(), delayMs);
    this.timer.unref();
  }

  private async runPollCycle(): Promise<void> {
    if (this.stopped) return;
    const nextDelay = await this.pollProvider();
    if (this.stopped) return;
    this.scheduleNextPoll(nextDelay);
  }

  /** The fingerprint of the operator token this process is currently sending. */
  private currentCredentialFingerprint(): string | undefined {
    return credentialFingerprint(this.deps.config.operatorToken);
  }

  /**
   * Whether remote compute is blocked for the credential in use right now.
   *
   * A recorded verdict only applies to the credential it was recorded against.
   * If the operator token has changed since, the verdict is stale and this
   * returns false so the new credential gets its own chance — that is what
   * makes rotation resume polling without a restart or an explicit retry.
   */
  isAuthorizationBlocked(): boolean {
    return computeAuthorizationRequired(this.deps.store.snapshot().computeAuthorization, this.deps.config.operatorToken);
  }

  /** Safe to log and to show an operator. Never contains the token. */
  authorizationDiagnostics(): Record<string, unknown> {
    const recorded = this.deps.store.snapshot().computeAuthorization;
    if (!recorded) return {};
    return {
      status: recorded.status,
      missingScope: recorded.missingScope,
      surface: recorded.surface,
      observedAt: recorded.observedAt,
      credentialFingerprint: recorded.credentialFingerprint,
      lastAuthorizedAt: recorded.lastAuthorizedAt,
    };
  }

  /**
   * Records that the backend refused this node's compute credential, and stops.
   *
   * Deliberately terminal for this credential. 401 means the token is invalid,
   * expired or revoked; 403 means it is valid but carries no
   * `compute:jobs:read`. Neither is fixed by asking again, so the loop is not
   * rescheduled at all — not even at the one-minute ceiling.
   */
  private async blockOnAuthorizationFailure(
    status: number,
    surface: 'provider_jobs' | 'provider_rewards',
    missingScope?: string,
  ): Promise<void> {
    const fingerprint = this.currentCredentialFingerprint();
    await this.deps.store.update((state) => {
      state.computeAuthorization = {
        ...(state.computeAuthorization ?? {}),
        state: 'AUTHORIZATION_REQUIRED',
        status,
        missingScope,
        surface,
        observedAt: new Date().toISOString(),
        credentialFingerprint: fingerprint,
      };
    });
    this.stopProviderPolling();
  }

  /** Records that the credential worked, clearing any previous blocked verdict. */
  private async recordAuthorized(): Promise<void> {
    const recorded = this.deps.store.snapshot().computeAuthorization;
    if (recorded?.state === 'OK' && recorded.credentialFingerprint === this.currentCredentialFingerprint()) return;
    const fingerprint = this.currentCredentialFingerprint();
    await this.deps.store.update((state) => {
      state.computeAuthorization = {
        state: 'OK',
        credentialFingerprint: fingerprint,
        lastAuthorizedAt: new Date().toISOString(),
      };
    });
  }

  /**
   * Re-checks authorization and resumes polling if it now works.
   *
   * The explicit "Re-authorize Node" action, and the path a rotated credential
   * takes. Clearing the recorded verdict first is what allows a retry against
   * the same credential — an operator who has just had the scope granted
   * server-side should not have to restart the node to find out.
   */
  async retryAuthorization(): Promise<{ resumed: boolean }> {
    await this.deps.store.update((state) => {
      if (state.computeAuthorization) state.computeAuthorization.state = 'OK';
    });
    const settings = this.settings();
    if (!settings.enabled || settings.paused) return { resumed: false };
    this.consecutiveFailures = 0;
    this.backoff.success();
    this.start();
    return { resumed: !this.stopped };
  }

  settings(): ComputeProviderSettings { return effectiveComputeProviderSettings(this.deps.config, this.deps.store.snapshot()); }

  async updateSettings(input: Record<string, unknown>): Promise<ComputeProviderSettings> {
    const next = validateComputeProviderSettings(input, this.settings());
    await this.deps.store.update((state) => { state.computeProviderSettings = next; });
    return next;
  }

  async candidates(authorization: string, options: { type?: string; minimumVramBytes?: number; inputBytes?: number }): Promise<{ nodes: ComputeCandidate[]; protocolVersion: string }> {
    requireUserAuthorization(authorization);
    return this.deps.api.getComputeCandidates(options, authorization);
  }

  async requestJob(input: { authorization: string; captureId: string; provider: ComputeCandidate; requirements: Record<string, unknown>; type?: string; privateOutput?: boolean }): Promise<RemoteComputeJob> {
    requireUserAuthorization(input.authorization);
    await this.deps.gate.assertUsefulOperation('remote_compute_submission');
    if (!input.provider?.nodeId || !input.provider.encryptionPublicKey) throw localError(400, 'compute_provider_invalid');
    if (input.privateOutput && input.provider.privateOutputProtocol !== PRIVATE_OUTPUT_PROTOCOL) {
      throw localError(409, 'private_output_provider_protocol_required');
    }
    const encrypted = await this.deps.transport.encryptCapture(input.captureId, input.provider.nodeId, input.provider.encryptionPublicKey);
    try {
      const job = await this.deps.api.createRemoteComputeJob({
        providerNodeId: input.provider.nodeId,
        requesterNodeId: this.deps.store.snapshot().nodeId,
        type: input.type || 'spatial.reconstruct',
        requirements: input.requirements,
        ...encrypted,
        jobSpec: { ...encrypted.jobSpec, ...(input.privateOutput ? { outputMode: PRIVATE_OUTPUT_PROTOCOL } : {}) },
      }, input.authorization);
      await this.deps.store.update((state) => {
        (state.remoteJobs ??= {})[job.id] = { backendJobId: job.id, role: 'requester', state: job.state, updatedAt: new Date().toISOString() } satisfies RemoteRuntimeRecord;
        const privateCid = state.privateComputeCids?.[encrypted.inputCid];
        if (privateCid) { privateCid.jobId = job.id; privateCid.submissionState = 'submitted'; privateCid.submissionReconciliationRequired = false; }
      });
      return job;
    } catch (error) {
      // The backend may have committed the job before its response was lost.
      // Retain the encrypted input for reconciliation rather than destroying
      // an active provider's reference after an ambiguous submission failure.
      await this.deps.store.update(state => {
        const record = state.privateComputeCids?.[encrypted.inputCid];
        if (record) { record.submissionState = 'unconfirmed'; record.submissionReconciliationRequired = true; }
      }).catch(() => this.deps.logger.warn({ code: 'requester_submission_reconciliation_journal_failed' }, 'requester input remains retained for reconciliation'));
      throw error;
    }
  }

  async getRequesterJob(jobId: string, authorization: string): Promise<RemoteComputeJob> {
    requireUserAuthorization(authorization);
    const job = await this.deps.api.getRemoteComputeJob(jobId, authorization);
    await this.updateRecord(job.id, 'requester', job.state);
    return job;
  }

  async retrieveRequesterOutput(jobId: string, authorization: string): Promise<Record<string, unknown>> {
    await this.deps.gate.assertUsefulOperation('remote_compute_result_retrieval');
    const job = await this.getRequesterJob(jobId, authorization);
    if (!['OUTPUT_READY', 'VERIFYING', 'VERIFIED', 'COMPLETED'].includes(job.state) || !job.outputManifestCid) throw localError(409, 'remote_compute_output_not_ready');
    if (isPrivateOutput(job)) return this.retrieveSealedOutput(job);
    const manifestBytes = await this.deps.kubo.cat(job.outputManifestCid);
    let manifest: SpatialManifest;
    try { manifest = validateSpatialManifest(JSON.parse(Buffer.from(manifestBytes).toString('utf8'))); } catch { throw localError(422, 'remote_compute_manifest_invalid'); }
    const declared = new Set(job.outputCids);
    if (!declared.has(job.outputManifestCid) || manifest.variants.some((variant) => !declared.has(variant.cid))) throw localError(422, 'remote_compute_output_cid_mismatch');
    const pinOwner = `spatial:remote-${job.id}`;
    const managed = new ManagedPins(this.deps.kubo, this.deps.store);
    for (const cid of job.outputCids) { await this.deps.kubo.catHead(cid, 1); await managed.acquire(cid, pinOwner); }
    const id = manifest.id;
    const record = { id, state: 'private_remote', manifestCid: job.outputManifestCid, manifest, createdAt: new Date().toISOString(), privateSourceCapture: true, remoteComputeJobId: job.id, pinOwner };
    await this.deps.store.update((state) => { (state.spatial ??= {})[id] = record; });
    return record;
  }

  private async retrieveSealedOutput(job: RemoteComputeJob): Promise<Record<string, unknown>> {
    const commitment = signedPrivateOutput(job);
    const binding = outputCommitmentDigest(commitment);
    const parent = path.join(this.deps.config.localDataPath, 'private', 'remote-results');
    const target = path.join(parent, job.id);
    await fs.mkdir(parent, { recursive: true, mode: 0o700 });
    const existing = await this.sealedResultRecord(target, binding);
    if (existing) return existing;
    const staging = await fs.mkdtemp(path.join(parent, `${job.id}-`));
    try {
      const key = await this.deps.identity.encryptionPrivateKey();
      const manifestBlob = commitment.blobs.find(item => item.role === 'manifest')!;
      const manifestPath = path.join(staging, 'manifest.json');
      await openOutputBlob({ blob: manifestBlob, kubo: this.deps.kubo, recipientPrivateKey: key, jobId: job.id, destination: manifestPath });
      const manifest = validateSpatialManifest(JSON.parse(await fs.readFile(manifestPath, 'utf8')));
      const variants = new Map(commitment.blobs.filter(item => item.role !== 'manifest').map(item => [item.role, item]));
      if (manifest.variants.length !== variants.size) throw localError(422, 'private_output_variant_binding_invalid');
      for (const variant of manifest.variants) {
        const blob = variants.get(variant.role);
        if (!blob || blob.cid !== variant.cid || blob.plaintextBytes !== variant.sizeBytes) {
          throw localError(422, 'private_output_variant_binding_invalid');
        }
        await openOutputBlob({ blob, kubo: this.deps.kubo, recipientPrivateKey: key, jobId: job.id,
          destination: path.join(staging, variant.role) });
        variants.delete(variant.role);
      }
      const result = { id: manifest.id, state: 'private_staged', remoteComputeJobId: job.id, binding };
      await fs.writeFile(path.join(staging, 'verified.json'), JSON.stringify(result), { mode: 0o600, flag: 'wx' });
      try {
        await fs.rename(staging, target);
      } catch (error) {
        if (!(await this.sealedResultRecord(target, binding))) throw error;
      }
      return result;
    } finally { await fs.rm(staging, { recursive: true, force: true }); }
  }

  private async sealedResultRecord(directory: string, binding: string): Promise<Record<string, unknown> | null> {
    try {
      const record = JSON.parse(await fs.readFile(path.join(directory, 'verified.json'), 'utf8')) as Record<string, unknown>;
      if (record.binding !== binding) throw localError(409, 'private_output_stage_conflict');
      return record;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
  }

  async acknowledgeRequesterOutput(jobId: string, authorization: string, accepted: boolean, reason?: string): Promise<RemoteComputeJob> {
    requireUserAuthorization(authorization);
    const job = await this.deps.api.getRemoteComputeJob(jobId, authorization);
    const receipt = await this.signedAcknowledgement(job, accepted, reason);
    const updated = await this.deps.api.acknowledgeRemoteComputeJob(jobId, { accepted, receipt }, authorization);
    if (['COMPLETED', 'DISPUTED', 'FAILED', 'CANCELLED'].includes(updated.state)) await this.releaseRequesterInput(updated);
    await this.updateRecord(updated.id, 'requester', updated.state);
    return updated;
  }

  /**
   * The requester's signed receipt for a job read by any route. An accepted private-output job is acknowledged only
   * after its decrypted result is staged here, and the receipt commits to that exact output.
   */
  async signedAcknowledgement(job: RemoteComputeJob, accepted: boolean, reason?: string): Promise<{ payload: Record<string, unknown>; signature: string }> {
    const privateOutputBinding = isPrivateOutput(job) && accepted ? outputCommitmentDigest(signedPrivateOutput(job)) : null;
    if (privateOutputBinding && !(await this.sealedResultRecord(
      path.join(this.deps.config.localDataPath, 'private', 'remote-results', job.id), privateOutputBinding,
    ))) throw localError(409, 'private_output_not_staged');
    const payload = { jobId: job.id, inputHash: job.inputHash, jobSpecHash: job.jobSpecHash, outputCids: job.outputCids, accepted, reason: reason || null, acknowledgedAt: new Date().toISOString(), protocolVersion: job.protocolVersion,
      ...(privateOutputBinding ? { privateOutputBinding } : {}),
    };
    return { payload, signature: await this.deps.identity.signPayload(payload) };
  }

  /** Verifies and decrypts a private-output job's result into private staging; returns where its variants are. */
  async stagePrivateOutput(job: RemoteComputeJob): Promise<{ directory: string; record: Record<string, unknown> }> {
    if (!isPrivateOutput(job)) throw localError(422, 'private_output_required');
    const record = await this.retrieveSealedOutput(job);
    return { directory: path.join(this.deps.config.localDataPath, 'private', 'remote-results', job.id), record };
  }

  /** Releases the requester's encrypted input pin once the job is over; also used by the managed requester. */
  async releaseInput(job: RemoteComputeJob): Promise<InputReleaseOutcome> {
    const outcome = await this.releaseRequesterInput(job);
    await this.updateRecord(job.id, 'requester', job.state);
    return outcome;
  }

  /**
   * Releases an encrypted input pin that no job holds (prepared for a provider, never sent, or replaced). Idempotent: an
   * input that is already released, or has no managed owner, is left alone.
   */
  async releaseUnusedInput(inputCid: string): Promise<InputReleaseOutcome> {
    const record = this.deps.store.snapshot().privateComputeCids?.[inputCid];
    if (!record || record.role !== 'encrypted_input' || !record.pinOwner || record.releasedAt) return { released: true };
    return this.releaseInputPin(inputCid, record.pinOwner);
  }

  /**
   * Releases every encrypted input pinned under `owner`. A requester that chose the owner before it encrypted (and then
   * died before it learned the CID) finds the pin again this way. Not released while any of them is still held.
   */
  async releaseInputsOwnedBy(owner: string): Promise<InputReleaseOutcome> {
    let pending: InputReleaseOutcome | undefined;
    for (const [cid, record] of Object.entries(this.deps.store.snapshot().privateComputeCids || {})) {
      if (record.role !== 'encrypted_input' || record.pinOwner !== owner || record.releasedAt) continue;
      const outcome = await this.releaseInputPin(cid, owner);
      if (!outcome.released) pending ??= outcome;
    }
    return pending ?? { released: true };
  }

  /**
   * Releases this owner's hold on an input pin and records it as released only when that happened. With pin release
   * switched off (the default) the owner's claim is dropped but the pin is not removed, and the CID stays announced:
   * that is reported as not released, never as done.
   */
  private async releaseInputPin(cid: string, owner: string): Promise<InputReleaseOutcome> {
    const result = await new ManagedPins(this.deps.kubo, this.deps.store, { allowUnpin: this.deps.config.managedPinReleaseEnabled === true }).release(cid, owner);
    if (result.reason === 'pin_release_activation_required') return { released: false, reason: result.reason };
    await this.deps.store.update((state) => { const item = state.privateComputeCids?.[cid]; if (item) item.releasedAt = new Date().toISOString(); });
    return { released: true };
  }

  async cancelRequesterJob(jobId: string, authorization: string): Promise<RemoteComputeJob> {
    requireUserAuthorization(authorization);
    const job = await this.deps.api.cancelRemoteComputeJob(jobId, authorization);
    await this.releaseRequesterInput(job); await this.updateRecord(job.id, 'requester', job.state); return job;
  }

  /** Returns the delay before the next poll: the normal interval on success, a growing backoff on failure. */
  private async pollProvider(): Promise<number> {
    const settings = this.settings();
    const ownedPending = Object.values(this.deps.store.snapshot().remoteJobs || {}).some(item => {
      const record = item as RemoteRuntimeRecord;
      return record.role === 'provider' && record.cleanup && record.cleanup.plaintext !== 'complete';
    });
    if (this.polling || ((!settings.enabled || settings.paused) && !ownedPending)) return POLL_INTERVAL_MS;
    const nodeId = this.deps.store.snapshot().nodeId;
    if (!nodeId) return POLL_INTERVAL_MS;
    this.polling = true;
    try {
      const { jobs } = await this.deps.api.getProviderComputeJobs(nodeId, ['MATCHED', 'ACCEPTED', 'INPUT_READY', 'RUNNING', 'OUTPUT_READY', 'CANCELLED', 'FAILED', 'EXPIRED', 'DECLINED', 'COMPLETED', 'DISPUTED']);
      for (const job of jobs) await this.handleProviderJob(job).catch((error) => this.failProviderJob(job, error));
      this.onPollSucceeded();
      await this.recordAuthorized();
      return POLL_INTERVAL_MS;
    } catch (error) {
      return await this.onPollFailed(error);
    } finally {
      this.polling = false;
    }
  }

  private onPollSucceeded(): void {
    if (this.consecutiveFailures > 0) {
      this.deps.logger.info(
        { op: 'remote_compute_poll', consecutiveFailures: this.consecutiveFailures },
        'remote compute provider poll recovered',
      );
    }
    this.consecutiveFailures = 0;
    this.lastFailureLoggedAt = 0;
    this.backoff.success();
  }

  /** Records the failure, decides whether this tick is loud or silent, and returns the next retry delay. */
  private async onPollFailed(error: unknown): Promise<number> {
    this.consecutiveFailures += 1;
    const described = describePollError(error);
    // A 401/403 is a standing fact about this credential, not a transient
    // outage: the token is invalid, expired or revoked, or it is valid and
    // carries no `compute:jobs:read`. Asking again cannot change any of those.
    //
    // Backing off to a ceiling was not enough — it still meant one rejected
    // request per minute forever, which is how a single node produced 28,701
    // 403s on /api/compute/provider/jobs. The verdict is now recorded durably
    // and the loop stops outright. It resumes when something actually changes:
    // the credential is rotated, or an operator asks it to retry.
    const isAuthorizationFailure = described.status === 401 || described.status === 403;
    if (isAuthorizationFailure) {
      try {
        await this.blockOnAuthorizationFailure(
          described.status as number,
          'provider_jobs',
          missingScopeFrom(error) ?? 'compute:jobs:read',
        );
      } catch (storageError) {
        // A full or read-only state volume must not turn a rejected provider
        // request into an unhandled timer rejection. Without a durable verdict
        // we cannot safely stop forever, so keep the loop alive with normal
        // exponential backoff and report the persistence fault to the operator.
        const delayMs = this.backoff.failure();
        this.deps.logger.warn(
          redactSecrets({
            op: 'remote_compute_poll',
            ...described,
            authorizationVerdictPersistence: describePollError(storageError),
            consecutiveFailures: this.consecutiveFailures,
            nextRetryMs: delayMs,
          }),
          'remote compute authorization verdict could not be persisted — polling will retry',
        );
        return delayMs;
      }
      this.deps.logger.warn(
        redactSecrets({
          op: 'remote_compute_poll',
          ...described,
          state: 'AUTHORIZATION_REQUIRED',
          requiresOperatorAction: true,
          pollingStopped: true,
          consecutiveFailures: this.consecutiveFailures,
        }),
        'remote compute provider polling stopped — node authorization required',
      );
      return POLL_MAX_BACKOFF_MS;
    }
    const delayMs = this.backoff.failure();
    const now = Date.now();
    const isStateTransition = this.consecutiveFailures === 1;
    const summaryDue = now - this.lastFailureLoggedAt >= FAILURE_SUMMARY_INTERVAL_MS;
    if (isStateTransition || summaryDue) {
      this.lastFailureLoggedAt = now;
      this.deps.logger.warn(
        redactSecrets({
          op: 'remote_compute_poll',
          ...described,
          consecutiveFailures: this.consecutiveFailures,
          nextRetryMs: delayMs,
        }),
        'remote compute provider poll failed',
      );
    }
    return delayMs;
  }

  private async handleProviderJob(job: RemoteComputeJob): Promise<void> {
    const nodeId = this.deps.store.snapshot().nodeId!;
    const existing = this.deps.store.snapshot().remoteJobs?.[job.id] as RemoteRuntimeRecord | undefined;
    if (['CANCELLED', 'FAILED', 'EXPIRED', 'DECLINED', 'COMPLETED', 'DISPUTED'].includes(job.state)) {
      // Terminal only: the sealed result stays pinned until the requester has acknowledged it (COMPLETED) or the job ended
      // (a DISPUTED job, whose output the requester rejected, is ended too).
      let failure: unknown;
      try { if (existing?.role === 'provider' && existing.cleanup) await this.providerCleanup.request(job.id); } catch (error) { failure = error; }
      try { if (existing?.role === 'provider') await this.releaseEncryptedOutput(job.id); } catch (error) { failure ??= error; }
      // The statement says what the journals say, so a failed step is stated as failed rather than left unsaid.
      await this.attestor.attest(job).catch(() => this.deps.logger.warn({ code: 'provider_cleanup_attestation_failed', jobId: job.id }, 'provider cleanup attestation could not be queued'));
      if (failure) throw failure;
      return;
    }
    if (job.state === 'OUTPUT_READY' && existing?.cleanup) {
      await this.providerCleanup.request(job.id);
      await this.updateRecord(job.id, 'provider', 'OUTPUT_READY');
      return;
    }
    const settingsAtDispatch = this.settings();
    if ((!settingsAtDispatch.enabled || settingsAtDispatch.paused) && !existing?.localJobId) {
      if (existing?.cleanup) await this.providerCleanup.request(job.id);
      return;
    }
    if (existing?.cleanup?.requested) {
      await this.providerCleanup.request(job.id);
      if (['ACCEPTED', 'INPUT_READY', 'RUNNING'].includes(job.state)) {
        await this.deps.api.transitionProviderComputeJob(job.id, { nodeId, state: 'FAILED', metadata: { code: 'provider_input_released' } });
        await this.updateRecord(job.id, 'provider', 'FAILED');
      }
      return;
    }
    if (job.state === 'MATCHED') {
      if (this.cleanupDiagnostics().plaintextBlocked > 0) {
        await this.deps.api.transitionProviderComputeJob(job.id, { nodeId, state: 'DECLINED', metadata: { code: 'provider_cleanup_pending' } });
        return;
      }
      await this.deps.gate.assertUsefulOperation('remote_compute_acceptance');
      const settings = this.settings();
      const active = Object.values(this.deps.store.snapshot().remoteJobs || {}).filter((item) => {
        const record = item as RemoteRuntimeRecord;
        return record.role === 'provider' && ['PREPARING', 'ACCEPTED', 'INPUT_READY', 'RUNNING'].includes(record.state);
      }).length;
      if (Number(job.inputBytes || 0) > settings.maxAcceptedInputBytes) {
        await this.deps.api.transitionProviderComputeJob(job.id, { nodeId, state: 'DECLINED', metadata: { code: 'provider_input_too_large' } });
        return;
      }
      if (active >= settings.maxConcurrency + settings.maxQueueDepth) {
        await this.deps.api.transitionProviderComputeJob(job.id, { nodeId, state: 'DECLINED', metadata: { code: 'provider_capacity_full' } });
        return;
      }
      await this.deps.api.transitionProviderComputeJob(job.id, { nodeId, state: 'ACCEPTED', metadata: { acceptedAt: new Date().toISOString() } });
      job.state = 'ACCEPTED';
    }
    let record = this.deps.store.snapshot().remoteJobs?.[job.id] as RemoteRuntimeRecord | undefined;
    // A crash after local insertion but before saving its ID must not create
    // a second worker or orphan the first worker's readable input.
    if (record?.cleanup && !record.localJobId) {
      const child = (Object.values(this.deps.store.snapshot().jobs || {}) as LocalJob[])
        .find(local => local.input?.remoteComputeJobId === job.id);
      if (child) {
        await this.deps.store.update(state => {
          (state.remoteJobs![job.id] as RemoteRuntimeRecord).localJobId = child.id;
        });
        record = this.deps.store.snapshot().remoteJobs?.[job.id] as RemoteRuntimeRecord;
      }
    }
    if ((job.state === 'ACCEPTED' || job.state === 'INPUT_READY') && !record?.localJobId) {
      record = await this.providerCleanup.own(job);
      await this.providerCleanup.runPreparation(job.id, async () => {
        const captureId = `remote-${job.id}`;
        const directory = path.join(this.deps.config.localDataPath, 'private', 'remote-jobs', job.id, 'capture');
        const pinOwner = record!.cleanup?.pinOwner;
        if (!pinOwner) throw localError(409, 'legacy_provider_pin_ownership_requires_review');
        await new ManagedPins(this.deps.kubo, this.deps.store).acquire(job.inputCid, pinOwner);
        this.providerCleanup.assertPreparing(job.id);
        const encrypted = await this.deps.kubo.cat(job.inputCid);
        this.providerCleanup.assertPreparing(job.id);
        await this.deps.transport.decryptToDirectory(encrypted, job.inputKeyEnvelope as unknown as ComputeKeyEnvelope, directory, job.inputHash, { nodeId, inputCid: job.inputCid });
        this.providerCleanup.assertPreparing(job.id);
        const capture = await this.readRemoteCapture(captureId, directory);
        await this.deps.captures.registerRemote(capture);
        this.providerCleanup.assertPreparing(job.id);
        const requesterKey = isPrivateOutput(job) ? job.verification?.requesterEncryptionPublicKey : null;
        if (isPrivateOutput(job) && typeof requesterKey !== 'string') throw localError(422, 'private_output_requester_key_unavailable');
        const local = await this.deps.jobs.create(job.type as 'spatial.reconstruct', {
          captureId, artworkId: capture.artworkId, markerId: capture.markerId, remoteComputeJobId: job.id,
          ...(requesterKey ? { privateOutputRequesterPublicKey: requesterKey } : {}),
        });
        await this.deps.store.update(state => {
          const current = state.remoteJobs![job.id] as RemoteRuntimeRecord;
          current.localJobId = local.id; current.state = 'RUNNING'; current.updatedAt = new Date().toISOString();
        });
      });
      record = this.deps.store.snapshot().remoteJobs?.[job.id] as RemoteRuntimeRecord;
    }
    if (record?.localJobId && ['ACCEPTED', 'INPUT_READY'].includes(job.state)) {
      if (job.state === 'ACCEPTED') await this.deps.api.transitionProviderComputeJob(job.id, { nodeId, state: 'INPUT_READY' });
      await this.deps.api.transitionProviderComputeJob(job.id, { nodeId, state: 'RUNNING', metadata: { localJobId: record.localJobId } });
      job.state = 'RUNNING';
    }
    if (job.state === 'RUNNING' && record?.localJobId) {
      const local = this.deps.jobs.get(record.localJobId);
      if (local.state === 'failed' || local.state === 'cancelled') throw localError(500, local.error?.code || 'remote_worker_failed');
      if (local.state === 'completed') await this.submitProviderOutput(job, local, record);
    }
  }

  private async submitProviderOutput(job: RemoteComputeJob, local: LocalJob, record: RemoteRuntimeRecord): Promise<void> {
    const nodeId = this.deps.store.snapshot().nodeId!;
    const spatial = local.output as { manifestCid?: string; manifest?: SpatialManifest; privateOutput?: PrivateOutputCommitment } | undefined;
    const privateOutput = isPrivateOutput(job) ? spatial?.privateOutput : null;
    const outputManifestCid = privateOutput?.manifestCid ?? spatial?.manifestCid;
    const outputCids = privateOutput ? privateOutput.blobs.map(item => item.cid) :
      outputManifestCid && spatial?.manifest ? [outputManifestCid, ...spatial.manifest.variants.map(variant => variant.cid)] : [];
    if (!outputManifestCid || !outputCids.length || (isPrivateOutput(job) && !privateOutput)) {
      throw localError(500, 'remote_output_invalid');
    }
    const payload = { jobId: job.id, inputHash: job.inputHash, jobSpecHash: job.jobSpecHash, outputCids, workerVersion: String(this.deps.store.snapshot().latestHeartbeat?.agentVersion || 'unknown'), protocolVersion: job.protocolVersion, completedAt: new Date().toISOString(),
      ...(privateOutput ? { privateOutput } : {}),
    };
    const signature = await this.deps.identity.signPayload(payload);
    await this.deps.api.submitProviderComputeOutput(job.id, { nodeId, outputManifestCid, outputCids, receipt: { payload, signature } });
    await this.cleanupProvider(job, record);
    await this.updateRecord(job.id, 'provider', 'OUTPUT_READY');
  }

  private async failProviderJob(job: RemoteComputeJob, error: unknown): Promise<void> {
    const nodeId = this.deps.store.snapshot().nodeId;
    const record = this.deps.store.snapshot().remoteJobs?.[job.id] as RemoteRuntimeRecord | undefined;
    if (nodeId && !['FAILED', 'CANCELLED', 'EXPIRED', 'DECLINED'].includes(job.state)) {
      await this.deps.api.transitionProviderComputeJob(job.id, { nodeId, state: 'FAILED', metadata: { code: String((error as { code?: string }).code || 'provider_failed') } }).catch(() => undefined);
    }
    if (record) await this.cleanupProvider(job, record);
    this.deps.logger.warn({ jobId: job.id, code: (error as { code?: string }).code }, 'remote compute provider job failed');
  }

  private async cleanupProvider(job: RemoteComputeJob, _record: RemoteRuntimeRecord): Promise<void> {
    await this.providerCleanup.request(job.id);
  }

  private async releaseEncryptedOutput(jobId: string): Promise<void> {
    const owner = `provider-output:${jobId}`;
    const managed = new ManagedPins(this.deps.kubo, this.deps.store, { allowUnpin: this.deps.config.managedPinReleaseEnabled === true });
    for (const [cid, record] of Object.entries(this.deps.store.snapshot().privateComputeCids || {})) {
      if (record.role !== 'private_output' || record.jobId !== jobId || record.pinOwner !== owner || record.releasedAt) continue;
      await managed.release(cid, owner);
      await this.deps.store.update(state => {
        const saved = state.privateComputeCids?.[cid];
        if (saved?.pinOwner === owner) saved.releasedAt = new Date().toISOString();
      });
    }
  }

  private async releaseRequesterInput(job: RemoteComputeJob): Promise<InputReleaseOutcome> {
    if (!['COMPLETED', 'DISPUTED', 'FAILED', 'CANCELLED', 'EXPIRED', 'DECLINED'].includes(job.state)) {
      throw localError(409, 'remote_compute_not_terminal');
    }
    const owner = this.deps.store.snapshot().privateComputeCids?.[job.inputCid]?.pinOwner;
    if (!owner) return { released: true }; // Legacy/manual ownership requires a separate migration.
    return this.releaseInputPin(job.inputCid, owner);
  }

  private async readRemoteCapture(id: string, directory: string): Promise<CaptureRecord> {
    const manifest = JSON.parse(await fs.readFile(path.join(directory, 'capture.json'), 'utf8')) as Record<string, unknown>;
    const files = Array.isArray(manifest.files) ? manifest.files : [];
    let sizeBytes = 0;
    for (const item of files) { const relative = String((item as { path?: string }).path || ''); if (relative) sizeBytes += (await fs.stat(path.join(directory, relative))).size; }
    // A managed requester's masked dataset is recognised from its files, so the record says it was masked upstream.
    const prepared = (await inspectCapturePackage(directory)).kind === 'prepared';
    return { id, schema: 'kubus.capture/1', state: 'stored', private: true, artworkId: String(manifest.artworkId || ''), markerId: String(manifest.markerId || '') || undefined, capturedAt: String(manifest.capturedAt || new Date().toISOString()), createdAt: new Date().toISOString(), sizeBytes, fileCount: files.length, directory, ...(prepared ? { kind: 'prepared' as const } : {}) };
  }

  private async updateRecord(jobId: string, role: 'requester' | 'provider', stateValue: string): Promise<void> {
    await this.deps.store.update((state) => {
      const previous = state.remoteJobs?.[jobId] as RemoteRuntimeRecord | undefined;
      (state.remoteJobs ??= {})[jobId] = { backendJobId: jobId, role, ...previous, state: stateValue, updatedAt: new Date().toISOString() };
    });
  }
}

function requireUserAuthorization(value: string): void { if (!value.startsWith('Bearer ') || value.length < 20) throw localError(400, 'backend_authorization_required'); }

/**
 * Safe, structured shape for a poll failure. Deliberately narrow — a typed
 * error code, an HTTP status when the failure came from the backend client,
 * and a short message — never the raw error object, which for some SDKs can
 * carry request headers or full URLs (query-string tokens included).
 */
/** The scope the backend named, when its error body carried one. */
function missingScopeFrom(error: unknown): string | undefined {
  const err = error as { details?: { missingScope?: unknown; scope?: unknown }; body?: { missingScope?: unknown; scope?: unknown } };
  const candidate = err?.details?.missingScope ?? err?.details?.scope ?? err?.body?.missingScope ?? err?.body?.scope;
  return typeof candidate === 'string' && candidate.trim() ? candidate.trim() : undefined;
}

function describePollError(error: unknown): { code?: string; status?: number; message: string } {
  const err = error as { code?: string; status?: number; statusCode?: number; message?: string };
  return {
    code: err?.code,
    status: err?.status ?? err?.statusCode,
    message: String(err?.message || error || 'unknown error'),
  };
}
