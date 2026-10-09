import { describe, expect, it, vi, afterEach } from 'vitest';
import { pinTierOf, planPublicPins, syncPublicPinSet } from '../src/operator/commitments.js';
import { reconcilePins } from '../src/ipfs/pinning.js';
import { KuboClient } from '../src/ipfs/kuboClient.js';
import type { PublicPinSetRecord } from '../src/backend/models.js';
import type { AppConfig } from '../src/config/schema.js';
import type { LocalState } from '../src/state/localStore.js';

afterEach(() => vi.restoreAllMocks());

const MB = 1024 * 1024;
const cidOf = (label: string) => `Qm${label.replace(/[^A-Za-z0-9]/g, '').padEnd(44, 'x').slice(0, 44)}`;

let counter = 0;
function rec(role: string, tier: PublicPinSetRecord['storageClass'] | undefined, sizeMb: number, extra: Partial<PublicPinSetRecord> = {}): PublicPinSetRecord {
  counter += 1;
  return { id: `r${counter}`, cid: cidOf(`${role}${counter}`), role, storageClass: tier ?? null, sizeBytes: sizeMb * MB, objectType: 'spatial_record', objectId: `scene-${String(counter).padStart(3, '0')}`, version: 1, ...extra };
}

/** What a canonical pin set looks like once scenes carry all three representations. */
function corpus(scenes: number) {
  const records: PublicPinSetRecord[] = [];
  for (let index = 0; index < scenes; index += 1) {
    const id = `scene-${String(index).padStart(3, '0')}`;
    const base = { objectType: 'spatial_record', objectId: id, version: 1 };
    records.push(
      { id: `${id}-m`, cid: cidOf(`manifest${index}`), role: 'manifest', storageClass: 'hot', sizeBytes: 2048, ...base },
      { id: `${id}-r`, cid: cidOf(`record${index}`), role: 'record', storageClass: 'hot', sizeBytes: 1024, ...base },
      { id: `${id}-p`, cid: cidOf(`preview${index}`), role: 'spatial_preview', storageClass: 'hot', sizeBytes: 1.5 * MB, ...base },
      { id: `${id}-w`, cid: cidOf(`runtime${index}`), role: 'spatial_mobile', storageClass: 'warm', sizeBytes: 6 * MB, ...base },
      { id: `${id}-c`, cid: cidOf(`archive${index}`), role: 'spatial_archive', storageClass: 'cold', sizeBytes: 50 * MB, ...base },
    );
  }
  return records;
}

const roleCount = (plan: PublicPinSetRecord[], role: string) => plan.filter((record) => record.role === role).length;
const bytes = (plan: PublicPinSetRecord[]) => plan.reduce((sum, record) => sum + Number(record.sizeBytes || 0), 0);
const GIB = 1024 * MB;

describe('which tier a record is in', () => {
  it('is the record\'s storage class, with verificationClass only as a fallback for older servers', () => {
    expect(pinTierOf({ storageClass: 'cold', verificationClass: 'hot' })).toBe('cold');
    expect(pinTierOf({ storageClass: null, verificationClass: 'warm' })).toBe('warm');
    expect(pinTierOf({ verificationClass: ' hot ' })).toBe('hot');
    expect(pinTierOf({ storageClass: null, verificationClass: null })).toBeUndefined();
    expect(pinTierOf({ storageClass: null, verificationClass: 'metadata' })).toBeUndefined();
    expect(pinTierOf({})).toBeUndefined();
  });
});

describe('CID_CLASS_FILTERS select storage tiers', () => {
  const HOT_WARM = ['hot', 'warm'];

  it('keeps a COLD archive off a node that did not opt in, whatever its verificationClass says', () => {
    // This is the defect: the filter used to read verificationClass, so an archive
    // that carried none (or a "hot" one) walked straight past `hot,warm`.
    const bare = rec('spatial_archive', 'cold', 50);
    const mislabelled = rec('spatial_archive', 'cold', 50, { verificationClass: 'hot' });
    const wrongWayRound = rec('spatial_preview', 'hot', 1, { verificationClass: 'cold' });
    const plan = planPublicPins([bare, mislabelled, wrongWayRound], 100, GIB, HOT_WARM);
    expect(plan.map((record) => record.id)).toEqual([wrongWayRound.id]);
  });

  it('takes COLD only when the operator lists it', () => {
    const archive = rec('spatial_archive', 'cold', 50);
    expect(planPublicPins([archive], 10, GIB, ['hot', 'warm'])).toEqual([]);
    expect(planPublicPins([archive], 10, GIB, ['hot', 'warm', 'cold'])).toEqual([archive]);
    expect(planPublicPins([archive], 10, GIB, ['cold'])).toEqual([archive]);
  });

  it('never filters out the manifest and signed record that describe an object', () => {
    const manifest = rec('manifest', 'cold', 0.01);
    const record = rec('record', 'cold', 0.01);
    const plan = planPublicPins([manifest, record, rec('spatial_archive', 'cold', 50)], 10, GIB, ['hot']);
    expect(plan.map((item) => item.role)).toEqual(['manifest', 'record']);
  });

  it('keeps pinning a record the server gave no tier at all, as the operator guide promises', () => {
    const classless = rec('media', undefined, 1);
    expect(planPublicPins([classless], 10, GIB, ['hot'])).toEqual([classless]);
  });

  it('plans every tier when there are no filters', () => {
    const all = [rec('spatial_archive', 'cold', 5), rec('spatial_mobile', 'warm', 5), rec('spatial_preview', 'hot', 5)];
    expect(planPublicPins(all, 10, GIB, [])).toHaveLength(3);
  });

  it('ignores a filter token that is not a tier instead of letting it match everything', () => {
    const plan = planPublicPins([rec('spatial_archive', 'cold', 5), rec('spatial_preview', 'hot', 5)], 10, GIB, ['everything']);
    expect(plan).toEqual([]);
  });
});

describe('placement order and capacity', () => {
  it('plans metadata, then HOT, then WARM, then COLD, whatever order the server listed them in', () => {
    const list = [
      rec('spatial_archive', 'cold', 5), rec('spatial_mobile', 'warm', 5), rec('spatial_preview', 'hot', 5), rec('record', 'hot', 0.001), rec('manifest', 'hot', 0.001),
    ];
    expect(planPublicPins(list, 10, GIB, []).map((record) => record.role)).toEqual(['manifest', 'record', 'spatial_preview', 'spatial_mobile', 'spatial_archive']);
  });

  it('never lets a larger tier displace a smaller one when the budget is tight', () => {
    const hot = rec('spatial_preview', 'hot', 60);
    const warm = rec('spatial_mobile', 'warm', 30);
    const cold = rec('spatial_archive', 'cold', 40);
    const plan = planPublicPins([cold, warm, hot], 10, 100 * MB, []);
    // hot (60) + warm (30) fit; cold (40) would not, and must not have taken their place.
    expect(plan.map((record) => record.id)).toEqual([hot.id, warm.id]);
    expect(bytes(plan)).toBeLessThanOrEqual(100 * MB);
  });

  it('skips a record that does not fit and keeps going, so a smaller one behind it can still be held', () => {
    const big = rec('spatial_mobile', 'warm', 90);
    const small = rec('spatial_mobile', 'warm', 5);
    const plan = planPublicPins([big, small], 10, 50 * MB, []);
    expect(plan).toEqual([small]);
  });

  it('counts every tier against the CID budget and never exceeds either budget', () => {
    const records = corpus(10);
    const plan = planPublicPins(records, 17, 5 * GIB, []);
    expect(plan).toHaveLength(17);
    // 10 manifests + 7 of the next tier-ordered records: nothing cold or warm before hot is spent.
    expect(roleCount(plan, 'manifest')).toBe(10);
    expect(roleCount(plan, 'record')).toBe(7);
    expect(planPublicPins(records, 1000, 100 * MB, []).reduce((sum, record) => sum + Number(record.sizeBytes), 0)).toBeLessThanOrEqual(100 * MB);
  });

  it('is deterministic for a given input, however it arrives', () => {
    const records = corpus(6);
    const forward = planPublicPins(records, 1000, 120 * MB, ['hot', 'warm']).map((record) => record.id);
    const reversed = planPublicPins([...records].reverse(), 1000, 120 * MB, ['hot', 'warm']).map((record) => record.id);
    expect(reversed).toEqual(forward);
  });
});

describe('capacity tiers, on a corpus of 20 scenes', () => {
  // 20 x (preview 1.5 MB hot, runtime 6 MB warm, archive 50 MB cold) plus metadata.
  const records = corpus(20);
  const metadataBytes = 20 * (2048 + 1024);
  const previewBytes = 20 * 1.5 * MB;

  it('a small node (100 MB, hot+warm) holds every preview and every manifest and as much runtime as is left - and no archive', () => {
    const plan = planPublicPins(records, 10_000, 100 * MB, ['hot', 'warm'], { seed: 'small-node' });
    expect(roleCount(plan, 'manifest')).toBe(20);
    expect(roleCount(plan, 'record')).toBe(20);
    expect(roleCount(plan, 'spatial_preview')).toBe(20);
    expect(roleCount(plan, 'spatial_archive')).toBe(0);
    // (100 MB - previews - metadata) / 6 MB
    expect(roleCount(plan, 'spatial_mobile')).toBe(Math.floor((100 * MB - previewBytes - metadataBytes) / (6 * MB)));
    expect(bytes(plan)).toBeLessThanOrEqual(100 * MB);
  });

  it('a mid-size node that opts into COLD holds the previews and runtimes first and archives only from what remains', () => {
    const plan = planPublicPins(records, 10_000, 500 * MB, ['hot', 'warm', 'cold'], { seed: 'mid-node' });
    expect(roleCount(plan, 'spatial_preview')).toBe(20);
    expect(roleCount(plan, 'spatial_mobile')).toBe(20);
    const remaining = 500 * MB - previewBytes - 20 * 6 * MB - metadataBytes;
    expect(roleCount(plan, 'spatial_archive')).toBe(Math.floor(remaining / (50 * MB)));
    expect(roleCount(plan, 'spatial_archive')).toBeGreaterThan(0);
    expect(roleCount(plan, 'spatial_archive')).toBeLessThan(20);
  });

  it('an archival node (2 GiB, all tiers) holds everything', () => {
    const plan = planPublicPins(records, 10_000, 2 * GIB, ['hot', 'warm', 'cold'], { seed: 'archive-node' });
    expect(plan).toHaveLength(records.length);
  });

  it('preview availability does not push archives onto a node that has not asked for them', () => {
    const plan = planPublicPins(records, 10_000, 2 * GIB, ['hot', 'warm'], { seed: 'small-with-room' });
    expect(roleCount(plan, 'spatial_archive')).toBe(0);
    expect(roleCount(plan, 'spatial_preview')).toBe(20);
  });
});

describe('capacity-bound tiers are spread across nodes, not duplicated', () => {
  const records = corpus(20);
  const plans = (seeds: string[]) => seeds.map((seed) => planPublicPins(records, 10_000, 100 * MB, ['hot', 'warm'], { seed }));
  const ids = (plan: PublicPinSetRecord[], role: string) => plan.filter((record) => record.role === role).map((record) => record.id);

  it('every node holds the same HOT content and metadata', () => {
    const [a, b, c] = plans(['node-a', 'node-b', 'node-c']);
    for (const role of ['manifest', 'record', 'spatial_preview']) {
      expect(ids(b!, role)).toEqual(ids(a!, role));
      expect(ids(c!, role)).toEqual(ids(a!, role));
    }
  });

  it('different nodes hold different WARM subsets, so together they hold more than any one', () => {
    const seeds = Array.from({ length: 12 }, (_, index) => `node-${index}`);
    const warm = plans(seeds).map((plan) => new Set(ids(plan, 'spatial_mobile')));
    const each = warm.map((set) => set.size);
    expect(Math.min(...each)).toBeGreaterThan(0);
    expect(Math.max(...each)).toBeLessThan(20); // no single node can hold them all
    expect(new Set(warm.flatMap((set) => [...set])).size).toBe(20); // together they cover every runtime
    expect(new Set(warm.map((set) => [...set].sort().join(','))).size).toBeGreaterThan(1);
  });

  it('a node keeps the same subset every time it plans, whatever order the server lists records in', () => {
    const first = planPublicPins(records, 10_000, 100 * MB, ['hot', 'warm'], { seed: 'node-a' });
    const second = planPublicPins([...records].reverse(), 10_000, 100 * MB, ['hot', 'warm'], { seed: 'node-a' });
    expect(second.map((record) => record.id).sort()).toEqual(first.map((record) => record.id).sort());
  });

  it('without a seed every constrained node holds the same objects - the first by id - so the rest are held by none (the behaviour this replaces)', () => {
    const [a, b] = [planPublicPins(records, 10_000, 100 * MB, ['hot', 'warm']), planPublicPins(records, 10_000, 100 * MB, ['hot', 'warm'])];
    const held = ids(a, 'spatial_mobile');
    expect(ids(b, 'spatial_mobile')).toEqual(held);
    expect(held.length).toBeLessThan(20);
    const lastScene = records.find((record) => record.role === 'spatial_mobile' && record.objectId === 'scene-019')!;
    expect(held).not.toContain(lastScene.id);
  });
});

describe('the node id is the seed', () => {
  const config = { maxPinnedCids: 10_000, maxPinnedBytes: 100 * MB, cidClassFilters: ['hot', 'warm'], skipPinning: false, ipfsGatewayUrl: 'http://127.0.0.1:8080' } as AppConfig;

  function storeFor(nodeId: string | undefined) {
    const state = { version: 1, nodeId, publicPinSet: [], rewardableCids: [], desiredCids: [], pinnedCids: [], failedCids: {}, activeCommitments: [] } as unknown as LocalState;
    return { snapshot: () => structuredClone(state), update: async (mutate: (next: LocalState) => void) => { mutate(state); return state; } };
  }
  const api = (all: PublicPinSetRecord[]) => ({
    getPublicPinSet: vi.fn(async () => ({ count: all.length, complete: true, records: all })),
    getRewardableCids: vi.fn(async () => ({ count: 0, records: [] })),
  });

  it('gives two registered nodes different WARM plans from the same canonical pin set', async () => {
    const all = corpus(20);
    const a = await syncPublicPinSet(api(all) as never, storeFor('node-a') as never, config);
    const b = await syncPublicPinSet(api(all) as never, storeFor('node-b') as never, config);
    const warm = (plan: PublicPinSetRecord[]) => plan.filter((record) => record.role === 'spatial_mobile').map((record) => record.id).sort();
    expect(warm(a)).not.toEqual(warm(b));
    expect(roleCount(a, 'spatial_preview')).toBe(20);
    expect(roleCount(b, 'spatial_preview')).toBe(20);
  });

  it('plans canonically before the node is registered, and stores the plan it made', async () => {
    const all = corpus(20);
    const store = storeFor(undefined);
    const desired = await syncPublicPinSet(api(all) as never, store as never, config);
    expect(store.snapshot().desiredCids.map((record) => record.id)).toEqual(desired.map((record) => record.id));
    expect(desired).toEqual(planPublicPins(all, 10_000, 100 * MB, ['hot', 'warm']));
  });

  it('refuses an incomplete canonical pin set instead of planning from part of it', async () => {
    const partial = { getPublicPinSet: vi.fn(async () => ({ count: 5, complete: false, records: corpus(1) })), getRewardableCids: vi.fn(async () => ({ count: 0, records: [] })) };
    await expect(syncPublicPinSet(partial as never, storeFor('node-a') as never, config)).rejects.toThrow(/incomplete/);
  });
});

describe('bundle roots are pinned recursively', () => {
  const ROOT = 'QmRPWQYEcANkuhUjxcbr1tApnGSHrqw1vkWM29tF7eBb2d';

  it('KuboClient.pinAdd always asks for a recursive pin', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{"Pins":["x"]}', { status: 200 }));
    await new KuboClient('http://kubo:5001').pinAdd(ROOT);
    const url = new URL(String(fetchMock.mock.calls[0]![0]));
    expect(url.pathname).toBe('/api/v0/pin/add');
    expect(url.searchParams.get('arg')).toBe(ROOT);
    expect(url.searchParams.get('recursive')).toBe('true');
  });

  it('reconcilePins pins the bundle root itself, not its files one by one', async () => {
    const pinAdd = vi.fn(async () => ({}));
    const root = rec('spatial_mobile', 'warm', 6, { cid: ROOT });
    const results = await reconcilePins({ pinAdd } as never, [root], false);
    expect(pinAdd).toHaveBeenCalledTimes(1);
    expect(pinAdd).toHaveBeenCalledWith(ROOT);
    expect(results).toEqual([{ cid: ROOT, ok: true }]);
  });

  it('does not mistake a gateway\'s HTML listing of a bundle root for the bundle', async () => {
    const pinAdd = vi.fn(async () => { throw new Error('not found'); });
    const addBytes = vi.fn(async () => ({ Hash: 'QmSomethingElseEntirely000000000000000000000' }));
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('<html>Index of /ipfs/…</html>'));
    const [result] = await reconcilePins({ pinAdd, addBytes } as never, [rec('spatial_mobile', 'warm', 6, { cid: ROOT })], false, 'http://api.test');
    expect(result?.ok).toBe(false);
    expect(result?.error).toMatch(/hashed to/);
  });

  it('reports every planned CID, so the participation gate can see exactly what is unreconciled', async () => {
    const ok = rec('spatial_preview', 'hot', 1);
    const bad = rec('spatial_mobile', 'warm', 6, { cid: ROOT });
    const pinAdd = vi.fn(async (cid: string) => { if (cid === ROOT) throw new Error('no peers'); return {}; });
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('offline'));
    const results = await reconcilePins({ pinAdd, addBytes: vi.fn() } as never, [ok, bad], false);
    expect(results.map((result) => [result.cid, result.ok])).toEqual([[ok.cid, true], [ROOT, false]]);
  });
});
