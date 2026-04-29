import type { KubusApiClient } from '../backend/kubusApiClient.js';
import type { AppConfig } from '../config/schema.js';
import type { KuboClient } from '../ipfs/kuboClient.js';
import type { Logger } from '../logging/logger.js';
import type { LocalStore } from '../state/localStore.js';
import { sleep, jitterMs } from '../utils/time.js';
import { syncRewardableCids, reconcileDesiredPins, refreshCommitments } from '../operator/commitments.js';
import { sendHeartbeat } from '../operator/heartbeat.js';
import { refreshRewards } from '../operator/rewards.js';
import { refreshStatus } from '../operator/status.js';

export class Scheduler {
  private stopped = false;
  private controllers: Promise<void>[] = [];

  constructor(
    private readonly deps: { api: KubusApiClient; kubo: KuboClient; store: LocalStore; config: AppConfig; logger: Logger },
  ) {}

  start(): void {
    this.controllers = [
      this.loop('policy', this.deps.config.cidSyncIntervalMs, async () => {
        const policy = await this.deps.api.getPolicies();
        await this.deps.store.update((state) => {
          state.policy = policy;
        });
      }),
      this.loop('cid-sync', this.deps.config.cidSyncIntervalMs, async () => {
        await syncRewardableCids(this.deps.api, this.deps.store, this.deps.config);
      }),
      this.loop('pin-reconcile', Math.max(30000, Math.floor(this.deps.config.cidSyncIntervalMs / 2)), async () => {
        await reconcileDesiredPins(this.deps.kubo, this.deps.store, this.deps.config);
      }),
      this.loop('commitments', this.deps.config.commitmentIntervalMs, async () => {
        await refreshCommitments(this.deps.api, this.deps.kubo, this.deps.store, this.deps.config);
      }),
      this.loop('heartbeat', this.deps.config.heartbeatIntervalMs, async () => {
        await sendHeartbeat(this.deps.api, this.deps.kubo, this.deps.store, this.deps.config);
      }),
      this.loop('status-rewards', this.deps.config.statusIntervalMs, async () => {
        await refreshStatus(this.deps.api, this.deps.kubo, this.deps.store);
        await refreshRewards(this.deps.api, this.deps.store);
      }),
    ];
  }

  async stop(): Promise<void> {
    this.stopped = true;
    await Promise.race([Promise.allSettled(this.controllers), sleep(10000)]);
  }

  private async loop(name: string, intervalMs: number, task: () => Promise<void>): Promise<void> {
    while (!this.stopped) {
      try {
        await task();
      } catch (error) {
        this.deps.logger.warn({ loop: name, error: String((error as Error).message || error) }, 'scheduler loop failed');
      }
      await sleep(jitterMs(intervalMs));
    }
  }
}
