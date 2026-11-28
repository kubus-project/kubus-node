import { jobIdPattern, removeOwnedWorkDirectory } from './ownedWorkDirectory.js';
import type { LocalStore } from '../state/localStore.js';
import type { WorkerAuthService } from '../spatial/workerAuth.js';

export interface JobCleanupRecord {
  version: 1;
  jobId: string;
  type: string;
  state: 'pending' | 'blocked' | 'complete';
  workerInstanceId?: string;
  workerAttempted: boolean;
  /** Set when the work directory was removed: false means there was nothing to remove (a cleanup attestation reads this). */
  removed?: boolean;
  updatedAt: string;
  /** `worker_restarted` when the worker that ran the job was replaced by a new process before it was cleaned up. */
  reason?: string;
  replacedWorkerInstanceId?: string;
}

/** Only newly journaled job-owned directories are eligible, never legacy paths. */
export class JobCleanup {
  private readonly locks = new Map<string, Promise<void>>();
  constructor(private readonly store: LocalStore, private readonly dataRoot: string,
    private readonly workerAuth: WorkerAuthService, private readonly workerUrl?: string) {}

  async own(jobId: string, type: string): Promise<void> {
    if (!jobIdPattern.test(jobId)) throw new Error('cleanup_job_id_invalid');
    await this.store.update(state => {
      if (state.jobCleanup?.[jobId]) throw new Error('cleanup_job_already_owned');
      (state.jobCleanup ??= {})[jobId] = { version: 1, jobId, type, state: 'pending',
        workerAttempted: false, updatedAt: new Date().toISOString() };
    });
  }

  async markWorkerAttempt(jobId: string, instanceId: string): Promise<void> {
    if (!jobIdPattern.test(instanceId)) throw new Error('worker_cleanup_protocol_required');
    await this.store.update(state => {
      const record = state.jobCleanup?.[jobId];
      if (!record || record.state === 'complete') throw new Error('cleanup_not_owned');
      record.workerInstanceId = instanceId;
      record.workerAttempted = true;
      record.updatedAt = new Date().toISOString();
    });
  }

  reconcile(jobId: string): Promise<void> {
    const active = this.locks.get(jobId);
    if (active) return active;
    const work = this.release(jobId).finally(() => this.locks.delete(jobId));
    this.locks.set(jobId, work);
    return work;
  }

  /** POSTs the cancel and requires a quiescent receipt for exactly this job and instance. */
  private async cancelOnWorker(jobId: string, type: string, instanceId: string): Promise<{ ok: boolean; instanceChanged: boolean }> {
    const response = await fetch(`${this.workerUrl}/v1/jobs/cancel`, {
      method: 'POST', signal: AbortSignal.timeout(20_000),
      headers: { 'Content-Type': 'application/json',
        'X-Kubus-Worker-Authorization': await this.workerAuth.issue(jobId, type, { purpose: 'cancel' }) },
      body: JSON.stringify({ jobId, type, workerInstanceId: instanceId }),
    });
    const receipt = await response.json().catch(() => ({})) as Record<string, unknown>;
    if (response.ok && receipt.jobId === jobId && receipt.cleanupProtocol === 1 &&
        receipt.quiescent === true && receipt.workerInstanceId === instanceId) return { ok: true, instanceChanged: false };
    return { ok: false, instanceChanged: response.status === 409 && receipt.detail === 'worker_instance_changed' };
  }

  /**
   * The id of the worker now answering, only when it is one that ends its predecessor's processes at start
   * (`reapsOrphans`, worker 13 onward). A worker that cannot promise that may have a training process of the
   * replaced instance still writing into the directory about to be removed, so its new id proves nothing.
   */
  private async currentInstanceId(): Promise<string | undefined> {
    const response = await fetch(`${this.workerUrl}/health`, { signal: AbortSignal.timeout(20_000) });
    if (!response.ok) return undefined;
    const health = await response.json().catch(() => ({})) as { cleanupProtocol?: unknown; workerInstanceId?: unknown; reapsOrphans?: unknown };
    return health.cleanupProtocol === 1 && health.reapsOrphans === true && typeof health.workerInstanceId === 'string' && jobIdPattern.test(health.workerInstanceId)
      ? health.workerInstanceId : undefined;
  }

  private async release(jobId: string): Promise<void> {
    const record = this.store.snapshot().jobCleanup?.[jobId];
    if (!record || record.state === 'complete') return;
    const job = this.store.snapshot().jobs?.[jobId] as { state?: string } | undefined;
    if (job && ['queued', 'running'].includes(String(job.state))) return;
    try {
      let restartedFrom: string | undefined;
      if (record.workerAttempted) {
        if (!this.workerUrl || !record.workerInstanceId) throw new Error('worker_identity_unavailable');
        const first = await this.cancelOnWorker(jobId, record.type, record.workerInstanceId);
        if (!first.ok) {
          // A worker that answers for a different instance id is a new process: the one that ran this job is gone
          // (a crash, an image update or a container recreate), so it cannot still be writing into the work
          // directory. Anything else (unreachable, same instance not quiescent, a malformed receipt) fails closed.
          if (!first.instanceChanged) throw new Error('worker_quiescence_unverified');
          const current = await this.currentInstanceId();
          if (!current || current === record.workerInstanceId) throw new Error('worker_quiescence_unverified');
          // Leave a tombstone for this job id with the new instance too, so a late request for it is refused.
          const second = await this.cancelOnWorker(jobId, record.type, current);
          if (!second.ok) throw new Error('worker_quiescence_unverified');
          restartedFrom = record.workerInstanceId;
        }
      }
      // Resolve every existing parent. Reject symlinks/junctions rather than
      // follow a job path into captures, another job, or an external directory.
      const removed = await removeOwnedWorkDirectory(this.dataRoot, 'jobs', jobId);
      await this.store.update(state => {
        const current = state.jobCleanup?.[jobId];
        if (current) {
          current.state = 'complete'; current.removed = removed; current.updatedAt = new Date().toISOString();
          current.reason = restartedFrom ? 'worker_restarted' : undefined;
          current.replacedWorkerInstanceId = restartedFrom;
        }
      });
    } catch (error) {
      await this.store.update(state => {
        const current = state.jobCleanup?.[jobId];
        if (current) { current.state = 'blocked'; current.reason = 'cleanup_retry_required'; current.updatedAt = new Date().toISOString(); }
      });
      throw error;
    }
  }
}
