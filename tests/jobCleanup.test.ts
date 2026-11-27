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
  expect(store.snapshot().jobCleanup?.[id]).toMatchObject({ state: 'complete', removed: true });
  await cleanup.reconcile(id);
});
it('records that nothing was there to remove when the work directory never existed', async () => {
  const { cleanup, target, store } = await fixture();
  await fs.rm(target, { recursive: true });
  await cleanup.reconcile(id);
  expect(store.snapshot().jobCleanup?.[id]).toMatchObject({ state: 'complete', removed: false });
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

const restarted = '44444444-4444-4444-8444-444444444444';
/** A worker that was restarted: it refuses the recorded instance id, reports a new one, and acknowledges a cancel for it. */
function restartedWorker(options: { health?: () => Response; secondCancel?: (body: Record<string, unknown>) => Response } = {}) {
  const calls: string[] = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
    const address = String(url); calls.push(address.replace('http://worker.invalid', ''));
    if (address.endsWith('/health')) return options.health?.() ?? new Response(JSON.stringify({ status: 'ready', cleanupProtocol: 1, workerInstanceId: restarted }));
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    if (body.workerInstanceId === instance) return new Response(JSON.stringify({ detail: 'worker_instance_changed' }), { status: 409 });
    return options.secondCancel?.(body) ?? new Response(JSON.stringify({ jobId: id, workerInstanceId: restarted, cleanupProtocol: 1, quiescent: true }));
  });
  return calls;
}
it('a worker restarted with a new instance id lets cleanup finish and journals worker_restarted', async () => {
  const { cleanup, target, store } = await fixture(); await cleanup.markWorkerAttempt(id, instance);
  const calls = restartedWorker();
  await cleanup.reconcile(id);
  expect(calls).toEqual(['/v1/jobs/cancel', '/health', '/v1/jobs/cancel']);
  await expect(fs.stat(target)).rejects.toMatchObject({ code: 'ENOENT' });
  expect(store.snapshot().jobCleanup?.[id]).toMatchObject({ state: 'complete', removed: true, reason: 'worker_restarted', replacedWorkerInstanceId: instance });
});
it('a restarted worker whose health cannot be read keeps cleanup blocked', async () => {
  const { cleanup, target, store } = await fixture(); await cleanup.markWorkerAttempt(id, instance);
  restartedWorker({ health: () => new Response('down', { status: 503 }) });
  await expect(cleanup.reconcile(id)).rejects.toThrow('worker_quiescence_unverified');
  expect((await fs.stat(target)).isDirectory()).toBe(true);
  expect(store.snapshot().jobCleanup?.[id]).toMatchObject({ state: 'blocked' });
});
it('an instance-changed answer is not trusted when the worker still reports the recorded instance', async () => {
  const { cleanup, target, store } = await fixture(); await cleanup.markWorkerAttempt(id, instance);
  restartedWorker({ health: () => new Response(JSON.stringify({ status: 'ready', cleanupProtocol: 1, workerInstanceId: instance })) });
  await expect(cleanup.reconcile(id)).rejects.toThrow('worker_quiescence_unverified');
  expect((await fs.stat(target)).isDirectory()).toBe(true);
  expect(store.snapshot().jobCleanup?.[id]?.state).toBe('blocked');
});
it('a restarted worker that will not acknowledge the cancel for its own instance keeps cleanup blocked', async () => {
  const { cleanup, target } = await fixture(); await cleanup.markWorkerAttempt(id, instance);
  restartedWorker({ secondCancel: () => new Response(JSON.stringify({ detail: 'worker_not_quiescent' }), { status: 503 }) });
  await expect(cleanup.reconcile(id)).rejects.toThrow('worker_quiescence_unverified');
  expect((await fs.stat(target)).isDirectory()).toBe(true);
});
it('an unreachable worker (network error on the first cancel) keeps cleanup blocked', async () => {
  const { cleanup, target, store } = await fixture(); await cleanup.markWorkerAttempt(id, instance);
  vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('ECONNREFUSED'));
  await expect(cleanup.reconcile(id)).rejects.toThrow();
  expect((await fs.stat(target)).isDirectory()).toBe(true);
  expect(store.snapshot().jobCleanup?.[id]?.state).toBe('blocked');
});
it('the same instance reporting not quiescent keeps cleanup blocked and never asks for health', async () => {
  const { cleanup, target, store } = await fixture(); await cleanup.markWorkerAttempt(id, instance);
  const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ detail: 'worker_not_quiescent' }), { status: 503 }));
  await expect(cleanup.reconcile(id)).rejects.toThrow('worker_quiescence_unverified');
  expect(fetch).toHaveBeenCalledTimes(1);
  expect((await fs.stat(target)).isDirectory()).toBe(true);
  expect(store.snapshot().jobCleanup?.[id]?.state).toBe('blocked');
});
