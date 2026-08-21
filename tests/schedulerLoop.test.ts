import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runResilientLoop } from '../src/scheduler/loops.js';
import type { Logger } from '../src/logging/logger.js';

function fakeLogger() {
  const calls: Array<{ level: 'info' | 'warn'; payload: unknown; message: string }> = [];
  const logger = {
    info: (payload: unknown, message: string) => calls.push({ level: 'info', payload, message }),
    warn: (payload: unknown, message: string) => calls.push({ level: 'warn', payload, message }),
    error: () => undefined,
    debug: () => undefined,
  } as unknown as Logger;
  return { logger, calls };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('runResilientLoop — scheduler loop failure state (Part 12 / Part 40)', () => {
  it('logs a warning on the healthy -> failing transition, once', async () => {
    const { logger, calls } = fakeLogger();
    let stopped = false;
    const task = vi.fn(async () => { throw Object.assign(new Error('backend down'), { status: 503, code: 'backend_unavailable' }); });

    void runResilientLoop({
      name: 'policy',
      intervalMs: 10000,
      task,
      logger,
      isStopped: () => stopped,
    });

    await vi.advanceTimersByTimeAsync(0);
    const warnings = calls.filter((c) => c.level === 'warn');
    expect(warnings).toHaveLength(1);
    expect(warnings[0]!.payload).toMatchObject({
      loop: 'policy',
      code: 'backend_unavailable',
      status: 503,
      consecutiveFailures: 1,
    });

    stopped = true;
    await vi.advanceTimersByTimeAsync(120000);
  });

  it('does not log every single tick while continuously failing — only the transition and periodic summaries', async () => {
    const { logger, calls } = fakeLogger();
    let stopped = false;
    const task = vi.fn(async () => { throw new Error('still down'); });

    void runResilientLoop({
      name: 'heartbeat',
      intervalMs: 1000,
      maxBackoffMs: 2000,
      failureSummaryIntervalMs: 30000,
      task,
      logger,
      isStopped: () => stopped,
    });

    // Run well past a dozen ticks. With backoff capped at 2s, that's easily
    // 15+ task invocations inside 30s — a naive "warn every tick" loop would
    // produce 15+ warnings here.
    await vi.advanceTimersByTimeAsync(29000);
    stopped = true;
    await vi.advanceTimersByTimeAsync(5000);

    expect(task.mock.calls.length).toBeGreaterThan(5);
    const warnings = calls.filter((c) => c.level === 'warn');
    // Exactly one: the initial transition. The 30s summary window has not
    // elapsed yet at 29s, so no second warning should have fired.
    expect(warnings).toHaveLength(1);
  });

  it('logs a recovery line exactly once when a failing loop succeeds again', async () => {
    const { logger, calls } = fakeLogger();
    let stopped = false;
    let attempt = 0;
    const task = vi.fn(async () => {
      attempt += 1;
      if (attempt <= 2) throw new Error('flaky');
    });

    void runResilientLoop({
      name: 'cid-sync',
      intervalMs: 1000,
      maxBackoffMs: 2000,
      task,
      logger,
      isStopped: () => stopped,
    });

    await vi.advanceTimersByTimeAsync(10000);
    stopped = true;
    await vi.advanceTimersByTimeAsync(5000);

    const recoveries = calls.filter((c) => c.level === 'info' && c.message === 'scheduler loop recovered');
    expect(recoveries).toHaveLength(1);
    expect(recoveries[0]!.payload).toMatchObject({ loop: 'cid-sync', consecutiveFailures: 2 });
  });

  it('backs off instead of retrying on the plain interval while failing', async () => {
    // The delay carries +/-25% jitter, so comparing one sampled gap against
    // another by a fixed ratio is not a property the code guarantees: a
    // high-jittered first gap next to a low-jittered second one can legitimately
    // land within any such ratio. Pin the jitter instead, and assert the exact
    // delays the ladder is supposed to produce.
    const jitter = vi.spyOn(Math, 'random').mockReturnValue(0.5); // no jitter: multiplier 1.0
    try {
      const { logger } = fakeLogger();
      let stopped = false;
      const tickTimestamps: number[] = [];
      const task = vi.fn(async () => {
        tickTimestamps.push(Date.now());
        throw new Error('down');
      });

      void runResilientLoop({
        name: 'commitments',
        intervalMs: 5000,
        maxBackoffMs: 60000,
        task,
        logger,
        isStopped: () => stopped,
      });

      await vi.advanceTimersByTimeAsync(5000 + 10000 + 20000 + 40000);
      stopped = true;
      await vi.advanceTimersByTimeAsync(60000);

      expect(tickTimestamps.length).toBeGreaterThanOrEqual(3);
      const gaps = tickTimestamps
        .slice(1)
        .map((at, index) => at - tickTimestamps[index]!);

      // Doubling, not a fixed 5s repeat. That is the whole point: a node whose
      // backend is down must not keep hammering it every interval.
      expect(gaps[0]).toBe(5000);
      expect(gaps[1]).toBe(10000);
      if (gaps.length > 2) expect(gaps[2]).toBe(20000);
    } finally {
      jitter.mockRestore();
    }
  });

  it('keeps every jittered delay inside the band the ladder promises', async () => {
    // The bound that must hold for ANY jitter draw, checked at both extremes
    // rather than by sampling: the smallest possible second delay still
    // exceeds the largest possible first one, which is what makes the growth
    // real rather than statistical.
    for (const [draw, multiplier] of [
      [0, 0.75],
      [0.999999, 1.25],
    ] as const) {
      const jitter = vi.spyOn(Math, 'random').mockReturnValue(draw);
      try {
        const { logger } = fakeLogger();
        let stopped = false;
        const tickTimestamps: number[] = [];
        const task = vi.fn(async () => {
          tickTimestamps.push(Date.now());
          throw new Error('down');
        });

        void runResilientLoop({
          name: 'commitments',
          intervalMs: 5000,
          maxBackoffMs: 60000,
          task,
          logger,
          isStopped: () => stopped,
        });

        await vi.advanceTimersByTimeAsync(60000);
        stopped = true;
        await vi.advanceTimersByTimeAsync(60000);

        expect(tickTimestamps.length).toBeGreaterThanOrEqual(3);
        const gap1 = tickTimestamps[1]! - tickTimestamps[0]!;
        const gap2 = tickTimestamps[2]! - tickTimestamps[1]!;
        expect(gap1).toBe(Math.round(5000 * multiplier));
        expect(gap2).toBe(Math.round(10000 * multiplier));
      } finally {
        jitter.mockRestore();
      }
    }

    // And the invariant that makes the two bands non-overlapping at all.
    expect(10000 * 0.75).toBeGreaterThan(5000 * 1.25);
  });

  it('respects a startup stagger before the first tick', async () => {
    const { logger } = fakeLogger();
    let stopped = false;
    const task = vi.fn(async () => undefined);

    void runResilientLoop({
      name: 'status-rewards',
      intervalMs: 10000,
      startupDelayMs: 3000,
      task,
      logger,
      isStopped: () => stopped,
    });

    await vi.advanceTimersByTimeAsync(2000);
    expect(task).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1500);
    expect(task).toHaveBeenCalledTimes(1);

    stopped = true;
    await vi.advanceTimersByTimeAsync(15000);
  });

  it('does not treat action-lock contention as a loop failure', async () => {
    const { logger, calls } = fakeLogger();
    let stopped = false;
    const task = vi.fn(async () => {
      throw Object.assign(new Error('Action already running: scheduler:pin-reconcile'), {
        status: 409,
      });
    });

    void runResilientLoop({
      name: 'heartbeat',
      intervalMs: 1000,
      maxBackoffMs: 2000,
      task,
      logger,
      isStopped: () => stopped,
    });

    await vi.advanceTimersByTimeAsync(10000);
    stopped = true;
    await vi.advanceTimersByTimeAsync(5000);

    // The other loop is doing the work; this one just runs next tick.
    expect(calls.filter((c) => c.level === 'warn')).toHaveLength(0);
    // And it must not have been counted as a failure, so a later genuine
    // recovery is not reported against a phantom failure streak.
    expect(
      calls.filter((c) => c.message === 'scheduler loop recovered'),
    ).toHaveLength(0);
  });

  it('never logs a raw Authorization header value from a failure', async () => {
    const { logger, calls } = fakeLogger();
    let stopped = false;
    const task = vi.fn(async () => {
      throw Object.assign(new Error('request failed: Authorization: Bearer super-secret-token-value'), { code: 'request_failed' });
    });

    void runResilientLoop({ name: 'policy', intervalMs: 10000, task, logger, isStopped: () => stopped });
    await vi.advanceTimersByTimeAsync(0);
    stopped = true;
    await vi.advanceTimersByTimeAsync(60000);

    const warning = calls.find((c) => c.level === 'warn');
    expect(JSON.stringify(warning?.payload)).not.toContain('super-secret-token-value');
  });
});
