import type { KubusApiClient } from '../backend/kubusApiClient.js';
import type { AppConfig } from '../config/schema.js';
import type { KuboClient } from '../ipfs/kuboClient.js';
import { redactSecrets } from '../logging/logBuffer.js';
import type { Logger } from '../logging/logger.js';
import type { ActionLock } from '../runtime/actionLock.js';
import type { LocalStore } from '../state/localStore.js';
import { sleep, jitterMs } from '../utils/time.js';
import { Backoff } from './backoff.js';
import { syncPublicPinSet, reconcileDesiredPins, refreshCommitments } from '../operator/commitments.js';
import { sendHeartbeat } from '../operator/heartbeat.js';
import { refreshRewards } from '../operator/rewards.js';
import { refreshStatus } from '../operator/status.js';
import type { NetworkParticipationGate } from '../participation/networkParticipationGate.js';
import type { ComputeIdentityService } from '../compute/computeIdentity.js';
import type { CapabilityRegistry } from '../capabilities/registry.js';

/** Re-emit a "still failing" summary at most this often per loop, instead of one warning per tick. */
const LOOP_FAILURE_SUMMARY_INTERVAL_MS = 60000;
/** Ceiling for a single backend-dependent loop's backoff, independent of its own configured interval. */
const LOOP_MAX_BACKOFF_MS = 60000;
/** Spacing between loops' first tick, so six loops hitting a known-down backend at startup produce a
 * staggered trickle of failures rather than one simultaneous burst of identical log lines. */
const LOOP_STARTUP_STAGGER_MS = 1500;

export class Scheduler {
  private stopped = false;
  private controllers: Promise<void>[] = [];

  constructor(
    private readonly deps: { api: KubusApiClient; kubo: KuboClient; store: LocalStore; config: AppConfig; logger: Logger; gate: NetworkParticipationGate; identity: ComputeIdentityService; capabilities: CapabilityRegistry; actionLock?: ActionLock },
  ) {}

  start(): void {
    this.deps.gate.setSchedulerActive(true);
    const specs: Array<{ name: string; intervalMs: number; task: () => Promise<void> }> = [
      {
        name: 'policy',
        intervalMs: this.deps.config.cidSyncIntervalMs,
        task: async () => {
          const policy = await this.deps.api.getPolicies();
          await this.deps.store.update((state) => {
            state.policy = policy;
          });
        },
      },
      {
        name: 'cid-sync',
        intervalMs: this.deps.config.cidSyncIntervalMs,
        task: async () => {
          await syncPublicPinSet(this.deps.api, this.deps.store, this.deps.config);
          const state = this.deps.store.snapshot();
          this.deps.logger.info({
            publicPinSetCount: state.publicPinSet.length,
            desiredCidCount: state.desiredCids.length,
            rewardableCidCount: state.rewardableCids.length,
          }, 'public pin set synced');
        },
      },
      {
        name: 'pin-reconcile',
        intervalMs: Math.max(30000, Math.floor(this.deps.config.cidSyncIntervalMs / 2)),
        task: async () => {
          await reconcileDesiredPins(this.deps.kubo, this.deps.store, this.deps.config);
          const state = this.deps.store.snapshot();
          this.deps.logger.info({
            desiredCidCount: state.desiredCids.length,
            pinnedCidCount: state.pinnedCids.length,
            failedCidCount: Object.keys(state.failedCids).length,
          }, 'public pin reconcile completed');
        },
      },
      {
        name: 'commitments',
        intervalMs: this.deps.config.commitmentIntervalMs,
        task: async () => {
          await refreshCommitments(this.deps.api, this.deps.kubo, this.deps.store, this.deps.config);
          this.deps.logger.info({ activeCommitmentCount: this.deps.store.snapshot().activeCommitments.length }, 'reward commitments refreshed');
        },
      },
      {
        name: 'heartbeat',
        intervalMs: this.deps.config.heartbeatIntervalMs,
        task: async () => {
          await sendHeartbeat(this.deps.api, this.deps.kubo, this.deps.store, this.deps.config, this.deps.capabilities, this.deps.gate, this.deps.identity);
          const state = this.deps.store.snapshot();
          this.deps.logger.info({
            status: state.latestStatus?.status,
            trackedCidCount: state.desiredCids.length,
            pinnedCidCount: state.pinnedCids.length,
            failedCidCount: Object.keys(state.failedCids).length,
          }, 'availability heartbeat sent');
        },
      },
      {
        name: 'status-rewards',
        intervalMs: this.deps.config.statusIntervalMs,
        task: async () => {
          await refreshStatus(this.deps.api, this.deps.kubo, this.deps.store);
          await refreshRewards(this.deps.api, this.deps.store);
        },
      },
    ];
    this.controllers = specs.map((spec, index) =>
      this.loop(spec.name, spec.intervalMs, spec.task, index * LOOP_STARTUP_STAGGER_MS),
    );
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.deps.gate.setSchedulerActive(false);
    await Promise.race([Promise.allSettled(this.controllers), sleep(10000)]);
  }

  private loop(name: string, intervalMs: number, task: () => Promise<void>, startupDelayMs = 0): Promise<void> {
    return runResilientLoop({
      name,
      intervalMs,
      task: this.deps.actionLock ? () => this.deps.actionLock!.run(`scheduler:${name}`, task) : task,
      logger: this.deps.logger,
      startupDelayMs,
      isStopped: () => this.stopped,
    });
  }
}

export interface ResilientLoopOptions {
  name: string;
  intervalMs: number;
  task: () => Promise<void>;
  logger: Logger;
  isStopped: () => boolean;
  startupDelayMs?: number;
  /** Overridable for tests only — production always uses the real clock via `sleep`/`Date.now`. */
  maxBackoffMs?: number;
  failureSummaryIntervalMs?: number;
}

/**
 * Runs [task] on [intervalMs] (jittered) until [isStopped] reports true.
 *
 * A failing task does not retry on the normal interval — it backs off
 * (5s→10s→20s→30s→60s-capped, with jitter, reset on success) so a known-down
 * dependency is not hammered forever. Logging only happens on a
 * healthy→failing transition and then at most once per
 * [failureSummaryIntervalMs] while still failing, plus one line on
 * failing→recovered — never one identical warning per tick. [startupDelayMs]
 * staggers this loop's first tick relative to sibling loops, so several
 * loops hitting a known-down backend at cold start produce a trickle of
 * failures rather than one simultaneous burst of identical log lines.
 */
export async function runResilientLoop(options: ResilientLoopOptions): Promise<void> {
  const { name, intervalMs, task, logger, isStopped, startupDelayMs = 0 } = options;
  const maxBackoffMs = options.maxBackoffMs ?? LOOP_MAX_BACKOFF_MS;
  const failureSummaryIntervalMs = options.failureSummaryIntervalMs ?? LOOP_FAILURE_SUMMARY_INTERVAL_MS;

  if (startupDelayMs > 0) await sleep(startupDelayMs);

  const backoff = new Backoff(intervalMs, maxBackoffMs);
  let consecutiveFailures = 0;
  let lastFailureLoggedAt = 0;

  while (!isStopped()) {
    let delayMs = jitterMs(intervalMs);
    try {
      await task();
      if (consecutiveFailures > 0) {
        logger.info({ loop: name, consecutiveFailures }, 'scheduler loop recovered');
      }
      consecutiveFailures = 0;
      lastFailureLoggedAt = 0;
      backoff.success();
    } catch (error) {
      const described = describeLoopError(error);
      // Losing a race for the shared action lock is contention, not failure:
      // the other loop is doing the work right now, and this one simply runs
      // on its next tick. Treating it as a failure reset no state but did
      // spend a warning and a backoff step, so a busy node logged
      // "scheduler loop failed" for loops that were perfectly healthy.
      if (isActionLockContention(described)) {
        logger.debug?.(
          { loop: name, ...described },
          'scheduler loop skipped — another action holds the lock',
        );
        await sleep(delayMs);
        continue;
      }
      consecutiveFailures += 1;
      delayMs = backoff.failure();
      const now = Date.now();
      const isStateTransition = consecutiveFailures === 1;
      const summaryDue = now - lastFailureLoggedAt >= failureSummaryIntervalMs;
      if (isStateTransition || summaryDue) {
        lastFailureLoggedAt = now;
        logger.warn(
          redactSecrets({
            loop: name,
            ...described,
            consecutiveFailures,
            nextRetryMs: delayMs,
          }),
          'scheduler loop failed',
        );
      }
    }
    await sleep(delayMs);
  }
}

/**
 * Safe, structured shape for a loop failure — a typed code and HTTP status
 * when the error came from the backend client, plus a short message. Never
 * the raw error object, which can carry request headers or full URLs.
 */
function describeLoopError(error: unknown): { code?: string; status?: number; message: string } {
  const err = error as { code?: string; status?: number; statusCode?: number; message?: string };
  return {
    code: err?.code,
    status: err?.status ?? err?.statusCode,
    message: String(err?.message || error || 'unknown error'),
  };
}

/// The shared [ActionLock] rejects a second concurrent runner with HTTP 409
/// and an "Action already running" message.
function isActionLockContention(
  described: { status?: number; message: string },
): boolean {
  return described.status === 409 && described.message.includes('Action already running');
}
