import { completedKuboError } from './fixtures/kuboErrors.js';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { afterEach, expect, it, vi } from 'vitest';
import { LocalStore } from '../src/state/localStore.js';
import { RemoteComputeRuntime } from '../src/compute/remoteComputeRuntime.js';
import { ManagedPins, canonicalPinCid } from '../src/ipfs/managedPins.js';
import { syntheticCid } from './fixtures/contentIds.js';

const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});
const cid = syntheticCid('requester-input');
const id = '22222222-2222-4222-8222-222222222222';
async function fixture(releaseEnabled = true) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'kubus-requester-pins-'));
  roots.push(root);
  const store = new LocalStore(path.join(root, 'state.json'));
  await store.load();
  const pins = new Set<string>();
  const kubo = {
    pinLs: vi.fn(async () => ({ Keys: Object.fromEntries([...pins].map(value => [value, { Type: 'recursive' }])) })),
    pinAdd: vi.fn(async (value: string) => { pins.add(value); }),
    pinRm: vi.fn(async (value: string) => { pins.delete(value); }),
  };
  const api = {
    cancelRemoteComputeJob: vi.fn(async (): Promise<{ id: string; state: string; inputCid: string }> => ({ id, state: 'CANCELLED', inputCid: cid })),
    createRemoteComputeJob: vi.fn(async () => { throw new Error('synthetic response lost after possible commit'); }),
  };
  const runtime = new RemoteComputeRuntime({
    store, kubo, config: { localDataPath: root, managedPinReleaseEnabled: releaseEnabled }, api,
    transport: { encryptCapture: async () => ({ inputCid: cid }) },
    gate: { assertUsefulOperation: async () => undefined },
    jobs: {}, captures: {}, identity: {}, logger: { warn: vi.fn(), info: vi.fn() },
  } as never);
  const manager = new ManagedPins(kubo, store, { allowUnpin: releaseEnabled });
  async function own() {
    await store.update(state => { state.privateComputeCids![cid] = {
      pinOwner: `requester-input:${id}`, role: 'encrypted_input', createdAt: new Date().toISOString(), jobId: id,
    }; });
    await manager.acquire(cid, `requester-input:${id}`);
  }
  return { root, store, pins, kubo, api, runtime, manager, own };
}
it('releases a cancelled requester input only after current backend authorization and terminal state', async () => {
  const { own, runtime, store, kubo, pins, api } = await fixture();
  await own();
  await expect(runtime.cancelRequesterJob(id, '')).rejects.toThrow();
  expect(api.cancelRemoteComputeJob).not.toHaveBeenCalled();
  expect(kubo.pinRm).not.toHaveBeenCalled();
  await runtime.cancelRequesterJob(id, 'Bearer synthetic-user-token');
  expect(kubo.pinRm).toHaveBeenCalledWith(canonicalPinCid(cid));
  expect(pins.size).toBe(0);
  expect(store.snapshot().privateComputeCids![cid]!.releasedAt).toBeDefined();
});
it('does not remove a shared archive or provider reference on requester cancellation', async () => {
  const { own, manager, runtime, kubo, store } = await fixture();
  await own();
  await manager.acquire(cid, 'archive:other-authorized-record');
  await manager.acquire(cid, 'provider-input:other-job');
  await runtime.cancelRequesterJob(id, 'Bearer synthetic-user-token');
  expect(kubo.pinRm).not.toHaveBeenCalled();
  expect(store.snapshot().managedPins![canonicalPinCid(cid)]!.owners).toHaveProperty('archive:other-authorized-record');
  expect(store.snapshot().managedPins![canonicalPinCid(cid)]!.owners).toHaveProperty('provider-input:other-job');
});
it('does not release input when a cancellation response is not terminal', async () => {
  const { own, runtime, kubo, api, store } = await fixture();
  await own();
  api.cancelRemoteComputeJob.mockResolvedValueOnce({ id, state: 'RUNNING', inputCid: cid });
  await expect(runtime.cancelRequesterJob(id, 'Bearer synthetic-user-token')).rejects.toThrow('remote_compute_not_terminal');
  expect(kubo.pinRm).not.toHaveBeenCalled();
  expect(Object.keys(store.snapshot().managedPins![canonicalPinCid(cid)]!.owners)).toHaveLength(1);
});
it('retains legacy inputs without ownership proof rather than directly unpinning them', async () => {
  const { store, runtime, kubo } = await fixture();
  await store.update(state => { state.privateComputeCids![cid] = { role: 'encrypted_input', createdAt: new Date().toISOString() }; });
  await runtime.cancelRequesterJob(id, 'Bearer synthetic-user-token');
  expect(kubo.pinRm).not.toHaveBeenCalled();
  expect(store.snapshot().privateComputeCids![cid]!.releasedAt).toBeUndefined();
});
it('keeps a failed input release pending and retries without claiming it completed', async () => {
  const { own, runtime, kubo, store } = await fixture();
  await own();
  kubo.pinRm.mockRejectedValueOnce(completedKuboError('synthetic pin RPC offline'));
  await expect(runtime.cancelRequesterJob(id, 'Bearer synthetic-user-token')).rejects.toThrow('synthetic pin RPC offline');
  expect(store.snapshot().privateComputeCids![cid]!.releasedAt).toBeUndefined();
  expect(store.snapshot().managedPins![canonicalPinCid(cid)]!.state).toBe('release_pending');
  await runtime.cancelRequesterJob(id, 'Bearer synthetic-user-token');
  expect(store.snapshot().privateComputeCids![cid]!.releasedAt).toBeDefined();
  expect(kubo.pinRm).toHaveBeenCalledTimes(2);
});
it('preserves the encrypted input after ambiguous backend submission failure', async () => {
  const { own, runtime, kubo, store, pins } = await fixture();
  await own();
  await store.update(state => { delete state.privateComputeCids![cid]!.jobId; });
  await expect(runtime.requestJob({
    authorization: 'Bearer synthetic-user-token', captureId: 'synthetic-capture',
    provider: { nodeId: 'synthetic-provider', encryptionPublicKey: 'synthetic-key' }, requirements: {},
  } as never)).rejects.toThrow('synthetic response lost');
  expect(kubo.pinRm).not.toHaveBeenCalled();
  expect(pins.has(canonicalPinCid(cid))).toBe(true);
  expect(Object.keys(store.snapshot().managedPins![canonicalPinCid(cid)]!.owners)).toHaveLength(1);
  expect(store.snapshot().privateComputeCids![cid]).toMatchObject({ submissionState: 'unconfirmed', submissionReconciliationRequired: true });
  expect(runtime.cleanupDiagnostics().requesterSubmissionsUnconfirmed).toBe(1);
});
it('releases an unused encrypted input by CID without a job, once, and unpins it when nothing else holds it', async () => {
  const { own, runtime, kubo, store, pins } = await fixture();
  await own();
  await runtime.releaseUnusedInput(cid);
  expect(kubo.pinRm).toHaveBeenCalledWith(canonicalPinCid(cid));
  expect(pins.size).toBe(0);
  expect(store.snapshot().privateComputeCids![cid]!.releasedAt).toBeDefined();
  // Idempotent: a second release (a retry after a crash) does nothing.
  await runtime.releaseUnusedInput(cid);
  expect(kubo.pinRm).toHaveBeenCalledTimes(1);
});
it('does not release an unused input that is unknown, legacy (no owner) or still held by another owner', async () => {
  const { own, manager, runtime, kubo, store } = await fixture();
  await runtime.releaseUnusedInput(syntheticCid('never-seen'));
  await store.update(state => { state.privateComputeCids![cid] = { role: 'encrypted_input', createdAt: new Date().toISOString() }; });
  await runtime.releaseUnusedInput(cid);
  expect(kubo.pinRm).not.toHaveBeenCalled();
  await own();
  await manager.acquire(cid, 'archive:other-authorized-record');
  await runtime.releaseUnusedInput(cid);
  expect(kubo.pinRm).not.toHaveBeenCalled();
  expect(store.snapshot().managedPins![canonicalPinCid(cid)]!.owners).toHaveProperty('archive:other-authorized-record');
});
it('says an input pin was not released while pin release is switched off, and does not mark it released', async () => {
  const { own, runtime, kubo, store, pins } = await fixture(false);
  await own();
  // Both routes: an unused input, and the input a finished job held.
  expect(await runtime.releaseUnusedInput(cid)).toMatchObject({ released: false, reason: 'pin_release_activation_required' });
  expect(await runtime.releaseInput({ id, state: 'FAILED', inputCid: cid } as never)).toMatchObject({ released: false, reason: 'pin_release_activation_required' });
  expect(store.snapshot().privateComputeCids![cid]!.releasedAt).toBeUndefined();
  expect(kubo.pinRm).not.toHaveBeenCalled();
  expect(pins.has(canonicalPinCid(cid))).toBe(true);
  expect(store.snapshot().managedPins![canonicalPinCid(cid)]!.state).toBe('release_pending');
});
it('reports the input released once pin release is switched on and the same release is tried again', async () => {
  const { own, root, kubo, api, store, pins } = await fixture(false);
  await own();
  const switchedOn = new RemoteComputeRuntime({
    store, kubo, config: { localDataPath: root, managedPinReleaseEnabled: true }, api, transport: {}, gate: {}, jobs: {}, captures: {}, identity: {}, logger: { warn: vi.fn(), info: vi.fn() },
  } as never);
  expect(await switchedOn.releaseUnusedInput(cid)).toEqual({ released: true });
  expect(pins.size).toBe(0);
  expect(store.snapshot().privateComputeCids![cid]!.releasedAt).toBeDefined();
});
it('says released for an input that was released, shared with another owner, or never ours to remove', async () => {
  const { own, manager, runtime } = await fixture();
  await own();
  await manager.acquire(cid, 'archive:other-authorized-record');
  expect(await runtime.releaseUnusedInput(cid)).toEqual({ released: true });
  expect(await runtime.releaseUnusedInput(cid)).toEqual({ released: true });
  expect(await runtime.releaseUnusedInput(syntheticCid('unknown-input'))).toEqual({ released: true });
});
it('releases every encrypted input pinned under an owner, for a requester that crashed before it learned the CID', async () => {
  const { own, runtime, kubo, store, pins } = await fixture();
  await own();
  const other = syntheticCid('other-requester-input');
  await store.update(state => { state.privateComputeCids![other] = { pinOwner: 'requester-input:99999999-9999-4999-8999-999999999999', role: 'encrypted_input', createdAt: new Date().toISOString() }; });
  await new ManagedPins(kubo, store, { allowUnpin: true }).acquire(other, 'requester-input:99999999-9999-4999-8999-999999999999');
  expect(await runtime.releaseInputsOwnedBy(`requester-input:${id}`)).toEqual({ released: true });
  expect(store.snapshot().privateComputeCids![cid]!.releasedAt).toBeDefined();
  // The other owner's input is untouched.
  expect(store.snapshot().privateComputeCids![other]!.releasedAt).toBeUndefined();
  expect(pins.has(canonicalPinCid(other))).toBe(true);
  // Nothing under an owner: nothing to release, which is released.
  expect(await runtime.releaseInputsOwnedBy('requester-input:00000000-0000-4000-8000-000000000000')).toEqual({ released: true });
});
