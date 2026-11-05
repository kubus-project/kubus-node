import { promises as fs } from 'node:fs';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LocalStore } from '../src/state/localStore.js';

const dirs: string[] = [];
async function fixture() {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'kubus-node-state-'));
  dirs.push(dir);
  const file = path.join(dir, 'state.json');
  const store = new LocalStore(file);
  await store.load();
  await store.update((state) => { state.nodeId = 'committed'; });
  return { dir, file, store };
}

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(dirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

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

  it.each(['writeFile', 'rename'] as const)('keeps committed state after %s fails and permits a later update', async (operation) => {
    const { dir, file, store } = await fixture();
    const before = store.snapshot();
    const failure = Object.assign(new Error('synthetic persistence failure'), { code: 'EIO' });
    vi.spyOn(fs, operation).mockRejectedValueOnce(failure);

    await expect(store.update((state) => { state.nodeId = 'failed-candidate'; })).rejects.toBe(failure);
    expect(store.snapshot()).toEqual(before);
    await expect(new LocalStore(file).load()).resolves.toEqual(before);
    expect((await fs.readdir(dir)).filter((name) => name.endsWith('.tmp'))).toEqual([]);

    await store.update((state) => {
      expect(state.nodeId).toBe('committed');
      state.nodeId = 'retried';
    });
    await expect(new LocalStore(file).load()).resolves.toMatchObject({ nodeId: 'retried' });
  });

  it('does not expose a candidate while its atomic write is pending', async () => {
    const { file, store } = await fixture();
    const rename = fs.rename.bind(fs);
    let release!: () => void;
    let started!: () => void;
    const entered = new Promise<void>((resolve) => { started = resolve; });
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    vi.spyOn(fs, 'rename').mockImplementationOnce(async (from, to) => {
      started();
      await blocked;
      return rename(from, to);
    });
    const update = store.update((state) => { state.nodeId = 'pending'; });
    await entered;
    expect(store.snapshot().nodeId).toBe('committed');
    await expect(new LocalStore(file).load()).resolves.toMatchObject({ nodeId: 'committed' });
    release();
    await update;
    expect(store.snapshot().nodeId).toBe('pending');
  });

  it('serializes asynchronous mutators against the previous committed transaction', async () => {
    const { file, store } = await fixture();
    const order: string[] = [];
    let release!: () => void;
    let started!: () => void;
    const entered = new Promise<void>((resolve) => { started = resolve; });
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    const first = store.update(async (state) => {
      order.push('first-start');
      state.nodeId = 'first';
      started();
      await blocked;
      order.push('first-end');
    });
    await entered;
    const second = store.update((state) => {
      order.push('second');
      expect(state.nodeId).toBe('first');
      state.nodeKey = 'synthetic-node-key';
    });
    await Promise.resolve();
    expect(order).toEqual(['first-start']);
    expect(store.snapshot().nodeId).toBe('committed');
    release();
    await Promise.all([first, second]);
    expect(order).toEqual(['first-start', 'first-end', 'second']);
    await expect(new LocalStore(file).load()).resolves.toMatchObject({ nodeId: 'first', nodeKey: 'synthetic-node-key' });
  });

  it('rolls back a throwing async mutator and runs its queued successor', async () => {
    const { file, store } = await fixture();
    const failure = new Error('synthetic mutator failure');
    const first = store.update(async (state) => {
      state.nodeId = 'must-not-commit';
      await Promise.resolve();
      throw failure;
    });
    const rejected = expect(first).rejects.toBe(failure);
    const second = store.update((state) => {
      expect(state.nodeId).toBe('committed');
      state.nodeId = 'successor';
    });
    await Promise.all([rejected, second]);
    await expect(new LocalStore(file).load()).resolves.toMatchObject({ nodeId: 'successor' });
  });

  it('detaches committed state from both mutator and returned references', async () => {
    const { file, store } = await fixture();
    let retained!: ReturnType<LocalStore['snapshot']>;
    const result = await store.update((state) => {
      retained = state;
      state.nodeId = 'detached';
    });
    retained.nodeId = 'mutator-alias';
    result.nodeId = 'result-alias';
    expect(store.snapshot().nodeId).toBe('detached');
    await expect(new LocalStore(file).load()).resolves.toMatchObject({ nodeId: 'detached' });
  });

  it('serializes initialization for concurrent updates before an explicit load', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'kubus-node-unloaded-'));
    dirs.push(dir);
    const file = path.join(dir, 'state.json');
    const store = new LocalStore(file);
    await Promise.all([
      store.update((state) => { state.nodeId = 'initialized'; }),
      store.update((state) => { state.nodeKey = state.nodeId; }),
    ]);
    await expect(new LocalStore(file).load()).resolves.toMatchObject({ nodeId: 'initialized', nodeKey: 'initialized' });
  });
});
