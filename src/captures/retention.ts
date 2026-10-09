import type { KuboClient } from '../ipfs/kuboClient.js';
import type { LocalStore } from '../state/localStore.js';
import type { SpatialStoreRecord } from '../spatial/spatialRecords.js';
import type { CaptureRecord } from './captureStore.js';

/**
 * Source-capture retention.
 *
 * A capture is the private, raw material a scene was made from, and on this
 * Node the owner's only copy of it. The rule is therefore KEEP, and everything
 * here exists to make deleting one an explicit, narrow, reversible-until-it-
 * happens decision:
 *
 * - **Two keys.** The capture itself must carry an authorization recorded when
 *   it was uploaded (`deleteAfter` a date, or `deleteAfterPublication`), *and*
 *   the operator must have turned the sweeper on for this Node. Neither alone
 *   deletes anything. Off is the default; `dry-run` reports what would go.
 * - **Never the only copy.** A capture is removed only when every scene made
 *   from it has its reconstruction master preserved *and locally complete* in
 *   Kubo, and at least one scene exists. A capture whose processing never
 *   produced a result, or whose result is no longer on this Node, is kept
 *   however overdue: it may be the only thing left.
 * - **Not merely because a derivative exists.** Having a preview or a runtime
 *   representation authorizes nothing. Only the capture's own request does.
 * - **Never in use.** Queued or running jobs, and uploads still in progress,
 *   are out of scope.
 * - **Bounded.** A grace period after upload, and a cap on deletions per sweep,
 *   so a client that sends a nonsense date or a clock that jumps forward costs
 *   a bounded, reported amount at worst.
 *
 * The sweeper removes only the capture's own directory and record. It never
 * touches Kubo, pins, scene records or manifests.
 */

export interface CaptureRetention {
  /** An instant (ISO 8601 with an explicit offset, or a date taken as UTC midnight). */
  deleteAfter?: string;
  /** Delete once a scene made from this capture has been published. */
  deleteAfterPublication?: boolean;
}

export type RetentionMode = 'off' | 'dry-run' | 'on';

const DATE_TIME = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,3})?)?(Z|[+-](\d{2}):(\d{2})))?$/;

function daysInMonth(year: number, month: number): number {
  if (month === 2) return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0) ? 29 : 28;
  return [4, 6, 9, 11].includes(month) ? 30 : 31;
}

/**
 * Milliseconds since the epoch for a retention date, or undefined for anything
 * that is not an unambiguous, real ISO 8601 instant: a date, or a date and time
 * with an explicit offset.
 *
 * `Date.parse` alone is not safe for a deletion deadline. V8 reads "1" as the
 * year 2001 (an expired deadline), reads a time with no offset in local time,
 * and quietly rolls 2026-02-30 into March and 24:00 into the next day. Fields
 * are checked here first, so what is parsed is what was written.
 */
export function parseRetentionInstant(value: unknown): number | undefined {
  if (typeof value !== 'string') return undefined;
  const text = value.trim();
  if (text.length > 40) return undefined;
  const match = DATE_TIME.exec(text);
  if (!match) return undefined;
  const [, y, mo, d, h, mi, sec, offset, offsetH, offsetM] = match;
  const year = Number(y);
  const month = Number(mo);
  if (year < 1970 || year > 9999 || month < 1 || month > 12 || Number(d) < 1 || Number(d) > daysInMonth(year, month)) return undefined;
  if (h !== undefined && (Number(h) > 23 || Number(mi) > 59 || (sec !== undefined && Number(sec) > 59))) return undefined;
  if (offset !== undefined && offset !== 'Z' && (Number(offsetH) > 23 || Number(offsetM) > 59)) return undefined;
  const parsed = Date.parse(h === undefined ? `${text}T00:00:00.000Z` : text);
  return Number.isFinite(parsed) ? parsed : undefined;
}

/** What a client sent as `retention`, reduced to what this Node understands; anything else is dropped, which means KEEP. */
export function normalizeRetention(value: unknown): CaptureRetention | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const raw = value as Record<string, unknown>;
  const retention: CaptureRetention = {};
  const instant = parseRetentionInstant(raw.deleteAfter);
  if (instant !== undefined) retention.deleteAfter = new Date(instant).toISOString();
  if (raw.deleteAfterPublication === true) retention.deleteAfterPublication = true;
  return Object.keys(retention).length > 0 ? retention : undefined;
}

export type KeepReason =
  | 'no_request'
  | 'invalid_deadline'
  | 'within_grace_period'
  | 'deadline_not_reached'
  | 'job_active'
  | 'no_scene'
  | 'master_missing'
  | 'master_not_local'
  | 'not_published'
  | 'sweep_limit'
  | 'delete_failed';

export type DeleteReason = 'deadline' | 'published';

export type RetentionDecision =
  | { action: 'delete'; reason: DeleteReason }
  | { action: 'keep'; reason: KeepReason };

export interface RetentionReport {
  mode: RetentionMode;
  at: string;
  examined: number;
  /** Removed in this sweep (`on`). */
  deleted: Array<{ captureId: string; reason: DeleteReason; sizeBytes: number }>;
  /** Would be removed (`dry-run`). */
  wouldDelete: Array<{ captureId: string; reason: DeleteReason; sizeBytes: number }>;
  /** How many captures were kept, and why. */
  kept: Partial<Record<KeepReason, number>>;
}

export interface RetentionSweeperDeps {
  mode: RetentionMode;
  store: Pick<LocalStore, 'snapshot' | 'update'>;
  captures: { list(): CaptureRecord[]; delete(id: string): Promise<void> };
  kubo: Pick<KuboClient, 'hasAllBlocksLocally'>;
  logger: { info(...args: unknown[]): void; warn(...args: unknown[]): void };
  now?: () => number;
  /** No capture younger than this is ever removed. */
  graceMs?: number;
  /** Most captures one sweep may remove. */
  maxDeletionsPerSweep?: number;
}

export const DEFAULT_RETENTION_GRACE_MS = 24 * 60 * 60 * 1000;
export const DEFAULT_MAX_DELETIONS_PER_SWEEP = 5;

function scenesOf(store: Pick<LocalStore, 'snapshot'>, captureId: string): SpatialStoreRecord[] {
  return (Object.values(store.snapshot().spatial ?? {}) as SpatialStoreRecord[])
    .filter((record) => record?.manifest?.captureId === captureId);
}

export class RetentionSweeper {
  private timer: NodeJS.Timeout | undefined;
  private initial: NodeJS.Timeout | undefined;
  private running = false;

  constructor(private readonly deps: RetentionSweeperDeps) {}

  private get now(): number {
    return (this.deps.now ?? Date.now)();
  }

  /**
   * Whether `capture` may go, and why or why not. Reads only; checks the
   * cheapest facts first and touches Kubo last.
   */
  async decide(capture: CaptureRecord): Promise<RetentionDecision> {
    const retention = normalizeRetention(capture.retention);
    const rawDeadline = (capture.retention as { deleteAfter?: unknown } | undefined)?.deleteAfter;
    if (rawDeadline !== undefined && parseRetentionInstant(rawDeadline) === undefined && !retention?.deleteAfterPublication) {
      return { action: 'keep', reason: 'invalid_deadline' };
    }
    if (!retention) return { action: 'keep', reason: 'no_request' };
    const createdAt = Date.parse(capture.createdAt);
    const grace = this.deps.graceMs ?? DEFAULT_RETENTION_GRACE_MS;
    if (!Number.isFinite(createdAt) || this.now - createdAt < grace) return { action: 'keep', reason: 'within_grace_period' };

    const jobs = Object.values(this.deps.store.snapshot().jobs ?? {}) as Array<{ input?: { captureId?: string }; state?: string }>;
    if (jobs.some((job) => job.input?.captureId === capture.id && ['queued', 'running'].includes(job.state ?? ''))) {
      return { action: 'keep', reason: 'job_active' };
    }

    const scenes = scenesOf(this.deps.store, capture.id);
    const deadlineDue = retention.deleteAfter !== undefined && Date.parse(retention.deleteAfter) <= this.now;
    const published = retention.deleteAfterPublication === true && scenes.some((scene) => scene.publication != null);
    if (!deadlineDue && !published) {
      return { action: 'keep', reason: retention.deleteAfterPublication && !retention.deleteAfter ? 'not_published' : 'deadline_not_reached' };
    }

    // Authorized and due. Now prove it would not leave this the only copy.
    if (scenes.length === 0) return { action: 'keep', reason: 'no_scene' };
    for (const scene of scenes) {
      const master = scene.manifest.variants.find((variant) => variant.role === 'spatial_archive');
      if (!master?.cid) return { action: 'keep', reason: 'master_missing' };
      if (!(await this.deps.kubo.hasAllBlocksLocally(master.cid))) return { action: 'keep', reason: 'master_not_local' };
    }
    return { action: 'delete', reason: deadlineDue ? 'deadline' : 'published' };
  }

  async sweep(): Promise<RetentionReport> {
    const report: RetentionReport = { mode: this.deps.mode, at: new Date(this.now).toISOString(), examined: 0, deleted: [], wouldDelete: [], kept: {} };
    if (this.deps.mode === 'off' || this.running) return report;
    this.running = true;
    try {
      const limit = this.deps.maxDeletionsPerSweep ?? DEFAULT_MAX_DELETIONS_PER_SWEEP;
      const keep = (reason: KeepReason) => { report.kept[reason] = (report.kept[reason] ?? 0) + 1; };
      // Oldest first: the longest-overdue request is the one that has waited longest.
      const captures = [...this.deps.captures.list()].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
      for (const capture of captures) {
        report.examined += 1;
        const decision = await this.decide(capture);
        if (decision.action === 'keep') { keep(decision.reason); continue; }
        if (report.deleted.length + report.wouldDelete.length >= limit) { keep('sweep_limit'); continue; }
        const entry = { captureId: capture.id, reason: decision.reason, sizeBytes: capture.sizeBytes };
        if (this.deps.mode === 'dry-run') { report.wouldDelete.push(entry); continue; }
        try {
          await this.deps.captures.delete(capture.id);
          report.deleted.push(entry);
        } catch (error) {
          const code = (error as { code?: string }).code;
          keep(code === 'capture_in_use' ? 'job_active' : 'delete_failed');
          if (code !== 'capture_in_use') this.deps.logger.warn({ captureId: capture.id, err: String((error as Error).message || error) }, 'retention: could not remove a capture');
        }
      }
      await this.deps.store.update((state) => {
        (state as { retentionSweep?: unknown }).retentionSweep = {
          at: report.at, mode: report.mode, examined: report.examined,
          deleted: report.deleted.length, wouldDelete: report.wouldDelete.length, kept: report.kept,
        };
      }).catch(() => undefined);
      if (report.deleted.length > 0 || report.wouldDelete.length > 0) {
        this.deps.logger.info({
          mode: report.mode,
          deleted: report.deleted.map((entry) => ({ captureId: entry.captureId, reason: entry.reason, sizeBytes: entry.sizeBytes })),
          wouldDelete: report.wouldDelete.map((entry) => ({ captureId: entry.captureId, reason: entry.reason, sizeBytes: entry.sizeBytes })),
        }, report.mode === 'dry-run' ? 'retention: dry run, nothing was removed' : 'retention: removed source captures that were authorized for deletion');
      }
      return report;
    } finally {
      this.running = false;
    }
  }

  /** Runs a first sweep after `initialDelayMs`, so start-up recovery settles first, then every `intervalMs`. */
  start(intervalMs: number, initialDelayMs = 60_000, onError?: (error: unknown) => void): void {
    if (this.deps.mode === 'off' || this.timer) return;
    const run = () => { void this.sweep().catch((error) => onError?.(error)); };
    this.initial = setTimeout(run, initialDelayMs);
    this.initial.unref();
    this.timer = setInterval(run, intervalMs);
    this.timer.unref();
  }

  stop(): void {
    if (this.initial) clearTimeout(this.initial);
    if (this.timer) clearInterval(this.timer);
    this.initial = undefined;
    this.timer = undefined;
  }
}
