import { afterEach, expect, it, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import type { RemoteComputeJob } from '../src/backend/models.js';
import { LocalStore } from '../src/state/localStore.js';
import {
  ProviderCleanup,
  type RemoteRuntimeRecord,
} from '../src/compute/providerCleanup.js';
const id = '11111111-1111-4111-8111-111111111111';
const child = '22222222-2222-4222-8222-222222222222';
const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0))
    await fs.rm(root, { recursive: true, force: true });
});
function job(extra: Record<string, unknown> = {}): RemoteComputeJob {
  return {
    id,
    inputCid: 'synthetic-ciphertext',
    expiresAt: new Date(Date.now() + 60000).toISOString(),
    ...extra,
  } as RemoteComputeJob;
}
async function fixture() {
  const root = await fs.mkdtemp(
    path.join(os.tmpdir(), 'kubus-provider-cleanup-'),
  );
  roots.push(root);
  const file = path.join(root, 'state.json');
  const store = new LocalStore(file);
  await store.load();
  const ensureJobQuiescent = vi.fn(async (_id: string) => undefined);
  const jobs = { ensureJobQuiescent } as never;
  const cleanup = new ProviderCleanup(store, jobs, root);
  return {
    root,
    file,
    store,
    ensureJobQuiescent,
    jobs,
    cleanup,
    target: path.join(root, 'private', 'remote-jobs', id),
  };
}
async function readable(target: string) {
  await fs.mkdir(path.join(target, 'capture'), { recursive: true });
  await fs.writeFile(
    path.join(target, 'capture', 'synthetic-source'),
    'fixture',
  );
}
function record(store: LocalStore) {
  return store.snapshot().remoteJobs?.[id] as RemoteRuntimeRecord;
}
it('journals ownership before decryption and removes a partially created source directory', async () => {
  const { cleanup, target, store } = await fixture();
  await cleanup.own(job());
  expect(record(store).cleanup?.plaintext).toBe('pending');
  await readable(target);
  await cleanup.request(id);
  await expect(fs.stat(target)).rejects.toMatchObject({ code: 'ENOENT' });
  expect(record(store).cleanup).toMatchObject({
    requested: true,
    plaintext: 'complete',
    inputPinReleasePending: true,
  });
});
it('retries pin release after restart without repeating successful plaintext cleanup', async () => {
  const { store, root, jobs, target, file } = await fixture();
  const releasePin = vi.fn(async () => undefined).mockRejectedValueOnce(new Error('synthetic pin RPC offline'));
  const cleanup = new ProviderCleanup(store, jobs, root, releasePin);
  await cleanup.own(job());
  await readable(target);
  await expect(cleanup.request(id)).rejects.toThrow('synthetic pin RPC offline');
  expect(record(store).cleanup).toMatchObject({ plaintext: 'complete', inputPinReleasePending: true, reason: 'provider_pin_release_retry_required' });
  await expect(fs.stat(target)).rejects.toMatchObject({ code: 'ENOENT' });
  const restored = new LocalStore(file);
  await restored.load();
  await new ProviderCleanup(restored, jobs, root, releasePin).reconcilePending();
  expect(record(restored).cleanup?.inputPinReleasePending).toBe(false);
  expect(releasePin).toHaveBeenCalledTimes(2);
});
it('preserves unverified legacy input pins even when plaintext cleanup succeeds', async () => {
  const { store, root, jobs, target } = await fixture();
  const releasePin = vi.fn(async () => undefined);
  const cleanup = new ProviderCleanup(store, jobs, root, releasePin);
  await cleanup.own(job());
  await store.update(state => { delete (state.remoteJobs![id] as RemoteRuntimeRecord).cleanup!.pinOwner; });
  await readable(target);
  await cleanup.request(id);
  expect(record(store).cleanup).toMatchObject({ plaintext: 'complete', inputPinReleasePending: true });
  expect(releasePin).not.toHaveBeenCalled();
});
it('waits for download/decrypt writers before acknowledging plaintext cleanup', async () => {
  const { cleanup, target, store } = await fixture();
  await cleanup.own(job());
  await readable(target);
  let release!: () => void, entered!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const work = cleanup.runPreparation(id, async () => {
    entered();
    await gate;
    await fs.writeFile(path.join(target, 'late-partial'), 'fixture');
  });
  await started;
  const clearing = cleanup.request(id);
  await new Promise((resolve) => setTimeout(resolve, 15));
  expect(record(store).cleanup?.plaintext).toBe('pending');
  expect((await fs.stat(target)).isDirectory()).toBe(true);
  release();
  await work;
  await clearing;
  await expect(fs.stat(target)).rejects.toMatchObject({ code: 'ENOENT' });
});
it('does not delete remote source until every discovered child job proves worker quiescence', async () => {
  const { cleanup, target, store, ensureJobQuiescent } = await fixture();
  await cleanup.own(job());
  await readable(target);
  await store.update((state) => {
    (state.jobs ??= {})[child] = {
      id: child,
      input: { remoteComputeJobId: id },
      state: 'cancelled',
    };
  });
  ensureJobQuiescent.mockRejectedValueOnce(new Error('worker still running'));
  await expect(cleanup.request(id)).rejects.toThrow('worker still running');
  expect((await fs.stat(target)).isDirectory()).toBe(true);
  expect(record(store).cleanup?.plaintext).toBe('blocked');
  expect(ensureJobQuiescent).toHaveBeenCalledWith(child);
  await cleanup.request(id);
  await expect(fs.stat(target)).rejects.toMatchObject({ code: 'ENOENT' });
});
it('reconciles expired readable input after restart without a backend request', async () => {
  const { cleanup, target, store, file, jobs, root } = await fixture();
  await cleanup.own(
    job({ expiresAt: new Date(Date.now() - 1000).toISOString() }),
  );
  await readable(target);
  const captureId = 'remote-' + id;
  await store.update((state) => {
    (state.captures ??= {})[captureId] = {
      directory: path.join(target, 'capture'),
    };
  });
  const restored = new LocalStore(file);
  await restored.load();
  await new ProviderCleanup(restored, jobs, root).reconcilePending();
  expect(record(restored).cleanup?.plaintext).toBe('complete');
  expect(restored.snapshot().captures?.[captureId]).toBeUndefined();
  await expect(fs.stat(target)).rejects.toMatchObject({ code: 'ENOENT' });
});
it('rejects a late preparation after cleanup was requested', async () => {
  const { cleanup } = await fixture();
  await cleanup.own(job());
  await cleanup.request(id);
  const work = vi.fn(async () => undefined);
  await expect(cleanup.runPreparation(id, work)).rejects.toThrow(
    'provider_preparation_cancelled_or_expired',
  );
  expect(work).not.toHaveBeenCalled();
});
it('legacy input directories are retained without an ownership journal', async () => {
  const { cleanup, target, store } = await fixture();
  await readable(target);
  await store.update((state) => {
    (state.remoteJobs ??= {})[id] = {
      backendJobId: id,
      role: 'provider',
      captureId: 'remote-' + id,
      state: 'RUNNING',
    };
  });
  await expect(cleanup.own(job())).rejects.toThrow(
    'legacy_provider_ownership_requires_review',
  );
  await expect(cleanup.request(id)).rejects.toThrow(
    'provider_cleanup_ownership_unverified',
  );
  expect((await fs.stat(target)).isDirectory()).toBe(true);
});
it('does not adopt a changed input CID for an existing job', async () => {
  const { cleanup } = await fixture();
  await cleanup.own(job());
  await expect(cleanup.own(job({ inputCid: 'different' }))).rejects.toThrow(
    'provider_job_not_reusable',
  );
});
it('rejects path-shaped job IDs before creating ownership records', async () => {
  const { cleanup, store } = await fixture();
  await expect(cleanup.own(job({ id: '../outside' }))).rejects.toThrow(
    'provider_job_identity_invalid',
  );
  expect(store.snapshot().remoteJobs).toEqual({});
});
it('does not follow a remote input junction into an unrelated directory', async () => {
  const { cleanup, target, root } = await fixture();
  await cleanup.own(job());
  const outside = path.join(root, 'unrelated');
  await fs.mkdir(outside);
  await fs.writeFile(path.join(outside, 'keep'), 'fixture');
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.symlink(
    outside,
    target,
    process.platform === 'win32' ? 'junction' : 'dir',
  );
  await expect(cleanup.request(id)).rejects.toThrow('cleanup_path_not_owned');
  expect(await fs.readFile(path.join(outside, 'keep'), 'utf8')).toBe('fixture');
});
it('retains capture metadata and a retry record if file removal fails', async () => {
  const { cleanup, target, store } = await fixture();
  await cleanup.own(job());
  await readable(target);
  await store.update((state) => {
    (state.captures ??= {})['remote-' + id] = {
      directory: path.join(target, 'capture'),
    };
  });
  const original = fs.rm.bind(fs);
  const rm = vi.spyOn(fs, 'rm').mockImplementation(async (value, options) => {
    if (String(value) === target) throw new Error('synthetic lock');
    return original(value, options);
  });
  await expect(cleanup.request(id)).rejects.toThrow('synthetic lock');
  expect(record(store).cleanup?.plaintext).toBe('blocked');
  expect(store.snapshot().captures?.['remote-' + id]).toBeDefined();
  rm.mockRestore();
  await cleanup.request(id);
  expect(store.snapshot().captures?.['remote-' + id]).toBeUndefined();
});
