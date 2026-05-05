import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { LocalStore } from '../src/state/localStore.js';

describe('LocalStore', () => {
  it('persists state atomically', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'kubus-node-'));
    const store = new LocalStore(path.join(dir, 'state.json'));
    await store.load();
    await store.update((state) => {
      state.nodeId = 'node-1';
    });
    expect(JSON.parse(await readFile(path.join(dir, 'state.json'), 'utf8')).nodeId).toBe('node-1');
  });

  it('persists public pin set metadata separately from rewardables', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'kubus-node-'));
    const file = path.join(dir, 'state.json');
    const store = new LocalStore(file);
    await store.load();
    await store.update((state) => {
      state.publicPinSet = [{ id: 'cid-manifest', cid: 'bafymanifest', role: 'manifest', objectType: 'artwork', objectId: 'art-1', version: 1 }];
      state.desiredCids = state.publicPinSet;
      state.rewardableCids = [{ id: 'rewardable-1', cid: 'bafyleaf', objectType: 'artwork', objectId: 'art-1', version: 1 }];
    });

    const reloaded = new LocalStore(file);
    await expect(reloaded.load()).resolves.toMatchObject({
      publicPinSet: [{ cid: 'bafymanifest', role: 'manifest' }],
      rewardableCids: [{ cid: 'bafyleaf' }],
    });
  });

  it('backs up corrupt state', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'kubus-node-'));
    const file = path.join(dir, 'state.json');
    await writeFile(file, '{bad');
    const store = new LocalStore(file);
    await expect(store.load()).resolves.toMatchObject({ version: 1 });
  });
});
