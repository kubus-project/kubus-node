import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { afterEach, expect, it, vi } from 'vitest';
import { KuboClient } from '../src/ipfs/kuboClient.js';
import { ManagedPins, canonicalPinCid } from '../src/ipfs/managedPins.js';
import { LocalStore } from '../src/state/localStore.js';
import { reconcilePins } from '../src/ipfs/pinning.js';
import { reconcileDesiredPins } from '../src/operator/commitments.js';
import { ProviderCleanup } from '../src/compute/providerCleanup.js';
import { RemoteComputeRuntime } from '../src/compute/remoteComputeRuntime.js';
import type { RemoteComputeJob } from '../src/backend/models.js';

// Explicit isolated-fixture opt-in, with peer identity checked before writes.
// Never point this suite at an operator's existing repository.
const rpc = process.env.KUBUS_TEST_DISPOSABLE_KUBO_RPC;
const peer = process.env.KUBUS_TEST_DISPOSABLE_KUBO_PEER;
const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});
it.skipIf(!rpc || !peer)('verifies managed ownership and fallback integrity against disposable offline Kubo', async () => {
  const url = new URL(rpc!);
  expect(['127.0.0.1', '[::1]']).toContain(url.hostname);
  const kubo = new KuboClient(rpc!, 3000);
  expect((await kubo.id()).ID).toBe(peer);
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'kubus-offline-kubo-'));
  roots.push(root);
  const file = path.join(root, 'state.json');
  const store = new LocalStore(file);
  await store.load();
  const manager = new ManagedPins(kubo, store, { allowUnpin: true });
  const bytes = new TextEncoder().encode(`synthetic-fixture-${crypto.randomUUID()}`);
  const added = await kubo.addBytes(bytes, 'synthetic.bin', { pin: false });
  const cid = canonicalPinCid(added.Hash!);
  const isPinned = async (value: string) => {
    const response = await kubo.pinLs() as { Keys: Record<string, unknown> };
    return Object.keys(response.Keys).map(canonicalPinCid).includes(canonicalPinCid(value));
  };
  expect(await isPinned(cid)).toBe(false);
  await manager.acquire(cid, 'archive:synthetic-A');
  await manager.acquire(cid, 'provider-input:synthetic-B');
  await manager.release(cid, 'archive:synthetic-A');
  expect(await isPinned(cid)).toBe(true);
  const remove = vi.spyOn(kubo, 'pinRm').mockRejectedValueOnce(new Error('synthetic interrupted unpin'));
  await expect(manager.release(cid, 'provider-input:synthetic-B')).rejects.toThrow('synthetic interrupted');
  expect(await isPinned(cid)).toBe(true);
  const restored = new LocalStore(file);
  await restored.load();
  await new ManagedPins(kubo, restored, { allowUnpin: true }).reconcile();
  expect(await isPinned(cid)).toBe(false);
  remove.mockRestore();

  await kubo.pinAdd(cid);
  await new ManagedPins(kubo, restored, { allowUnpin: true }).acquire(cid, 'archive:synthetic-manual');
  await new ManagedPins(kubo, restored, { allowUnpin: true }).release(cid, 'archive:synthetic-manual');
  expect(await isPinned(cid)).toBe(true); // Never adopt a pre-existing manual pin for deletion.

  const matching = new TextEncoder().encode(`matching-${crypto.randomUUID()}`);
  const matchingCid = (await kubo.addBytes(matching, 'matching.bin', { pin: false })).Hash!;
  const different = new TextEncoder().encode(`wrong-gateway-${crypto.randomUUID()}`);
  const differentCid = (await kubo.addBytes(different, 'different.bin', { pin: false })).Hash!;
  const originalFetch = globalThis.fetch;
  const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, options) => {
    if (String(input).startsWith('https://ipfs.io/ipfs/')) return new Response(different);
    return originalFetch(input, options);
  });
  const pin = vi.spyOn(kubo, 'pinAdd').mockRejectedValueOnce(new Error('synthetic native retrieval failure'));
  const [mismatch] = await reconcilePins(kubo, [{ id: 'synthetic', cid: matchingCid, role: 'record' }]);
  expect(mismatch?.ok).toBe(false);
  expect(await isPinned(differentCid)).toBe(false);
  expect(await isPinned(matchingCid)).toBe(false);
  expect(pin).toHaveBeenCalledTimes(1);
  fetch.mockImplementation(async (input, options) => {
    if (String(input).startsWith('https://ipfs.io/ipfs/')) return new Response(matching);
    return originalFetch(input, options);
  });
  pin.mockRejectedValueOnce(new Error('synthetic native retrieval failure'));
  const [match] = await reconcilePins(kubo, [{ id: 'synthetic', cid: matchingCid, role: 'record' }]);
  expect(match?.ok).toBe(true);
  expect(await isPinned(matchingCid)).toBe(true);
  expect(await isPinned(differentCid)).toBe(false);

  // Exercise the actual archive, requester-cancellation and provider-cleanup
  // callers against one real shared pin, not only the ownership helper.
  const sharedBytes = new TextEncoder().encode(`shared-workflow-${crypto.randomUUID()}`);
  const sharedCid = (await kubo.addBytes(sharedBytes, 'shared.bin', { pin: false })).Hash!;
  const requesterId = '11111111-1111-4111-8111-111111111111';
  const providerId = '22222222-2222-4222-8222-222222222222';
  const requesterOwner = `requester-input:${requesterId}`;
  const sharedManager = new ManagedPins(kubo, restored, { allowUnpin: true });
  await restored.update(state => {
    state.privateComputeCids![sharedCid] = { role: 'encrypted_input', pinOwner: requesterOwner, createdAt: new Date().toISOString() };
    state.desiredCids = [{ id: 'shared-archive-fixture', cid: sharedCid, role: 'record' }];
    state.publicPinSetComplete = true;
    state.publicPinSetGeneration = `sha256:${'a'.repeat(64)}`;
  });
  await sharedManager.acquire(sharedCid, requesterOwner);
  await expect(kubo.pinLs(sharedCid)).resolves.toHaveProperty('Keys');
  const config = { localDataPath: root, managedPinReleaseEnabled: true, skipPinning: false };
  await reconcileDesiredPins(kubo, restored, config as never);
  const providerCleanup = new ProviderCleanup(restored, { ensureJobQuiescent: async () => undefined } as never, root,
    async (value, owner) => { await sharedManager.release(value, owner); });
  await providerCleanup.own({ id: providerId, inputCid: sharedCid, expiresAt: new Date(Date.now() + 60000).toISOString() } as RemoteComputeJob);
  await sharedManager.acquire(sharedCid, `provider-input:${providerId}`);
  const runtime = new RemoteComputeRuntime({
    store: restored, kubo, config,
    api: { cancelRemoteComputeJob: async () => ({ id: requesterId, state: 'CANCELLED', inputCid: sharedCid }) },
    jobs: {}, captures: {}, transport: {}, identity: {}, gate: {}, logger: {},
  } as never);
  await runtime.cancelRequesterJob(requesterId, 'Bearer synthetic-user-token');
  expect(await isPinned(sharedCid)).toBe(true);
  await restored.update(state => { state.desiredCids = []; });
  await reconcileDesiredPins(kubo, restored, config as never);
  expect(await isPinned(sharedCid)).toBe(true);
  await providerCleanup.request(providerId);
  expect(await isPinned(sharedCid)).toBe(false);
}, 20000);
