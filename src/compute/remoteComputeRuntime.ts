import { promises as fs } from 'node:fs';
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
import { redactSecrets } from '../logging/logBuffer.js';
import { Backoff } from '../scheduler/backoff.js';
import type { LocalStore } from '../state/localStore.js';
import { credentialFingerprint } from './credentialFingerprint.js';
import type { ComputeIdentityService } from './computeIdentity.js';
import { PrivatePayloadTransport, type ComputeKeyEnvelope } from './privatePayloadTransport.js';
import { effectiveComputeProviderSettings, validateComputeProviderSettings, type ComputeProviderSettings } from './providerSettings.js';

interface RemoteRuntimeRecord {
  backendJobId: string;
  localJobId?: string;
  captureId?: string;
  role: 'requester' | 'provider';
  state: string;
  updatedAt: string;
}

const POLL_INTERVAL_MS = 5000;
const POLL_MAX_BACKOFF_MS = 60000;
/** Re-emit a "still failing" summary at most this often, instead of one warning per tick. */
const FAILURE_SUMMARY_INTERVAL_MS = 60000;

export class RemoteComputeRuntime {
  private timer?: NodeJS.Timeout;
  private polling = false;
  private stopped = true;
  private readonly backoff = new Backoff(POLL_INTERVAL_MS, POLL_MAX_BACKOFF_MS);
  private consecutiveFailures = 0;
  private lastFailureLoggedAt = 0;

  constructor(private readonly deps: {
    api: KubusApiClient; kubo: KuboClient; store: LocalStore; config: AppConfig; captures: CaptureStore; jobs: JobRuntime;
    gate: NetworkParticipationGate; identity: ComputeIdentityService; transport: PrivatePayloadTransport; logger: Logger;
  }) {}

  start(): void {
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
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
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
    const recorded = this.deps.store.snapshot().computeAuthorization;
    if (!recorded || recorded.state !== 'AUTHORIZATION_REQUIRED') return false;
    if (!recorded.credentialFingerprint) return true;
    return recorded.credentialFingerprint === this.currentCredentialFingerprint();
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
    this.stop();
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

  async requestJob(input: { authorization: string; captureId: string; provider: ComputeCandidate; requirements: Record<string, unknown>; type?: string }): Promise<RemoteComputeJob> {
    requireUserAuthorization(input.authorization);
    await this.deps.gate.assertUsefulOperation('remote_compute_submission');
    if (!input.provider?.nodeId || !input.provider.encryptionPublicKey) throw localError(400, 'compute_provider_invalid');
    const encrypted = await this.deps.transport.encryptCapture(input.captureId, input.provider.nodeId, input.provider.encryptionPublicKey);
    try {
      const job = await this.deps.api.createRemoteComputeJob({
        providerNodeId: input.provider.nodeId,
        requesterNodeId: this.deps.store.snapshot().nodeId,
        type: input.type || 'spatial.reconstruct',
        requirements: input.requirements,
        ...encrypted,
      }, input.authorization);
      await this.deps.store.update((state) => {
        (state.remoteJobs ??= {})[job.id] = { backendJobId: job.id, role: 'requester', state: job.state, updatedAt: new Date().toISOString() } satisfies RemoteRuntimeRecord;
        const privateCid = state.privateComputeCids?.[encrypted.inputCid]; if (privateCid) privateCid.jobId = job.id;
      });
      return job;
    } catch (error) {
      await this.deps.kubo.pinRm(encrypted.inputCid).catch(() => undefined);
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
    const manifestBytes = await this.deps.kubo.cat(job.outputManifestCid);
    let manifest: SpatialManifest;
    try { manifest = validateSpatialManifest(JSON.parse(Buffer.from(manifestBytes).toString('utf8'))); } catch { throw localError(422, 'remote_compute_manifest_invalid'); }
    const declared = new Set(job.outputCids);
    if (!declared.has(job.outputManifestCid) || manifest.variants.some((variant) => !declared.has(variant.cid))) throw localError(422, 'remote_compute_output_cid_mismatch');
    for (const cid of job.outputCids) { await this.deps.kubo.catHead(cid, 1); await this.deps.kubo.pinAdd(cid); }
    const id = manifest.id;
    const record = { id, state: 'private_remote', manifestCid: job.outputManifestCid, manifest, createdAt: new Date().toISOString(), privateSourceCapture: true, remoteComputeJobId: job.id };
    await this.deps.store.update((state) => { (state.spatial ??= {})[id] = record; });
    return record;
  }

  async acknowledgeRequesterOutput(jobId: string, authorization: string, accepted: boolean, reason?: string): Promise<RemoteComputeJob> {
    requireUserAuthorization(authorization);
    const job = await this.deps.api.getRemoteComputeJob(jobId, authorization);
    const payload = { jobId: job.id, inputHash: job.inputHash, jobSpecHash: job.jobSpecHash, outputCids: job.outputCids, accepted, reason: reason || null, acknowledgedAt: new Date().toISOString(), protocolVersion: job.protocolVersion };
    const signature = await this.deps.identity.signPayload(payload);
    const updated = await this.deps.api.acknowledgeRemoteComputeJob(jobId, { accepted, receipt: { payload, signature } }, authorization);
    if (['COMPLETED', 'DISPUTED', 'FAILED', 'CANCELLED'].includes(updated.state)) await this.releaseRequesterInput(updated);
    await this.updateRecord(updated.id, 'requester', updated.state);
    return updated;
  }

  async cancelRequesterJob(jobId: string, authorization: string): Promise<RemoteComputeJob> {
    requireUserAuthorization(authorization);
    const job = await this.deps.api.cancelRemoteComputeJob(jobId, authorization);
    await this.releaseRequesterInput(job); await this.updateRecord(job.id, 'requester', job.state); return job;
  }

  /** Returns the delay before the next poll: the normal interval on success, a growing backoff on failure. */
  private async pollProvider(): Promise<number> {
    const settings = this.settings();
    if (this.polling || !settings.enabled || settings.paused) return POLL_INTERVAL_MS;
    const nodeId = this.deps.store.snapshot().nodeId;
    if (!nodeId) return POLL_INTERVAL_MS;
    this.polling = true;
    try {
      const { jobs } = await this.deps.api.getProviderComputeJobs(nodeId, ['MATCHED', 'ACCEPTED', 'INPUT_READY', 'RUNNING', 'OUTPUT_READY']);
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
    if (job.state === 'MATCHED') {
      await this.deps.gate.assertUsefulOperation('remote_compute_acceptance');
      const settings = this.settings();
      const active = Object.values(this.deps.store.snapshot().remoteJobs || {}).filter((item) => {
        const record = item as RemoteRuntimeRecord;
        return record.role === 'provider' && ['ACCEPTED', 'INPUT_READY', 'RUNNING'].includes(record.state);
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
    if (job.state === 'ACCEPTED' || (job.state === 'INPUT_READY' && !record?.localJobId)) {
      const captureId = `remote-${job.id}`;
      const directory = path.join(this.deps.config.localDataPath, 'private', 'remote-jobs', job.id, 'capture');
      await this.deps.kubo.pinAdd(job.inputCid);
      const encrypted = await this.deps.kubo.cat(job.inputCid);
      await this.deps.transport.decryptToDirectory(encrypted, job.inputKeyEnvelope as unknown as ComputeKeyEnvelope, directory, job.inputHash);
      const capture = await this.readRemoteCapture(captureId, directory);
      await this.deps.captures.registerRemote(capture);
      if (job.state === 'ACCEPTED') await this.deps.api.transitionProviderComputeJob(job.id, { nodeId, state: 'INPUT_READY' });
      const local = await this.deps.jobs.create(job.type as 'spatial.reconstruct', { captureId, artworkId: capture.artworkId, markerId: capture.markerId, remoteComputeJobId: job.id });
      await this.deps.api.transitionProviderComputeJob(job.id, { nodeId, state: 'RUNNING', metadata: { localJobId: local.id } });
      record = { backendJobId: job.id, localJobId: local.id, captureId, role: 'provider', state: 'RUNNING', updatedAt: new Date().toISOString() };
      await this.deps.store.update((state) => { (state.remoteJobs ??= {})[job.id] = record!; });
      return;
    }
    if (job.state === 'RUNNING' && record?.localJobId) {
      const local = this.deps.jobs.get(record.localJobId);
      if (local.state === 'failed' || local.state === 'cancelled') throw localError(500, local.error?.code || 'remote_worker_failed');
      if (local.state === 'completed') await this.submitProviderOutput(job, local, record);
    }
  }

  private async submitProviderOutput(job: RemoteComputeJob, local: LocalJob, record: RemoteRuntimeRecord): Promise<void> {
    const nodeId = this.deps.store.snapshot().nodeId!;
    const spatial = local.output as { manifestCid?: string; manifest?: SpatialManifest } | undefined;
    if (!spatial?.manifestCid || !spatial.manifest) throw localError(500, 'remote_output_invalid');
    const outputCids = [spatial.manifestCid, ...spatial.manifest.variants.map((variant) => variant.cid)];
    const payload = { jobId: job.id, inputHash: job.inputHash, jobSpecHash: job.jobSpecHash, outputCids, workerVersion: String(this.deps.store.snapshot().latestHeartbeat?.agentVersion || 'unknown'), protocolVersion: job.protocolVersion, completedAt: new Date().toISOString() };
    const signature = await this.deps.identity.signPayload(payload);
    await this.deps.api.submitProviderComputeOutput(job.id, { nodeId, outputManifestCid: spatial.manifestCid, outputCids, receipt: { payload, signature } });
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

  private async cleanupProvider(job: RemoteComputeJob, record: RemoteRuntimeRecord): Promise<void> {
    if (record.captureId) await this.deps.captures.removeRemote(record.captureId).catch(() => undefined);
    await fs.rm(path.join(this.deps.config.localDataPath, 'private', 'remote-jobs', job.id), { recursive: true, force: true });
    await this.deps.kubo.pinRm(job.inputCid).catch(() => undefined);
  }

  private async releaseRequesterInput(job: RemoteComputeJob): Promise<void> {
    await this.deps.kubo.pinRm(job.inputCid).catch(() => undefined);
    await this.deps.store.update((state) => { const item = state.privateComputeCids?.[job.inputCid]; if (item) item.releasedAt = new Date().toISOString(); });
  }

  private async readRemoteCapture(id: string, directory: string): Promise<CaptureRecord> {
    const manifest = JSON.parse(await fs.readFile(path.join(directory, 'capture.json'), 'utf8')) as Record<string, unknown>;
    const files = Array.isArray(manifest.files) ? manifest.files : [];
    let sizeBytes = 0;
    for (const item of files) { const relative = String((item as { path?: string }).path || ''); if (relative) sizeBytes += (await fs.stat(path.join(directory, relative))).size; }
    return { id, schema: 'kubus.capture/1', state: 'stored', private: true, artworkId: String(manifest.artworkId || ''), markerId: String(manifest.markerId || '') || undefined, capturedAt: String(manifest.capturedAt || new Date().toISOString()), createdAt: new Date().toISOString(), sizeBytes, fileCount: files.length, directory };
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
