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
  updatedAt: string;
  reason?: string;
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

  private async release(jobId: string): Promise<void> {
    const record = this.store.snapshot().jobCleanup?.[jobId];
    if (!record || record.state === 'complete') return;
    const job = this.store.snapshot().jobs?.[jobId] as { state?: string } | undefined;
    if (job && ['queued', 'running'].includes(String(job.state))) return;
    try {
      if (record.workerAttempted) {
        if (!this.workerUrl || !record.workerInstanceId) throw new Error('worker_identity_unavailable');
        const response = await fetch(`${this.workerUrl}/v1/jobs/cancel`, {
          method: 'POST', signal: AbortSignal.timeout(20_000),
          headers: { 'Content-Type': 'application/json',
            'X-Kubus-Worker-Authorization': await this.workerAuth.issue(jobId, record.type) },
          body: JSON.stringify({ jobId, type: record.type, workerInstanceId: record.workerInstanceId }),
        });
        const receipt = await response.json() as Record<string, unknown>;
        if (!response.ok || receipt.jobId !== jobId || receipt.cleanupProtocol !== 1 ||
            receipt.quiescent !== true || receipt.workerInstanceId !== record.workerInstanceId) {
          throw new Error('worker_quiescence_unverified');
        }
      }
      // Resolve every existing parent. Reject symlinks/junctions rather than
      // follow a job path into captures, another job, or an external directory.
      await removeOwnedWorkDirectory(this.dataRoot, 'jobs', jobId);
      await this.store.update(state => {
        const current = state.jobCleanup?.[jobId];
        if (current) { current.state = 'complete'; current.reason = undefined; current.updatedAt = new Date().toISOString(); }
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
