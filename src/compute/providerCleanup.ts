import path from 'node:path';
import type { RemoteComputeJob } from '../backend/models.js';
import type { LocalStore } from '../state/localStore.js';
import type { LocalJob, JobRuntime } from '../jobs/jobRuntime.js';
import {
  jobIdPattern,
  removeOwnedWorkDirectory,
} from '../jobs/ownedWorkDirectory.js';

export interface ProviderCleanupState {
  version: 1;
  inputCid: string;
  expiresAt: string;
  requested: boolean;
  plaintext: 'pending' | 'blocked' | 'complete';
  inputPinReleasePending: boolean;
  reason?: string;
}
export interface RemoteRuntimeRecord {
  backendJobId: string;
  localJobId?: string;
  captureId?: string;
  role: 'requester' | 'provider';
  state: string;
  updatedAt: string;
  cleanup?: ProviderCleanupState;
}

/** Journals ownership before download/decryption; retries plaintext cleanup independently of backend availability. */
export class ProviderCleanup {
  private readonly preparing = new Map<string, Promise<unknown>>();
  private readonly inFlight = new Map<string, Promise<void>>();
  constructor(
    private readonly store: LocalStore,
    private readonly jobs: JobRuntime,
    private readonly dataRoot: string,
  ) {}

  async own(job: RemoteComputeJob): Promise<RemoteRuntimeRecord> {
    if (
      !jobIdPattern.test(job.id) ||
      !job.inputCid ||
      !Number.isFinite(Date.parse(job.expiresAt))
    )
      throw new Error('provider_job_identity_invalid');
    let result!: RemoteRuntimeRecord;
    await this.store.update((state) => {
      const previous = state.remoteJobs?.[job.id] as
        | RemoteRuntimeRecord
        | undefined;
      if (previous && (!previous.cleanup || previous.role !== 'provider'))
        throw new Error('legacy_provider_ownership_requires_review');
      result = previous ?? {
        backendJobId: job.id,
        captureId: `remote-${job.id}`,
        role: 'provider',
        state: 'PREPARING',
        updatedAt: new Date().toISOString(),
        cleanup: {
          version: 1,
          inputCid: job.inputCid,
          expiresAt: job.expiresAt,
          requested: false,
          plaintext: 'pending',
          inputPinReleasePending: true,
        },
      };
      if (
        result.cleanup!.inputCid !== job.inputCid ||
        result.cleanup!.requested ||
        result.cleanup!.plaintext === 'complete'
      )
        throw new Error('provider_job_not_reusable');
      (state.remoteJobs ??= {})[job.id] = result;
    });
    return result;
  }

  runPreparation<T>(id: string, work: () => Promise<T>): Promise<T> {
    if (this.preparing.has(id))
      throw new Error('provider_preparation_in_progress');
    const task = Promise.resolve()
      .then(() => {
        this.assertPreparing(id);
        return work();
      })
      .finally(() => this.preparing.delete(id));
    this.preparing.set(id, task);
    return task;
  }

  assertPreparing(id: string): void {
    const record = this.store.snapshot().remoteJobs?.[id] as
      | RemoteRuntimeRecord
      | undefined;
    if (
      !record?.cleanup ||
      record.cleanup.requested ||
      record.cleanup.plaintext === 'complete' ||
      Date.parse(record.cleanup.expiresAt) <= Date.now()
    ) {
      throw new Error('provider_preparation_cancelled_or_expired');
    }
  }

  async request(id: string): Promise<void> {
    await this.store.update((state) => {
      const record = state.remoteJobs?.[id] as RemoteRuntimeRecord | undefined;
      if (!record?.cleanup || record.role !== 'provider')
        throw new Error('provider_cleanup_ownership_unverified');
      record.cleanup.requested = true;
      record.updatedAt = new Date().toISOString();
    });
    await this.reconcile(id);
  }

  async reconcilePending(): Promise<void> {
    for (const item of Object.values(this.store.snapshot().remoteJobs || {})) {
      const record = item as RemoteRuntimeRecord;
      if (
        record.role !== 'provider' ||
        !record.cleanup ||
        record.cleanup.plaintext === 'complete'
      )
        continue;
      if (
        !record.cleanup.requested &&
        Date.parse(record.cleanup.expiresAt) > Date.now()
      )
        continue;
      await this.request(record.backendJobId).catch(() => undefined);
    }
  }

  reconcile(id: string): Promise<void> {
    const active = this.inFlight.get(id);
    if (active) return active;
    const work = this.release(id).finally(() => this.inFlight.delete(id));
    this.inFlight.set(id, work);
    return work;
  }

  private async release(id: string): Promise<void> {
    const record = this.store.snapshot().remoteJobs?.[id] as
      | RemoteRuntimeRecord
      | undefined;
    if (
      !record?.cleanup ||
      record.role !== 'provider' ||
      !record.cleanup.requested ||
      !jobIdPattern.test(id)
    )
      throw new Error('provider_cleanup_ownership_unverified');
    if (record.cleanup.plaintext === 'complete') return;
    try {
      // An early failure/expiry must not delete a directory while download or
      // decryption can still create files beneath it.
      await this.preparing.get(id)?.catch(() => undefined);
      const captureId = `remote-${id}`;
      if (record.captureId !== captureId)
        throw new Error('provider_capture_owner_mismatch');
      const localJobs = (
        Object.values(this.store.snapshot().jobs || {}) as LocalJob[]
      ).filter(
        (job) =>
          job.input?.remoteComputeJobId === id ||
          job.input?.captureId === captureId,
      );
      const localIds = new Set(localJobs.map((job) => job.id));
      if (record.localJobId) localIds.add(record.localJobId);
      for (const localId of localIds)
        await this.jobs.ensureJobQuiescent(localId);
      const capture = this.store.snapshot().captures?.[captureId] as
        | { directory?: string }
        | undefined;
      const expected = path.resolve(
        this.dataRoot,
        'private',
        'remote-jobs',
        id,
        'capture',
      );
      if (capture && path.resolve(String(capture.directory || '')) !== expected)
        throw new Error('provider_capture_path_mismatch');
      await removeOwnedWorkDirectory(this.dataRoot, 'remote-jobs', id);
      await this.store.update((state) => {
        if (state.captures) delete state.captures[captureId];
        const current = state.remoteJobs?.[id] as RemoteRuntimeRecord;
        current.cleanup!.plaintext = 'complete';
        current.cleanup!.reason = undefined;
        current.updatedAt = new Date().toISOString();
      });
      // Ciphertext pin release is deliberately separate. Plaintext cleanup is
      // not proof that a shared or manually pinned CID may be unpinned.
    } catch (error) {
      await this.store.update((state) => {
        const current = state.remoteJobs?.[id] as RemoteRuntimeRecord;
        current.cleanup!.plaintext = 'blocked';
        current.cleanup!.reason = 'provider_cleanup_retry_required';
        current.updatedAt = new Date().toISOString();
      });
      throw error;
    }
  }
}
