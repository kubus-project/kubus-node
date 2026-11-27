import { afterEach, expect, it, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { LocalStore } from '../src/state/localStore.js';
import { JobCleanup } from '../src/jobs/jobCleanup.js';
import { JobRuntime } from '../src/jobs/jobRuntime.js';
const id = '11111111-1111-4111-8111-111111111111';
const instance = '22222222-2222-4222-8222-222222222222';
const roots: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true }); });
async function fixture({owned = true, attempted = true, jobState = 'running'} = {}) {
 const root = await fs.mkdtemp(path.join(os.tmpdir(), 'kubus-recovery-')); roots.push(root);
 const file = path.join(root, 'state.json'); const store = new LocalStore(file); await store.load();
 const auth = { issue: async () => 'synthetic' } as never;
 await store.update(state => { (state.jobs ??= {})[id] = { id, type: 'spatial.reconstruct', state: jobState,
   stage: 'training', logs: [], input: { captureId: 'synthetic' }, createdAt: new Date().toISOString() }; });
 if (owned) { const cleanup = new JobCleanup(store, root, auth, 'http://worker.invalid'); await cleanup.own(id, 'spatial.reconstruct'); if (attempted) await cleanup.markWorkerAttempt(id, instance); }
 const target = path.join(root, 'private', 'jobs', id); await fs.mkdir(target, { recursive: true }); await fs.writeFile(path.join(target, 'synthetic-readable'), 'private-fixture');
 const recovered = new LocalStore(file); await recovered.load();
 const jobs = new JobRuntime({store: recovered, captureStore: {} as never, kubo: {} as never,
   workerAuth: auth, logger: {warn: () => undefined, info: () => undefined} as never, dataRoot: root, workerUrl: 'http://worker.invalid',
   participationGate: {} as never, concurrency: 1 });
 return {root, target, recovered, jobs};
}
it('restart cancels the original worker attempt and cleans journaled files without resubmitting training', async () => {
 const {jobs, target, recovered} = await fixture();
 const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
   expect(String(url)).toMatch(/\/v1\/jobs\/cancel$/); expect(JSON.parse(String(init?.body)).workerInstanceId).toBe(instance);
   return new Response(JSON.stringify({jobId: id, workerInstanceId: instance, cleanupProtocol: 1, quiescent: true}));
 });
 await jobs.start(); expect(jobs.get(id)).toMatchObject({state: 'failed', error: {code: 'interrupted_requires_retry'}});
 expect(fetch).toHaveBeenCalledTimes(1); expect(recovered.snapshot().jobCleanup?.[id]?.state).toBe('complete');
 await expect(fs.stat(target)).rejects.toMatchObject({code: 'ENOENT'});
});
it('restart after partial dataset creation but before worker submission needs no worker acknowledgement', async () => {
 const {jobs, target} = await fixture({attempted: false, jobState: 'queued'}); const fetch = vi.spyOn(globalThis, 'fetch');
 await jobs.start(); expect(jobs.get(id).state).toBe('failed'); expect(fetch).not.toHaveBeenCalled();
 await expect(fs.stat(target)).rejects.toMatchObject({code: 'ENOENT'});
});
it('changed worker instance preserves files and blocks new processing until review', async () => {
 const {jobs, target} = await fixture();
 vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({jobId: id, workerInstanceId: 'different-instance', cleanupProtocol: 1, quiescent: true})));
 await jobs.start(); expect((await fs.stat(target)).isDirectory()).toBe(true);
 expect(jobs.health()).toMatchObject({cleanupBlocked: 1});
 await expect(jobs.create('spatial.reconstruct', {captureId: 'synthetic'})).rejects.toMatchObject({code: 'worker_cleanup_pending'});
});
it('legacy directories without ownership evidence remain untouched after interrupted jobs are marked failed', async () => {
 const {jobs, target} = await fixture({owned: false}); const fetch = vi.spyOn(globalThis, 'fetch');
 await jobs.start(); expect(jobs.get(id).state).toBe('failed'); expect(fetch).not.toHaveBeenCalled();
 expect((await fs.stat(target)).isDirectory()).toBe(true);
});
it('start removes face-review copies that no record needs (a crash between the copy and the record)', async () => {
 const {jobs, root} = await fixture({owned: false, jobState: 'completed'});
 const orphan = path.join(root, 'private', 'face-review', instance); await fs.mkdir(orphan, {recursive: true}); await fs.writeFile(path.join(orphan, 'photos-00001.jpg'), 'masked');
 // Left by a process that died long ago (a folder touched in the last minutes may be another process's work in progress).
 const longAgo = new Date(Date.now() - 20 * 60 * 1000); await fs.utimes(orphan, longAgo, longAgo);
 await jobs.start();
 await expect(fs.stat(orphan)).rejects.toMatchObject({code: 'ENOENT'});
});
it('start leaves a recently written face-review folder alone (the other process may be making that record)', async () => {
 const {jobs, root} = await fixture({owned: false, jobState: 'completed'});
 const fresh = path.join(root, 'private', 'face-review', instance); await fs.mkdir(fresh, {recursive: true}); await fs.writeFile(path.join(fresh, 'photos-00001.jpg'), 'masked');
 await jobs.start();
 expect((await fs.stat(fresh)).isDirectory()).toBe(true);
});

const restartedInstance = '44444444-4444-4444-8444-444444444444';
function workerRestartedMock() {
 return vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
   if (String(url).endsWith('/health')) return new Response(JSON.stringify({status: 'ready', cleanupProtocol: 1, reapsOrphans: true, workerInstanceId: restartedInstance}));
   const body = JSON.parse(String(init?.body));
   if (body.workerInstanceId === instance) return new Response(JSON.stringify({detail: 'worker_instance_changed'}), {status: 409});
   return new Response(JSON.stringify({jobId: id, workerInstanceId: restartedInstance, cleanupProtocol: 1, quiescent: true}));
 });
}
it('worker killed mid-job and restarted with a new id: restart cleans the work directory, journals worker_restarted and accepts new jobs', async () => {
 const {jobs, target, recovered} = await fixture();
 workerRestartedMock();
 await jobs.start();
 expect(jobs.get(id)).toMatchObject({state: 'failed', error: {code: 'interrupted_requires_retry'}});
 expect(recovered.snapshot().jobCleanup?.[id]).toMatchObject({state: 'complete', removed: true, reason: 'worker_restarted'});
 await expect(fs.stat(target)).rejects.toMatchObject({code: 'ENOENT'});
 expect(jobs.health()).toMatchObject({cleanupBlocked: 0});
 // Past the cleanup gate: the stub capture store is what refuses now, not worker_cleanup_pending.
 const probe = Object.assign(new Error('probe'), {code: 'capture_probe'});
 (jobs as unknown as {deps: {captureStore: unknown}}).deps.captureStore = {get: () => { throw probe; }};
 await expect(jobs.create('spatial.reconstruct', {captureId: 'synthetic'})).rejects.toMatchObject({code: 'capture_probe'});
});
it('worker unreachable after a crash keeps the work directory and still refuses new jobs', async () => {
 const {jobs, target} = await fixture();
 vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('ECONNREFUSED'));
 await jobs.start();
 expect((await fs.stat(target)).isDirectory()).toBe(true);
 expect(jobs.health()).toMatchObject({cleanupBlocked: 1});
 await expect(jobs.create('spatial.reconstruct', {captureId: 'synthetic'})).rejects.toMatchObject({code: 'worker_cleanup_pending'});
});
it('same worker instance reporting not quiescent keeps the work directory and still refuses new jobs', async () => {
 const {jobs, target} = await fixture();
 vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({detail: 'worker_not_quiescent'}), {status: 503}));
 await jobs.start();
 expect((await fs.stat(target)).isDirectory()).toBe(true);
 await expect(jobs.create('spatial.reconstruct', {captureId: 'synthetic'})).rejects.toMatchObject({code: 'worker_cleanup_pending'});
});

async function settled(done: () => boolean) {
 for (const deadline = Date.now() + 5000; Date.now() < deadline && !done();) await new Promise<void>(resolve => setImmediate(resolve));
 expect(done()).toBe(true);
}
function probeCaptureStore(jobs: JobRuntime) {
 const probe = Object.assign(new Error('probe'), {code: 'capture_probe'});
 (jobs as unknown as {deps: {captureStore: unknown}}).deps.captureStore = {get: () => { throw probe; }};
}
it('a worker that was still restarting when the job failed: the next job request retries cleanup instead of refusing for good', async () => {
 const {jobs, target, recovered} = await fixture();
 vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('ECONNREFUSED'));
 await jobs.start(); jobs.stopCleanupRetry();
 expect(jobs.health()).toMatchObject({cleanupBlocked: 1});
 // The worker is up again, as a new instance.
 workerRestartedMock();
 probeCaptureStore(jobs);
 await expect(jobs.create('spatial.reconstruct', {captureId: 'synthetic'})).rejects.toMatchObject({code: 'capture_probe'});
 expect(recovered.snapshot().jobCleanup?.[id]).toMatchObject({state: 'complete', reason: 'worker_restarted'});
 await expect(fs.stat(target)).rejects.toMatchObject({code: 'ENOENT'});
});
it('a worker that is still down when a job is requested keeps refusing it', async () => {
 const {jobs, target} = await fixture();
 vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('ECONNREFUSED'));
 await jobs.start(); jobs.stopCleanupRetry();
 await expect(jobs.create('spatial.reconstruct', {captureId: 'synthetic'})).rejects.toMatchObject({code: 'worker_cleanup_pending'});
 expect((await fs.stat(target)).isDirectory()).toBe(true);
});
it('blocked cleanup retries by itself on a bounded timer and finishes once the restarted worker answers, with no request needed', async () => {
 const {jobs, target, recovered} = await fixture();
 vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('ECONNREFUSED'));
 vi.useFakeTimers({toFake: ['setTimeout', 'clearTimeout']});
 try {
  await jobs.start();
  expect(jobs.health()).toMatchObject({cleanupBlocked: 1});
  // First retry: the worker is still down, so it stays blocked and the next retry is armed.
  await vi.advanceTimersByTimeAsync(5_000);
  await settled(() => vi.getTimerCount() > 0);
  expect(jobs.health()).toMatchObject({cleanupBlocked: 1});
  workerRestartedMock();
  await vi.advanceTimersByTimeAsync(15_000);
  await settled(() => recovered.snapshot().jobCleanup?.[id]?.state === 'complete');
  expect(recovered.snapshot().jobCleanup?.[id]).toMatchObject({reason: 'worker_restarted', removed: true});
  await expect(fs.stat(target)).rejects.toMatchObject({code: 'ENOENT'});
  // Nothing left blocked: no further retry is armed.
  expect(vi.getTimerCount()).toBe(0);
 } finally { jobs.stopCleanupRetry(); vi.useRealTimers(); }
});
it('a hung worker holds a job request for a few seconds at most, and concurrent requests share the one attempt', async () => {
 const {jobs, target} = await fixture();
 vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('ECONNREFUSED'));
 await jobs.start(); jobs.stopCleanupRetry();
 // From here the worker accepts connections and never answers (the real fetch would wait for its 20 s timeout).
 const hung = vi.spyOn(globalThis, 'fetch').mockImplementation(() => new Promise<Response>(() => undefined));
 hung.mockClear();
 vi.useFakeTimers({toFake: ['setTimeout', 'clearTimeout']});
 try {
  const first = expect(jobs.create('spatial.reconstruct', {captureId: 'synthetic'})).rejects.toMatchObject({code: 'worker_cleanup_pending'});
  const second = expect(jobs.create('spatial.reconstruct', {captureId: 'synthetic'})).rejects.toMatchObject({code: 'worker_cleanup_pending'});
  await vi.advanceTimersByTimeAsync(3_000);
  await Promise.all([first, second]);
  // One cancel in flight for the one blocked record, however many requests arrived.
  expect(hung).toHaveBeenCalledTimes(1);
  expect((await fs.stat(target)).isDirectory()).toBe(true);
 } finally { vi.useRealTimers(); }
});
it('stopCleanupRetry is final: a retry that is already running does not arm another timer when it ends', async () => {
 const {jobs} = await fixture();
 vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('ECONNREFUSED'));
 vi.useFakeTimers({toFake: ['setTimeout', 'clearTimeout']});
 try {
  await jobs.start();
  expect(vi.getTimerCount()).toBe(1);
  let release: (response: Response) => void = () => undefined;
  const inFlight = vi.spyOn(globalThis, 'fetch').mockImplementation(() => new Promise<Response>(resolve => { release = resolve; }));
  inFlight.mockClear();
  await vi.advanceTimersByTimeAsync(5_000);
  await settled(() => inFlight.mock.calls.length === 1);
  jobs.stopCleanupRetry();
  release(new Response(JSON.stringify({detail: 'worker_not_quiescent'}), {status: 503}));
  for (const until = Date.now() + 300; Date.now() < until;) await new Promise<void>(resolve => setImmediate(resolve));
  expect(jobs.health()).toMatchObject({cleanupBlocked: 1});
  expect(vi.getTimerCount()).toBe(0);
 } finally { jobs.stopCleanupRetry(); vi.useRealTimers(); }
});
it('the retry timer gives up after its last attempt and does not run forever', async () => {
 const {jobs} = await fixture();
 const fetch = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('ECONNREFUSED'));
 vi.useFakeTimers({toFake: ['setTimeout', 'clearTimeout']});
 try {
  await jobs.start();
  for (let attempt = 1; attempt <= 6; attempt++) {
   await vi.advanceTimersByTimeAsync(600_000);
   await settled(() => fetch.mock.calls.length >= 1 + attempt && (attempt === 6 || vi.getTimerCount() > 0));
  }
  await vi.advanceTimersByTimeAsync(600_000);
  for (const until = Date.now() + 300; Date.now() < until;) await new Promise<void>(resolve => setImmediate(resolve));
  expect(vi.getTimerCount()).toBe(0);
  // One failed attempt at start plus six scheduled retries.
  expect(fetch).toHaveBeenCalledTimes(7);
 } finally { jobs.stopCleanupRetry(); vi.useRealTimers(); }
});
it('start does not hold startup hostage to a worker that never answers, and job requests wait for that cleanup instead of racing it', async () => {
 const {jobs, target} = await fixture();
 const rejecters: Array<(error: Error) => void> = [];
 const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(() => new Promise<Response>((_resolve, reject) => { rejecters.push(reject); }));
 const startedAt = Date.now();
 await jobs.start();
 // Bounded by the start wait (5 s), not by the 20 s cancel timeout.
 expect(Date.now() - startedAt).toBeLessThan(9000);
 // (Retry timers of earlier tests' runtimes share this spy, so the call count is not asserted.)
 expect(fetch).toHaveBeenCalled();
 expect((await fs.stat(target)).isDirectory()).toBe(true);
 // The cleanup is still in flight: a job request is refused as pending, not started alongside it.
 await expect(jobs.create('spatial.reconstruct', {captureId: 'synthetic'})).rejects.toMatchObject({code: 'worker_cleanup_pending'});
 // When the worker finally fails the attempt, the journal is blocked (and stays retried) rather than lost.
 for (const reject of rejecters) reject(new Error('ECONNREFUSED'));
 jobs.stopCleanupRetry();
 await settled(() => jobs.health().cleanupBlocked === 1);
 expect((await fs.stat(target)).isDirectory()).toBe(true);
}, 30000);
