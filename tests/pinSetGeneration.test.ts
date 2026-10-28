import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { afterEach, expect, it, vi } from 'vitest';
import { syncPublicPinSet } from '../src/operator/commitments.js';
import { LocalStore } from '../src/state/localStore.js';
import type { AppConfig } from '../src/config/schema.js';

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});
const generation = `sha256:${'a'.repeat(64)}`;
const changed = `sha256:${'b'.repeat(64)}`;
const config = { maxPinnedCids: 10, maxPinnedBytes: 1e6, cidClassFilters: [] } as unknown as AppConfig;
const record = (index: number) => ({ id: `synthetic-${index}`, cid: `synthetic-cid-${index}`, role: 'record' });
async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'kubus-pin-set-generation-'));
  roots.push(root);
  const store = new LocalStore(path.join(root, 'state.json'));
  await store.load();
  await store.update(state => {
    state.desiredCids = [record(-1)];
    state.publicPinSetGeneration = changed;
  });
  return store;
}
function apiFor(...pages: unknown[]) {
  const getPublicPinSet = vi.fn();
  for (const page of pages) getPublicPinSet.mockResolvedValueOnce(page);
  return { getPublicPinSet, getRewardableCids: vi.fn(async () => ({ count: 0, records: [] })) };
}
it('accepts a stable complete generation only after all pages and a final confirmation', async () => {
  const store = await fixture();
  const api = apiFor(
    { count: 1001, complete: true, generation, records: Array.from({ length: 1000 }, (_, i) => record(i)) },
    { count: 1001, complete: true, generation, records: [record(1000)] },
    { count: 1001, complete: true, generation, records: [record(0)] },
  );
  await syncPublicPinSet(api as never, store, config);
  expect(api.getPublicPinSet.mock.calls).toEqual([
    [{ limit: 1000, offset: 0 }], [{ limit: 1000, offset: 1000 }], [{ limit: 1, offset: 0 }],
  ]);
  expect(store.snapshot().publicPinSet).toHaveLength(1001);
  expect(store.snapshot().publicPinSetGeneration).toBe(generation);
});
it('rejects same-count generation drift between pages without replacing the previous plan', async () => {
  const store = await fixture();
  const before = store.snapshot();
  const api = apiFor(
    { count: 1001, complete: true, generation, records: Array.from({ length: 1000 }, (_, i) => record(i)) },
    { count: 1001, complete: true, generation: changed, records: [record(1000)] },
  );
  await expect(syncPublicPinSet(api as never, store, config)).rejects.toThrow('changed');
  expect(store.snapshot()).toEqual(before);
});
it('rejects a same-count change before final confirmation', async () => {
  const store = await fixture();
  const before = store.snapshot();
  const api = apiFor(
    { count: 1, complete: true, generation, records: [record(1)] },
    { count: 1, complete: true, generation: changed, records: [record(2)] },
  );
  await expect(syncPublicPinSet(api as never, store, config)).rejects.toThrow('changed');
  expect(store.snapshot()).toEqual(before);
});
it('retains the previous plan if final confirmation is unavailable', async () => {
  const store = await fixture();
  const before = store.snapshot();
  const api = apiFor({ count: 1, complete: true, generation, records: [record(1)] });
  api.getPublicPinSet.mockRejectedValueOnce(new Error('synthetic offline'));
  await expect(syncPublicPinSet(api as never, store, config)).rejects.toThrow('synthetic offline');
  expect(store.snapshot()).toEqual(before);
});
it('records a confirmed genuinely empty set without confusing it with an unavailable response', async () => {
  const store = await fixture();
  const empty = { count: 0, complete: true, generation, records: [] };
  await syncPublicPinSet(apiFor(empty, empty) as never, store, config);
  expect(store.snapshot().desiredCids).toEqual([]);
  expect(store.snapshot().publicPinSetComplete).toBe(true);
  expect(store.snapshot().publicPinSetGeneration).toBe(generation);
});
it('keeps older-server compatibility without retaining a stale trusted generation', async () => {
  const store = await fixture();
  await syncPublicPinSet(apiFor({ count: 1, complete: true, records: [record(1)] }) as never, store, config);
  expect(store.snapshot().publicPinSetGeneration).toBeUndefined();
  expect(store.snapshot().desiredCids[0]?.id).toBe('synthetic-1');
});
it.each([
  { count: 1, complete: true, generation: 'invalid', records: [record(1)] },
  { count: 1, complete: false, generation, records: [record(1)] },
  { count: 2, complete: true, generation, records: [record(1), record(1)] },
])('rejects invalid, incomplete or overlapping records without changing state', async page => {
  const store = await fixture();
  const before = store.snapshot();
  await expect(syncPublicPinSet(apiFor(page) as never, store, config)).rejects.toThrow();
  expect(store.snapshot()).toEqual(before);
});
