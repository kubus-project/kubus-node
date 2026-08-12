import { afterEach, describe, expect, it, vi } from 'vitest';
import { sendHeartbeat } from '../src/operator/heartbeat.js';
import { CapabilityRegistry } from '../src/capabilities/registry.js';
import type { AppConfig } from '../src/config/schema.js';
import type { LocalState } from '../src/state/localStore.js';

vi.mock('../src/ipfs/health.js', () => ({
  getKuboHealth: vi.fn(async () => ({
    reachable: true,
    repo: { repoSize: 123 },
  })),
}));

function makeStore(initial: Partial<LocalState>) {
  let state = {
    version: 1,
    publicPinSet: [],
    rewardableCids: [],
    desiredCids: [],
    pinnedCids: [],
    failedCids: {},
    activeCommitments: [],
    ...initial,
  } as LocalState;
  return {
    snapshot: () => JSON.parse(JSON.stringify(state)) as LocalState,
    update: async (mutator: (next: LocalState) => void | Promise<void>) => {
      await mutator(state);
      return state;
    },
  };
}

const kubo = { id: async () => ({ ID: 'peer' }) } as never;

afterEach(() => {
  vi.restoreAllMocks();
});

describe('sendHeartbeat', () => {
  it('reports tracked, pinned, and failed counts from public pin set state', async () => {
    const sendHeartbeatMock = vi.fn(async (payload) => ({ heartbeat: payload, status: { status: 'healthy' } }));
    const store = makeStore({
      nodeId: 'node-1',
      publicPinSet: [
        { id: 'manifest', cid: 'bafymanifest', role: 'manifest' },
        { id: 'record', cid: 'bafyrecord', role: 'record' },
      ],
      rewardableCids: [{ id: 'rewardable-1', cid: 'bafyleaf' }],
      desiredCids: [
        { id: 'manifest', cid: 'bafymanifest', role: 'manifest', sizeBytes: 2048 },
        { id: 'record', cid: 'bafyrecord', role: 'record' },
      ],
      pinnedCids: ['bafymanifest'],
      failedCids: { bafyrecord: { error: 'pin_failed', at: '2026-05-01T00:00:00.000Z' } },
    });

    await sendHeartbeat(
      { sendHeartbeat: sendHeartbeatMock } as never,
      {} as never,
      store as never,
      { operatorWallet: 'wallet', skipPinning: false } as AppConfig,
      new CapabilityRegistry(kubo),
    );

    expect(sendHeartbeatMock).toHaveBeenCalledWith(expect.objectContaining({
      trackedCidCount: 2,
      pinnedCidCount: 1,
      failedCidCount: 1,
      rewardableCidCount: 1,
      metadata: expect.objectContaining({
        publicPinSetCount: 2,
        desiredPublicCidCount: 2,
        rewardableCidCount: 1,
        nodeVersion: expect.stringContaining('kubus-node/'),
        capabilities: expect.any(Object),
        jobsRunning: 0,
        jobsQueued: 0,
      }),
      storage: expect.objectContaining({
        publicReplicaBytes: 2048,
        localPrivateSpatialBytes: 0,
      }),
    }));
  });

  it('advertises the RTX-class worker seen by the shared registry, with no independent probe', async () => {
    vi.useFakeTimers();
    try {
      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({
        status: 'ready',
        gpu: { available: true, name: 'NVIDIA GeForce RTX 3080 Ti', model: 'NVIDIA GeForce RTX 3080 Ti', totalVramBytes: 12_884_377_600, tier: '12GB+' },
        capabilities: ['spatial.reconstruct', 'spatial.gaussianSplat'],
      }), { status: 200 }));

      const sendHeartbeatMock = vi.fn(async (payload) => ({ heartbeat: payload, status: { status: 'healthy' } }));
      const store = makeStore({ nodeId: 'node-1' });
      const capabilities = new CapabilityRegistry(kubo, 'http://kubus-spatial-worker:8790');

      await sendHeartbeat(
        { sendHeartbeat: sendHeartbeatMock } as never,
        kubo,
        store as never,
        { operatorWallet: 'wallet', skipPinning: false } as AppConfig,
        capabilities,
      );

      expect(fetchSpy).toHaveBeenCalledTimes(1);
      const payload = sendHeartbeatMock.mock.calls[0]![0];
      expect(payload.metadata.spatialWorkerHealth.status).toBe('ready');
      expect(payload.metadata.spatialWorkerHealth.gpu.name).toBe('NVIDIA GeForce RTX 3080 Ti');
      expect(payload.metadata.capabilities['compute.gpu']).toMatchObject({ available: true, healthy: true });
      expect(payload.metadata.capabilities['spatial.reconstruction']).toMatchObject({ available: true, healthy: true });
      expect(payload.metadata.capabilities['spatial.gaussianSplat']).toMatchObject({ available: true, healthy: true });

      // The worker goes offline; once the cache goes stale, the same shared
      // registry (not a fresh one) picks it up on the next heartbeat.
      fetchSpy.mockRejectedValueOnce(new Error('connect ECONNREFUSED'));
      await vi.advanceTimersByTimeAsync(6000);
      await sendHeartbeat(
        { sendHeartbeat: sendHeartbeatMock } as never,
        kubo,
        store as never,
        { operatorWallet: 'wallet', skipPinning: false } as AppConfig,
        capabilities,
      );
      const secondPayload = sendHeartbeatMock.mock.calls[1]![0];
      expect(secondPayload.metadata.spatialWorkerHealth.status).toBe('unavailable');
      expect(secondPayload.metadata.capabilities['compute.gpu']).toMatchObject({ available: false });
    } finally {
      vi.useRealTimers();
    }
  });
});
