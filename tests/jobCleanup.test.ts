import { afterEach, expect, it, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { LocalStore } from '../src/state/localStore.js';
import { JobCleanup } from '../src/jobs/jobCleanup.js';
const id = '11111111-1111-4111-8111-111111111111';
const instance = '22222222-2222-4222-8222-222222222222';
const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});
async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'kubus-cleanup-')); roots.push(root);
  const file = path.join(root, 'state.json'); const store = new LocalStore(file); await store.load();
  const auth = { issue: async () => 'synthetic-token' } as never;
  const cleanup = new JobCleanup(store, root, auth, 'http://worker.invalid');
  await cleanup.own(id, 'spatial.reconstruct');
  const target = path.join(root, 'private', 'jobs', id); await fs.mkdir(target, { recursive: true });
  await fs.writeFile(path.join(target, 'synthetic-private'), 'synthetic');
  return { root, file, store, auth, cleanup, target };
}
it('cleans partial job-owned files before a worker was attempted without network', async () => {
  const { cleanup, target, store } = await fixture(); const fetch = vi.spyOn(globalThis, 'fetch');
  await cleanup.reconcile(id); expect(fetch).not.toHaveBeenCalled();
  await expect(fs.stat(target)).rejects.toMatchObject({ code: 'ENOENT' });
  expect(store.snapshot().jobCleanup?.[id]?.state).toBe('complete');
  await cleanup.reconcile(id);
});
it('unknown legacy paths are never automatically removed', async () => {
  const { cleanup, root } = await fixture(); const other = '33333333-3333-4333-8333-333333333333';
  const target = path.join(root, 'private', 'jobs', other); await fs.mkdir(target);
  await cleanup.reconcile(other); expect((await fs.stat(target)).isDirectory()).toBe(true);
});
it('does not delete while a recorded job is active', async () => {
  const { cleanup, target, store } = await fixture();
  await store.update(state => { (state.jobs ??= {})[id] = { state: 'running' }; });
  await cleanup.reconcile(id); expect((await fs.stat(target)).isDirectory()).toBe(true);
});
it.each(['network', 'instance', 'job', 'protocol', 'not-quiescent'])('preserves readable files and durable retry state on %s failure', async kind => {
  const { cleanup, target, store } = await fixture(); await cleanup.markWorkerAttempt(id, instance);
  vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
    if (kind === 'network') throw new Error('synthetic network failure');
    return new Response(JSON.stringify({ jobId: kind === 'job' ? 'other' : id,
      workerInstanceId: kind === 'instance' ? 'other' : instance,
      cleanupProtocol: kind === 'protocol' ? 2 : 1, quiescent: kind !== 'not-quiescent' }));
  });
  await expect(cleanup.reconcile(id)).rejects.toThrow();
  expect((await fs.stat(target)).isDirectory()).toBe(true);
  expect(store.snapshot().jobCleanup?.[id]?.state).toBe('blocked');
});
it('restart retries a failed worker acknowledgement and leaves captures and Kubo untouched', async () => {
  const { cleanup, root, file, target, auth, store } = await fixture(); await cleanup.markWorkerAttempt(id, instance);
  const capture = path.join(root, 'private', 'captures'); await fs.mkdir(capture); await fs.writeFile(path.join(capture, 'keep'), 'source');
  const fetch = vi.spyOn(globalThis, 'fetch').mockRejectedValueOnce(new Error('offline'));
  await expect(cleanup.reconcile(id)).rejects.toThrow();
  const recovered = new LocalStore(file); await recovered.load();
  fetch.mockImplementation(async (_url, init) => {
    expect(JSON.parse(String(init?.body))).toEqual({ jobId: id, type: 'spatial.reconstruct', workerInstanceId: instance });
    expect(init?.headers).toMatchObject({ 'X-Kubus-Worker-Authorization': 'synthetic-token' });
    return new Response(JSON.stringify({ jobId: id, workerInstanceId: instance, cleanupProtocol: 1, quiescent: true }));
  });
  await new JobCleanup(recovered, root, auth, 'http://worker.invalid').reconcile(id);
  await expect(fs.stat(target)).rejects.toMatchObject({ code: 'ENOENT' });
  expect(await fs.readFile(path.join(capture, 'keep'), 'utf8')).toBe('source');
  expect(recovered.snapshot().jobCleanup?.[id]?.state).toBe('complete');
  expect(store.snapshot().spatial).toEqual({});
});
it('refuses a directory junction to an unrelated owner', async () => {
  const { cleanup, target, root } = await fixture(); const outside = path.join(root, 'unrelated'); await fs.mkdir(outside);
  await fs.writeFile(path.join(outside, 'keep'), 'synthetic'); await fs.rm(target, { recursive: true });
  await fs.symlink(outside, target, process.platform === 'win32' ? 'junction' : 'dir');
  await expect(cleanup.reconcile(id)).rejects.toThrow('cleanup_path_not_owned');
  expect(await fs.readFile(path.join(outside, 'keep'), 'utf8')).toBe('synthetic');
});
it('retries failed filesystem removal without falsely completing retention', async () => {
  const { cleanup, target, store } = await fixture(); const rm = vi.spyOn(fs, 'rm').mockRejectedValueOnce(new Error('locked'));
  await expect(cleanup.reconcile(id)).rejects.toThrow('locked');
  expect(store.snapshot().jobCleanup?.[id]?.state).toBe('blocked'); rm.mockRestore();
  await cleanup.reconcile(id); await expect(fs.stat(target)).rejects.toMatchObject({ code: 'ENOENT' });
});
