import { completedKuboError } from './fixtures/kuboErrors.js';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { afterEach, expect, it, vi } from 'vitest';
import { LocalStore } from '../src/state/localStore.js';
import { reconcileDesiredPins } from '../src/operator/commitments.js';
import { ManagedPins, canonicalPinCid } from '../src/ipfs/managedPins.js';
import { syntheticCid } from './fixtures/contentIds.js';
import type { PublicPinSetRecord } from '../src/backend/models.js';
import type { AppConfig } from '../src/config/schema.js';

const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});
const first = syntheticCid('archive-first');
const second = syntheticCid('archive-second');
const config = { managedPinReleaseEnabled: true, skipPinning: false } as AppConfig;
const record = (id = 'A', cid = first): PublicPinSetRecord => ({ id, cid, role: 'record', objectType: 'artwork', objectId: id, version: 1 });
async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'kubus-archive-reconcile-'));
  roots.push(root);
  const file = path.join(root, 'state.json');
  const store = new LocalStore(file);
  await store.load();
  const pins = new Set<string>();
  const kubo = {
    pinLs: vi.fn(async () => ({ Keys: Object.fromEntries([...pins].map(cid => [cid, { Type: 'recursive' }])) })),
    pinAdd: vi.fn(async (cid: string) => { pins.add(canonicalPinCid(cid)); }),
    pinRm: vi.fn(async (cid: string) => { pins.delete(canonicalPinCid(cid)); }),
  };
  async function desired(records: PublicPinSetRecord[]) {
    await store.update(state => {
      state.desiredCids = records;
      state.publicPinSet = records;
      state.publicPinSetComplete = true;
      state.publicPinSetGeneration = `sha256:${'a'.repeat(64)}`;
    });
  }
  return { root, file, store, kubo, pins, desired, run: () => reconcileDesiredPins(kubo as never, store, config) };
}
it('pins the initial record and releases its obsolete CID after replacement', async () => {
  const { desired, run, store, pins, kubo } = await fixture();
  await desired([record()]);
  await run();
  expect(pins.has(canonicalPinCid(first))).toBe(true);
  expect(store.snapshot().managedPins![canonicalPinCid(first)]!.ownership).toBe('created');
  await desired([record('A', second)]);
  await run();
  expect(pins.has(canonicalPinCid(first))).toBe(false);
  expect(pins.has(canonicalPinCid(second))).toBe(true);
  expect(kubo.pinRm).toHaveBeenCalledTimes(1);
});
it('protects a CID shared by public records and handles a genuinely empty desired set', async () => {
  const { desired, run, store, kubo, pins } = await fixture();
  await desired([record('A'), record('B')]);
  await run();
  expect(Object.keys(store.snapshot().managedPins![canonicalPinCid(first)]!.owners)).toHaveLength(2);
  await desired([record('B')]);
  await run();
  expect(kubo.pinRm).not.toHaveBeenCalled();
  await desired([]);
  await run();
  expect(kubo.pinRm).toHaveBeenCalledTimes(1);
  expect(pins.size).toBe(0);
});
it('retains a CID while a provider-input owner still needs it', async () => {
  const { desired, run, store, kubo } = await fixture();
  await desired([record()]);
  await run();
  const manager = new ManagedPins(kubo, store, { allowUnpin: true });
  await manager.acquire(first, 'provider-input:synthetic-job');
  await desired([]);
  await run();
  expect(kubo.pinRm).not.toHaveBeenCalled();
  await manager.release(first, 'provider-input:synthetic-job');
  expect(kubo.pinRm).toHaveBeenCalledTimes(1);
});
it('does not adopt a manually pre-existing pin for automatic deletion', async () => {
  const { desired, run, pins, kubo } = await fixture();
  pins.add(canonicalPinCid(first));
  await desired([record()]);
  await run();
  await desired([]);
  await run();
  expect(kubo.pinRm).not.toHaveBeenCalled();
  expect(pins.has(canonicalPinCid(first))).toBe(true);
});
it('preserves legacy spatial references until their independent record is withdrawn', async () => {
  const { desired, run, store, kubo } = await fixture();
  await desired([record()]);
  await run();
  await store.update(state => { state.spatial = { legacy: { manifestCid: first } }; });
  await desired([]);
  await run();
  expect(kubo.pinRm).not.toHaveBeenCalled();
  await store.update(state => { state.spatial = {}; });
  await run();
  expect(kubo.pinRm).toHaveBeenCalledTimes(1);
});
it.each(['legacy', 'incomplete'])('does not release from a %s canonical response', async kind => {
  const { desired, run, store, kubo } = await fixture();
  await desired([record()]);
  await run();
  await desired([]);
  await store.update(state => {
    if (kind === 'legacy') delete state.publicPinSetGeneration;
    else state.publicPinSetComplete = false;
  });
  await run();
  expect(kubo.pinRm).not.toHaveBeenCalled();
  expect(Object.keys(store.snapshot().managedPins![canonicalPinCid(first)]!.owners)).toHaveLength(1);
});
it('journals release while disabled and reconciles only after explicit activation', async () => {
  const { desired, store, kubo } = await fixture();
  const disabled = { ...config, managedPinReleaseEnabled: undefined };
  await desired([record()]);
  await reconcileDesiredPins(kubo as never, store, disabled);
  await desired([]);
  await reconcileDesiredPins(kubo as never, store, disabled);
  expect(kubo.pinRm).not.toHaveBeenCalled();
  expect(store.snapshot().managedPins![canonicalPinCid(first)]!.reason).toBe('pin_release_activation_required');
  await reconcileDesiredPins(kubo as never, store, config);
  expect(kubo.pinRm).toHaveBeenCalledTimes(1);
});
it('retries an interrupted unpin after a state reload without losing shared references', async () => {
  const { desired, run, store, file, kubo } = await fixture();
  await desired([record()]);
  await run();
  await desired([]);
  kubo.pinRm.mockRejectedValueOnce(completedKuboError('synthetic offline'));
  await expect(run()).rejects.toThrow('synthetic offline');
  expect(store.snapshot().managedPins![canonicalPinCid(first)]!.state).toBe('release_pending');
  const restored = new LocalStore(file);
  await restored.load();
  await reconcileDesiredPins(kubo as never, restored, config);
  expect(restored.snapshot().managedPins![canonicalPinCid(first)]!.state).toBe('released');
});
