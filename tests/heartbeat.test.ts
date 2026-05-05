import { describe, expect, it, vi } from 'vitest';
import { sendHeartbeat } from '../src/operator/heartbeat.js';
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
        { id: 'manifest', cid: 'bafymanifest', role: 'manifest' },
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
      }),
    }));
  });
});
