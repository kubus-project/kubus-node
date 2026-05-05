import { describe, expect, it, vi } from 'vitest';
import { refreshCommitments, syncPublicPinSet } from '../src/operator/commitments.js';
import type { AppConfig } from '../src/config/schema.js';
import type { LocalState } from '../src/state/localStore.js';

vi.mock('../src/ipfs/retrieval.js', () => ({
  probeRetrieval: vi.fn(async (_kubo, _gateway, cid: string) => ({
    cid,
    state: 'pinned',
    checkedAt: '2026-05-01T00:00:00.000Z',
  })),
}));

const config = {
  maxPinnedCids: 10,
  cidClassFilters: ['hot'],
  skipPinning: false,
  ipfsGatewayUrl: 'http://127.0.0.1:8080',
} as AppConfig;

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

describe('availability pin set commitments', () => {
  it('uses public pin set as desired pins and rewardable CIDs as commitment subset', async () => {
    const api = {
      getPublicPinSet: vi.fn(async () => ({
        count: 3,
        records: [
          { id: 'manifest', cid: 'bafymanifest', role: 'manifest', objectType: 'artwork', objectId: 'art-1', version: 1 },
          { id: 'record', cid: 'bafyrecord', role: 'record', objectType: 'artwork', objectId: 'art-1', version: 1 },
          { id: 'leaf', cid: 'bafyleaf', role: 'media', verificationClass: 'hot', isRewardable: true, rewardableCidId: 'rewardable-1', objectType: 'artwork', objectId: 'art-1', version: 1 },
        ],
      })),
      getRewardableCids: vi.fn(async () => ({
        count: 1,
        records: [{ id: 'rewardable-1', cid: 'bafyleaf', verificationClass: 'hot', objectType: 'artwork', objectId: 'art-1', version: 1 }],
      })),
    };
    const store = makeStore({});

    const desired = await syncPublicPinSet(api as never, store as never, config);

    expect(desired.map((record) => record.cid)).toEqual(['bafymanifest', 'bafyrecord', 'bafyleaf']);
    expect(store.snapshot().rewardableCids.map((record) => record.cid)).toEqual(['bafyleaf']);
  });

  it('creates commitments only for rewardable leaves and includes pinned bundle metadata', async () => {
    const createCommitment = vi.fn(async (payload) => ({ id: 'commitment-1', ...payload }));
    const api = { createCommitment };
    const store = makeStore({
      nodeId: 'node-1',
      publicPinSet: [],
      desiredCids: [
        { id: 'manifest', cid: 'bafymanifest', role: 'manifest', objectType: 'artwork', objectId: 'art-1', version: 1 },
        { id: 'record', cid: 'bafyrecord', role: 'record', objectType: 'artwork', objectId: 'art-1', version: 1 },
        { id: 'leaf', cid: 'bafyleaf', role: 'media', isRewardable: true, rewardableCidId: 'rewardable-1', objectType: 'artwork', objectId: 'art-1', version: 1 },
      ],
      rewardableCids: [
        { id: 'rewardable-1', cid: 'bafyleaf', rewardRole: 'gallery_asset', verificationClass: 'hot', objectType: 'artwork', objectId: 'art-1', version: 1 },
      ],
      pinnedCids: ['bafymanifest', 'bafyrecord', 'bafyleaf'],
    });

    await refreshCommitments(api as never, {} as never, store as never, config);

    expect(createCommitment).toHaveBeenCalledTimes(1);
    expect(createCommitment.mock.calls[0]?.[0]).toMatchObject({
      nodeId: 'node-1',
      rewardableCidId: 'rewardable-1',
      metadata: {
        pinnedBundleCids: ['bafymanifest', 'bafyrecord', 'bafyleaf'],
        manifestCidPinned: true,
        recordCidPinned: true,
        leafCidPinned: true,
        objectType: 'artwork',
        objectId: 'art-1',
        version: 1,
      },
    });
  });
});
