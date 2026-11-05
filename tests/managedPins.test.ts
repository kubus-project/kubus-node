import { completedKuboError } from './fixtures/kuboErrors.js';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { afterEach, expect, it, vi } from 'vitest';
import { CID } from 'multiformats/cid';
import * as digest from 'multiformats/hashes/digest';
import { LocalStore } from '../src/state/localStore.js';
import { ManagedPins, canonicalPinCid } from '../src/ipfs/managedPins.js';
const v0 = CID.createV0(
  digest.create(
    0x12,
    crypto.createHash('sha256').update('synthetic-pin-fixture').digest(),
  ),
).toString();
const cid = canonicalPinCid(v0);
const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0))
    await fs.rm(root, { recursive: true, force: true });
});
async function fixture(preexisting = false) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'kubus-managed-pins-'));
  roots.push(root);
  const file = path.join(root, 'state.json');
  const store = new LocalStore(file);
  await store.load();
  const pins = new Set<string>(preexisting ? [v0] : []);
  const kubo = {
    pinLs: vi.fn(async () => ({
      Keys: Object.fromEntries(
        [...pins].map((value) => [value, { Type: 'recursive' }]),
      ),
    })),
    pinAdd: vi.fn(async (value: string) => {
      pins.add(value);
    }),
    pinRm: vi.fn(async (value: string) => {
      pins.delete(value);
    }),
  };
  return { store, file, kubo, pins, manager: new ManagedPins(kubo, store, { allowUnpin: true }) };
}
it('journals a new owner before pinning and removes its unreferenced owned pin', async () => {
  const { store, kubo, manager } = await fixture();
  kubo.pinAdd.mockImplementationOnce(async (value) => {
    expect(
      store.snapshot().managedPins?.[value]?.owners['archive:record-A'],
    ).toBeDefined();
  });
  await manager.acquire(v0, 'archive:record-A');
  expect(store.snapshot().managedPins?.[cid]?.state).toBe('pinned');
  expect(await manager.release(cid, 'archive:record-A')).toMatchObject({
    ownerReleased: true,
    pinRemoved: true,
  });
  expect(kubo.pinRm).toHaveBeenCalledWith(cid);
  expect(store.snapshot().managedPins?.[cid]?.state).toBe('released');
});
it('defaults to a durable activation gate instead of removing an owned pin', async () => {
  const { store, kubo } = await fixture();
  const safeDefault = new ManagedPins(kubo, store);
  await safeDefault.acquire(cid, 'provider-input:job-A');
  expect(await safeDefault.release(cid, 'provider-input:job-A')).toMatchObject({
    ownerReleased: true, pinRemoved: false, reason: 'pin_release_activation_required',
  });
  expect(kubo.pinRm).not.toHaveBeenCalled();
  const update = vi.spyOn(store, 'update');
  await safeDefault.reconcile();
  expect(update).not.toHaveBeenCalled();
  await new ManagedPins(kubo, store, { allowUnpin: true }).reconcile({ ownerPrefix: 'archive:' });
  expect(kubo.pinRm).not.toHaveBeenCalled();
  await new ManagedPins(kubo, store, { allowUnpin: true }).reconcile({ ownerPrefix: 'provider-input:' });
  expect(kubo.pinRm).toHaveBeenCalledTimes(1);
});
it('treats equivalent v0/v1 identifiers as one pre-existing manual pin', async () => {
  const { manager, kubo, store } = await fixture(true);
  await manager.acquire(cid, 'archive:record-A');
  await manager.release(v0, 'archive:record-A');
  expect(kubo.pinRm).not.toHaveBeenCalled();
  expect(kubo.pinLs).toHaveBeenCalledWith(undefined, 'all');
  expect(store.snapshot().managedPins?.[cid]).toMatchObject({
    state: 'retained',
    ownership: 'preexisting',
  });
});
it('retains a pin that existed only as a direct manual reference', async () => {
  const { manager, kubo, store } = await fixture();
  kubo.pinLs.mockResolvedValueOnce({ Keys: { [v0]: { Type: 'direct' } } });
  await manager.acquire(cid, 'archive:record-A');
  await manager.release(cid, 'archive:record-A');
  expect(kubo.pinRm).not.toHaveBeenCalled();
  expect(store.snapshot().managedPins?.[cid]?.ownership).toBe('preexisting');
});
it('does not remove a pin whose initial ownership probe was unavailable', async () => {
  const { manager, kubo } = await fixture();
  kubo.pinLs.mockRejectedValueOnce(
    new Error('synthetic ownership unavailable'),
  );
  await manager.acquire(cid, 'archive:record-A');
  expect(await manager.release(cid, 'archive:record-A')).toMatchObject({
    pinRemoved: false,
    reason: 'preexisting_or_unknown_pin',
  });
  expect(kubo.pinRm).not.toHaveBeenCalled();
});
it('serializes separate manager instances and preserves another owner of a shared CID', async () => {
  const { manager, kubo, store } = await fixture();
  const other = new ManagedPins(kubo, store, { allowUnpin: true });
  await Promise.all([
    manager.acquire(v0, 'archive:record-A'),
    other.acquire(cid, 'provider-input:job-B'),
  ]);
  await manager.release(cid, 'archive:record-A');
  expect(kubo.pinRm).not.toHaveBeenCalled();
  expect(Object.keys(store.snapshot().managedPins![cid]!.owners)).toEqual([
    'provider-input:job-B',
  ]);
  await other.release(v0, 'provider-input:job-B');
  expect(kubo.pinRm).toHaveBeenCalledTimes(1);
});
it('retries a durable failed unpin after restart', async () => {
  const { manager, kubo, store, file } = await fixture();
  await manager.acquire(cid, 'archive:record-A');
  kubo.pinRm.mockRejectedValueOnce(completedKuboError('synthetic unpin failure'));
  await expect(manager.release(cid, 'archive:record-A')).rejects.toThrow(
    'synthetic unpin failure',
  );
  expect(store.snapshot().managedPins?.[cid]?.state).toBe('release_pending');
  const restored = new LocalStore(file);
  await restored.load();
  await new ManagedPins(kubo, restored, { allowUnpin: true }).reconcile();
  expect(restored.snapshot().managedPins?.[cid]?.state).toBe('released');
  expect(kubo.pinRm).toHaveBeenCalledTimes(2);
});
it('journals an in-flight removal before RPC and refuses new owners after an unknown outcome', async () => {
  const { manager, kubo, store, file, pins } = await fixture();
  await manager.acquire(cid, 'archive:record-A');
  let finishOldRequest!: () => void;
  const oldRequestFinished = new Promise<void>(resolve => { finishOldRequest = () => { pins.delete(cid); resolve(); }; });
  kubo.pinRm.mockImplementationOnce(async () => {
    expect(store.snapshot().managedPins![cid]!.state).toBe('releasing');
    throw new Error('synthetic connection lost; server may still be working');
  });
  await expect(manager.release(cid, 'archive:record-A')).rejects.toThrow('connection lost');
  expect(store.snapshot().managedPins![cid]!.state).toBe('release_uncertain');
  await expect(manager.acquire(cid, 'provider-input:new-owner')).rejects.toThrow('pin_release_outcome_requires_review');
  expect(kubo.pinAdd).toHaveBeenCalledTimes(1);
  finishOldRequest();
  await oldRequestFinished;
  const restored = new LocalStore(file);
  await restored.load();
  const restarted = new ManagedPins(kubo, restored, { allowUnpin: true });
  await restarted.reconcile();
  await expect(restarted.acquire(cid, 'archive:new-record')).rejects.toThrow('pin_release_outcome_requires_review');
  await expect(restarted.release(cid, 'archive:record-A')).rejects.toThrow('pin_release_outcome_requires_review');
  expect(kubo.pinRm).toHaveBeenCalledTimes(1);
});
it('does not replay a crash-interrupted in-flight release on restart', async () => {
  const { manager, kubo, store, file } = await fixture();
  await manager.acquire(cid, 'archive:record-A');
  await store.update(state => {
    state.managedPins![cid]!.owners = {};
    state.managedPins![cid]!.state = 'releasing';
    state.managedPins![cid]!.lastReleasedOwner = 'archive:record-A';
  });
  const restored = new LocalStore(file);
  await restored.load();
  const restarted = new ManagedPins(kubo, restored, { allowUnpin: true });
  await restarted.reconcile();
  expect(kubo.pinRm).not.toHaveBeenCalled();
  await expect(restarted.acquire(cid, 'archive:record-B')).rejects.toThrow('pin_release_outcome_requires_review');
});
it('retains a pending release when a generic missing RPC route does not establish pin absence', async () => {
  const { manager, kubo, store } = await fixture();
  await manager.acquire(cid, 'archive:record-A');
  kubo.pinRm.mockRejectedValueOnce(completedKuboError('HTTP 404: not found'));
  await expect(manager.release(cid, 'archive:record-A')).rejects.toThrow('HTTP 404');
  expect(store.snapshot().managedPins?.[cid]?.state).toBe('release_pending');
  kubo.pinRm.mockRejectedValueOnce(completedKuboError('not pinned'));
  await manager.reconcile();
  expect(store.snapshot().managedPins?.[cid]?.state).toBe('released');
});
it.each(['desired', 'spatial', 'legacy-private'])(
  'protects %s references and releases after the record is withdrawn',
  async (reference) => {
    const { manager, kubo, store } = await fixture();
    await manager.acquire(cid, 'archive:record-A');
    await store.update((state) => {
      if (reference === 'desired')
        state.desiredCids = [{ id: 'record', cid: v0, role: 'record' }];
      if (reference === 'spatial')
        state.spatial = { output: { manifestCid: v0 } };
      if (reference === 'legacy-private')
        state.privateComputeCids = {
          [v0]: {
            role: 'encrypted_input',
            createdAt: new Date().toISOString(),
          },
        };
    });
    await manager.release(cid, 'archive:record-A');
    expect(kubo.pinRm).not.toHaveBeenCalled();
    await store.update((state) => {
      state.desiredCids = [];
      state.spatial = {};
      state.privateComputeCids = {};
    });
    await manager.reconcile();
    expect(kubo.pinRm).toHaveBeenCalledTimes(1);
  },
);
it('new references prevent an older failed release from unpinning reused content', async () => {
  const { manager, kubo } = await fixture();
  await manager.acquire(cid, 'archive:record-A');
  kubo.pinRm.mockRejectedValueOnce(completedKuboError('offline'));
  await expect(manager.release(cid, 'archive:record-A')).rejects.toThrow();
  await manager.acquire(cid, 'spatial:output-B');
  await manager.reconcile();
  expect(kubo.pinRm).toHaveBeenCalledTimes(1);
});
it('rechecks ownership if a previously released CID is manually repinned', async () => {
  const { manager, kubo, pins, store } = await fixture();
  await manager.acquire(cid, 'archive:record-A');
  await manager.release(cid, 'archive:record-A');
  pins.add(v0);
  await manager.acquire(cid, 'archive:record-B');
  await manager.release(cid, 'archive:record-B');
  expect(kubo.pinRm).toHaveBeenCalledTimes(1);
  expect(store.snapshot().managedPins?.[cid]?.ownership).toBe('preexisting');
});
it('does not pin when owner-journal persistence fails', async () => {
  const { manager, kubo, store } = await fixture();
  vi.spyOn(store, 'update').mockRejectedValueOnce(
    new Error('synthetic disk failure'),
  );
  await expect(manager.acquire(cid, 'archive:record-A')).rejects.toThrow(
    'synthetic disk failure',
  );
  expect(kubo.pinAdd).not.toHaveBeenCalled();
});
it('preserves failed acquisition references until explicit release', async () => {
  const { manager, kubo, store } = await fixture();
  kubo.pinAdd.mockRejectedValueOnce(new Error('network unavailable'));
  await expect(manager.acquire(cid, 'archive:record-A')).rejects.toThrow();
  expect(
    store.snapshot().managedPins?.[cid]?.owners['archive:record-A'],
  ).toBeDefined();
  await manager.release(cid, 'archive:record-A');
  expect(kubo.pinRm).toHaveBeenCalledTimes(1);
});
it.each([
  'bafyFakeIdentifier',
  'QmInvalidButAlphanumeric123456789',
  'https://synthetic.invalid/credential',
  'ipfs://' + v0 + '/file',
  '__proto__',
])(
  'rejects malformed or non-bare CID %s without pin operations',
  async (value) => {
    const { manager, kubo } = await fixture();
    await expect(manager.acquire(value, 'archive:record-A')).rejects.toThrow(
      'invalid_content_identifier',
    );
    expect(kubo.pinLs).not.toHaveBeenCalled();
    expect(kubo.pinAdd).not.toHaveBeenCalled();
  },
);
it('re-probes a record left pending by a crash and never removes a pin it did not create', async () => {
  const { store, kubo, pins, manager } = await fixture();
  kubo.pinAdd.mockImplementationOnce(async () => {
    throw new Error('crash before the pin was added');
  });
  await expect(manager.acquire(v0, 'archive:record-A')).rejects.toThrow();
  expect(store.snapshot().managedPins?.[cid]?.ownership).toBe('created');
  pins.add(v0); // an operator pins the same CID before the retry
  await manager.acquire(v0, 'archive:record-A');
  expect(store.snapshot().managedPins?.[cid]?.ownership).toBe('preexisting');
  await manager.release(cid, 'archive:record-A');
  expect(kubo.pinRm).not.toHaveBeenCalled();
  expect(pins.has(v0)).toBe(true);
});
