import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ensureRegistered } from '../src/operator/registerNode.js';
import { LocalStore } from '../src/state/localStore.js';
import type { AppConfig } from '../src/config/schema.js';
import type { KubusApiClient } from '../src/backend/kubusApiClient.js';
import type { KuboHealth } from '../src/ipfs/health.js';

let directory: string;
let store: LocalStore;
const config = { nodeEndpointUrl: 'http://127.0.0.1:8787', nodeLabel: 'Home Node' } as AppConfig;
const health = { peerId: 'peer', version: 'test' } as KuboHealth;
beforeEach(async () => {
  directory = await fs.mkdtemp(path.join(os.tmpdir(), 'kubus-registration-'));
  store = new LocalStore(path.join(directory, 'state.json'));
  await store.load();
  await store.update((state) => { state.nodeId = 'home-node'; state.nodeKey = 'home-registration-key'; });
});
afterEach(async () => { await fs.rm(directory, { recursive: true, force: true }); });

it('restores this installation instead of the most recently seen account Node', async () => {
  const api = {
    getCurrentNode: vi.fn(async () => ({ node: { id: 'other-node', nodeKey: 'other-key' } })),
    getNodeStatus: vi.fn(async () => ({ node: { id: 'home-node', nodeKey: 'home-registration-key' } })),
    registerNode: vi.fn(),
  };
  await ensureRegistered(api as unknown as KubusApiClient, store, config, 'peer', health);
  expect(api.getNodeStatus).toHaveBeenCalledWith('home-node');
  expect(api.getCurrentNode).not.toHaveBeenCalled();
  expect(api.registerNode).not.toHaveBeenCalled();
  expect(store.snapshot().nodeId).toBe('home-node');
});

it.each([
  { id: 'other-node', nodeKey: 'home-registration-key' },
  { id: 'home-node', nodeKey: 'substituted-key' },
  null,
])('rejects substitution or a missing registration without changing state: %j', async (node) => {
  const before = store.snapshot();
  const api = { getNodeStatus: vi.fn(async () => ({ node })), registerNode: vi.fn() };
  await expect(ensureRegistered(api as unknown as KubusApiClient, store, config, 'peer', health))
    .rejects.toMatchObject({ code: 'NODE_REGISTRATION_IDENTITY_MISMATCH' });
  expect(store.snapshot()).toEqual(before);
  expect(api.registerNode).not.toHaveBeenCalled();
});

it('preserves registration on backend failure and does not re-register', async () => {
  const before = store.snapshot();
  const api = { getNodeStatus: vi.fn(async () => { throw new Error('backend offline'); }), registerNode: vi.fn() };
  await expect(ensureRegistered(api as unknown as KubusApiClient, store, config, 'peer', health)).rejects.toThrow('backend offline');
  expect(store.snapshot()).toEqual(before);
  expect(api.registerNode).not.toHaveBeenCalled();
});

it('registers a fresh installation using its own persistent key', async () => {
  await store.update((state) => { delete state.nodeId; });
  const api = {
    getCurrentNode: vi.fn(),
    registerNode: vi.fn(async (_payload: Record<string, unknown>) => ({ id: 'new-node', nodeKey: 'home-registration-key' })),
  };
  await ensureRegistered(api as unknown as KubusApiClient, store, config, 'peer', health);
  expect(api.registerNode.mock.calls[0]?.[0]).toMatchObject({ nodeKey: 'home-registration-key' });
  expect(api.getCurrentNode).not.toHaveBeenCalled();
  expect(store.snapshot().nodeId).toBe('new-node');
});
