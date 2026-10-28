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
   workerAuth: auth, logger: {warn: () => undefined} as never, dataRoot: root, workerUrl: 'http://worker.invalid',
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
