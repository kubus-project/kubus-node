import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RemoteComputeRuntime } from '../src/compute/remoteComputeRuntime.js';
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

const baseConfig = {
  offerRemoteCompute: true,
  remoteComputePaused: false,
  remoteComputeMaxConcurrency: 2,
  remoteComputeMaxQueueDepth: 2,
  remoteComputeMaxInputBytes: 1024 * 1024 * 1024,
  remoteComputeMinimumFreeVramBytes: 0,
  localDataPath: '/tmp/kubus-test',
} as unknown as import('../src/config/schema.js').AppConfig;

function buildRuntime(getProviderComputeJobs: () => Promise<{ jobs: unknown[] }>) {
  const { logger, calls } = fakeLogger();
  const store = {
    snapshot: () => ({ nodeId: 'node-1', computeProviderSettings: undefined, remoteJobs: {} }),
    update: async (mutator: (state: Record<string, unknown>) => void) => {
      const state: Record<string, unknown> = { remoteJobs: {} };
      mutator(state);
    },
  };
  const api = { getProviderComputeJobs } as unknown as import('../src/backend/kubusApiClient.js').KubusApiClient;
  const runtime = new RemoteComputeRuntime({
    api,
    kubo: {} as unknown as import('../src/ipfs/kuboClient.js').KuboClient,
    store: store as unknown as import('../src/state/localStore.js').LocalStore,
    config: baseConfig,
    captures: {} as unknown as import('../src/captures/captureStore.js').CaptureStore,
    jobs: {} as unknown as import('../src/jobs/jobRuntime.js').JobRuntime,
    gate: {} as unknown as import('../src/participation/networkParticipationGate.js').NetworkParticipationGate,
    identity: {} as unknown as import('../src/compute/computeIdentity.js').ComputeIdentityService,
    transport: {} as unknown as import('../src/compute/privatePayloadTransport.js').PrivatePayloadTransport,
    logger,
  });
  return { runtime, calls };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('RemoteComputeRuntime provider polling (Part 11 / Part 40)', () => {
  it('backs off after repeated poll failures instead of retrying every 5s forever', async () => {
    const pollTimestamps: number[] = [];
    const { runtime } = buildRuntime(async () => {
      pollTimestamps.push(Date.now());
      throw Object.assign(new Error('backend unavailable'), { status: 503, code: 'backend_unavailable' });
    });

    runtime.start();
    await vi.advanceTimersByTimeAsync(5000 + 10000 + 20000);
    runtime.stop();
    await vi.advanceTimersByTimeAsync(1000);

    expect(pollTimestamps.length).toBeGreaterThanOrEqual(3);
    const gap1 = pollTimestamps[1]! - pollTimestamps[0]!;
    const gap2 = pollTimestamps[2]! - pollTimestamps[1]!;
    // Growing backoff, not a fixed 5s repeat.
    expect(gap2).toBeGreaterThan(gap1 * 1.4);
  });

  it('logs a warning only on the healthy -> failing transition, not every 5s tick', async () => {
    const { runtime, calls } = buildRuntime(async () => {
      throw new Error('still down');
    });

    runtime.start();
    await vi.advanceTimersByTimeAsync(5000 * 6);
    runtime.stop();
    await vi.advanceTimersByTimeAsync(1000);

    const warnings = calls.filter((c) => c.level === 'warn' && c.message === 'remote compute provider poll failed');
    // Six ticks worth of elapsed time at the base interval would be six
    // identical warnings under the old fixed-interval behaviour.
    expect(warnings.length).toBeLessThan(3);
    expect(warnings[0]!.payload).toMatchObject({ op: 'remote_compute_poll', consecutiveFailures: 1 });
  });

  it('logs a recovery line once when polling succeeds again after failing', async () => {
    let attempt = 0;
    const { runtime, calls } = buildRuntime(async () => {
      attempt += 1;
      if (attempt <= 2) throw new Error('flaky backend');
      return { jobs: [] };
    });

    runtime.start();
    await vi.advanceTimersByTimeAsync(5000 + 10000 + 5000);
    runtime.stop();
    await vi.advanceTimersByTimeAsync(1000);

    const recoveries = calls.filter((c) => c.level === 'info' && c.message === 'remote compute provider poll recovered');
    expect(recoveries).toHaveLength(1);
  });

  it('treats a 403 scope rejection as a standing config fact, not a transient outage', async () => {
    const pollTimestamps: number[] = [];
    const { runtime, calls } = buildRuntime(async () => {
      pollTimestamps.push(Date.now());
      throw Object.assign(
        new Error('Availability operator token missing scope: compute:jobs:read'),
        { status: 403 },
      );
    });

    runtime.start();
    await vi.advanceTimersByTimeAsync(180000);
    runtime.stop();
    await vi.advanceTimersByTimeAsync(1000);

    const warning = calls.find((c) => c.level === 'warn');
    expect(warning?.message).toContain('operator token lacks the required scope');
    expect(warning?.payload).toMatchObject({ status: 403, requiresOperatorAction: true });

    // Straight to the 60s ceiling rather than climbing 5s -> 10s -> 20s...
    // A real node logged 591 consecutive failures of exactly this kind.
    const gap = (pollTimestamps[1] ?? 0) - (pollTimestamps[0] ?? 0);
    expect(gap).toBeGreaterThanOrEqual(60000);
  });

  it('never logs a raw Authorization header value from a poll failure', async () => {
    const { runtime, calls } = buildRuntime(async () => {
      throw new Error('request failed: Authorization: Bearer super-secret-node-token');
    });

    runtime.start();
    await vi.advanceTimersByTimeAsync(0);
    runtime.stop();
    await vi.advanceTimersByTimeAsync(1000);

    const warning = calls.find((c) => c.level === 'warn');
    expect(JSON.stringify(warning?.payload)).not.toContain('super-secret-node-token');
  });

  it('stop() prevents further polling', async () => {
    let calls = 0;
    const { runtime } = buildRuntime(async () => {
      calls += 1;
      return { jobs: [] };
    });

    runtime.start();
    await vi.advanceTimersByTimeAsync(5000);
    runtime.stop();
    const callsAtStop = calls;
    await vi.advanceTimersByTimeAsync(60000);
    expect(calls).toBe(callsAtStop);
  });
});
