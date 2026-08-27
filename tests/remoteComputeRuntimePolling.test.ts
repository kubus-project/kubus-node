import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RemoteComputeRuntime } from '../src/compute/remoteComputeRuntime.js';
import { credentialFingerprint } from '../src/compute/credentialFingerprint.js';
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
  operatorToken: 'kubus_node_test-token-A',
} as unknown as import('../src/config/schema.js').AppConfig;

function buildRuntime(
  getProviderComputeJobs: () => Promise<{ jobs: unknown[] }>,
  options: { config?: Record<string, unknown>; initialState?: Record<string, unknown> } = {},
) {
  const { logger, calls } = fakeLogger();
  // Stateful on purpose: a durable authorization verdict has to survive a
  // stop/start, which a store that discards every mutation cannot express.
  const persisted: Record<string, unknown> = {
    nodeId: 'node-1',
    computeProviderSettings: undefined,
    remoteJobs: {},
    ...(options.initialState ?? {}),
  };
  const store = {
    snapshot: () => JSON.parse(JSON.stringify(persisted)) as Record<string, unknown>,
    update: async (mutator: (state: Record<string, unknown>) => void) => {
      mutator(persisted);
      return JSON.parse(JSON.stringify(persisted));
    },
  };
  const config = { ...baseConfig, ...(options.config ?? {}) } as unknown as import('../src/config/schema.js').AppConfig;
  const api = { getProviderComputeJobs } as unknown as import('../src/backend/kubusApiClient.js').KubusApiClient;
  const runtime = new RemoteComputeRuntime({
    api,
    kubo: {} as unknown as import('../src/ipfs/kuboClient.js').KuboClient,
    store: store as unknown as import('../src/state/localStore.js').LocalStore,
    config,
    captures: {} as unknown as import('../src/captures/captureStore.js').CaptureStore,
    jobs: {} as unknown as import('../src/jobs/jobRuntime.js').JobRuntime,
    gate: {} as unknown as import('../src/participation/networkParticipationGate.js').NetworkParticipationGate,
    identity: {} as unknown as import('../src/compute/computeIdentity.js').ComputeIdentityService,
    transport: {} as unknown as import('../src/compute/privatePayloadTransport.js').PrivatePayloadTransport,
    logger,
  });
  return { runtime, calls, persisted };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('RemoteComputeRuntime provider polling (Part 11 / Part 40)', () => {
  it('backs off after repeated poll failures instead of retrying every 5s forever', async () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.5);
    const pollTimestamps: number[] = [];
    const { runtime } = buildRuntime(async () => {
      pollTimestamps.push(Date.now());
      throw Object.assign(new Error('backend unavailable'), { status: 503, code: 'backend_unavailable' });
    });

    runtime.start();
    // Advance each scheduled retry separately. A single large fake-clock jump
    // can coalesce promise continuations and make the observed timestamps
    // describe the test runner rather than the runtime's retry schedule.
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(5000);
    await vi.advanceTimersByTimeAsync(10000);
    runtime.stop();
    await vi.advanceTimersByTimeAsync(1000);

    expect(pollTimestamps.length).toBeGreaterThanOrEqual(3);
    const gap1 = pollTimestamps[1]! - pollTimestamps[0]!;
    const gap2 = pollTimestamps[2]! - pollTimestamps[1]!;
    // Growing backoff, not a fixed 5s repeat.
    expect(gap1).toBeGreaterThanOrEqual(5000);
    expect(gap2).toBeGreaterThanOrEqual(10000);
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

  it('stops polling entirely after a single deterministic 403, and records why', async () => {
    // The behaviour this replaced backed off to a 60s ceiling and kept going.
    // That is still one rejected request per minute forever - the shape that
    // produced 28,701 403s on /api/compute/provider/jobs from one node.
    const pollTimestamps: number[] = [];
    const { runtime, calls, persisted } = buildRuntime(async () => {
      pollTimestamps.push(Date.now());
      throw Object.assign(
        new Error('Availability operator token missing scope: compute:jobs:read'),
        { status: 403 },
      );
    });

    runtime.start();
    await vi.advanceTimersByTimeAsync(0);
    // A full hour of wall clock. Under the old ceiling behaviour this alone
    // would have been sixty more requests.
    await vi.advanceTimersByTimeAsync(60 * 60 * 1000);

    expect(pollTimestamps).toHaveLength(1);
    expect(persisted.computeAuthorization).toMatchObject({
      state: 'AUTHORIZATION_REQUIRED',
      status: 403,
      missingScope: 'compute:jobs:read',
      surface: 'provider_jobs',
    });
    const warning = calls.find((c) => c.level === 'warn');
    expect(warning?.message).toContain('authorization required');
    expect(warning?.payload).toMatchObject({ status: 403, requiresOperatorAction: true, pollingStopped: true });
  });

  it('stops on a 401 as well - an invalid credential is equally deterministic', async () => {
    let polls = 0;
    const { runtime, persisted } = buildRuntime(async () => {
      polls += 1;
      throw Object.assign(new Error('invalid operator token'), { status: 401 });
    });

    runtime.start();
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(10 * 60 * 1000);

    expect(polls).toBe(1);
    expect(persisted.computeAuthorization).toMatchObject({ state: 'AUTHORIZATION_REQUIRED', status: 401 });
  });

  it('does not start polling at all when a blocked verdict names the credential in use', async () => {
    // Restart behaviour. Re-learning the same 403 would put the request back on
    // the backend, which is the noise this exists to end.
    let polls = 0;
    const { runtime } = buildRuntime(
      async () => { polls += 1; return { jobs: [] }; },
      {
        initialState: {
          computeAuthorization: {
            state: 'AUTHORIZATION_REQUIRED',
            status: 403,
            credentialFingerprint: credentialFingerprint('kubus_node_test-token-A'),
          },
        },
      },
    );

    runtime.start();
    await vi.advanceTimersByTimeAsync(10 * 60 * 1000);
    expect(polls).toBe(0);
  });

  it('resumes on its own when the credential is rotated', async () => {
    // The verdict was recorded against a different token, so it says nothing
    // about this one. No restart, no explicit retry.
    let polls = 0;
    const { runtime } = buildRuntime(
      async () => { polls += 1; return { jobs: [] }; },
      {
        config: { operatorToken: 'kubus_node_rotated-token-B' },
        initialState: {
          computeAuthorization: {
            state: 'AUTHORIZATION_REQUIRED',
            status: 403,
            credentialFingerprint: credentialFingerprint('kubus_node_test-token-A'),
          },
        },
      },
    );

    runtime.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(polls).toBeGreaterThan(0);
    runtime.stop();
  });

  it('retryAuthorization resumes polling for an operator who fixed the scope server-side', async () => {
    let polls = 0;
    const { runtime } = buildRuntime(
      async () => { polls += 1; return { jobs: [] }; },
      {
        initialState: {
          computeAuthorization: {
            state: 'AUTHORIZATION_REQUIRED',
            status: 403,
            credentialFingerprint: credentialFingerprint('kubus_node_test-token-A'),
          },
        },
      },
    );

    runtime.start();
    await vi.advanceTimersByTimeAsync(1000);
    expect(polls).toBe(0);

    await runtime.retryAuthorization();
    await vi.advanceTimersByTimeAsync(0);
    expect(polls).toBeGreaterThan(0);
    runtime.stop();
  });

  it('a transient 500 still retries with backoff rather than blocking', async () => {
    // Only 401/403 are deterministic. A backend outage must not disable the
    // capability until an operator intervenes.
    let polls = 0;
    const { runtime, persisted } = buildRuntime(async () => {
      polls += 1;
      throw Object.assign(new Error('internal error'), { status: 500 });
    });

    runtime.start();
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(5000);
    await vi.advanceTimersByTimeAsync(10000);

    expect(polls).toBeGreaterThan(1);
    expect(persisted.computeAuthorization).toBeUndefined();
    runtime.stop();
  });

  it('clears a stale blocked verdict once the credential authorizes again', async () => {
    const { runtime, persisted } = buildRuntime(async () => ({ jobs: [] }));
    runtime.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(persisted.computeAuthorization).toMatchObject({ state: 'OK' });
    runtime.stop();
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
