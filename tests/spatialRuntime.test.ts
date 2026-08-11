import { afterEach, describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CaptureStore } from '../src/captures/captureStore.js';
import { JobRuntime } from '../src/jobs/jobRuntime.js';
import { validateSpatialManifest } from '../src/spatial/models.js';
import { LocalStore } from '../src/state/localStore.js';

const dirs: string[] = [];
afterEach(async () => Promise.all(dirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true }))));

describe('private spatial runtime', () => {
  it('stores raw captures as private local records and fails jobs cleanly without a worker', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'kubus-spatial-')); dirs.push(dir);
    const store = new LocalStore(path.join(dir, 'state.json')); await store.load();
    const captures = new CaptureStore(dir, store);
    const capture = await captures.create({ schema: 'kubus.capture/1', artworkId: 'art-1', capturedAt: new Date().toISOString(), metadata: { intrinsics: true }, files: [{ path: 'frames/0001.jpg', contentBase64: Buffer.from('frame').toString('base64') }] });
    expect(capture.private).toBe(true);
    expect(store.snapshot().desiredCids).toEqual([]);
    const jobs = new JobRuntime({ store, captureStore: captures, kubo: {} as never, logger: { warn: () => undefined } as never, dataRoot: dir, concurrency: 1 });
    await jobs.start();
    const job = await jobs.create('spatial.reconstruct', { captureId: capture.id, artworkId: 'art-1' });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(jobs.get(job.id).state).toBe('failed');
    expect(jobs.get(job.id).error?.code).toBe('worker_unavailable');
  });

  it('validates the versioned renderer-neutral spatial manifest', () => {
    expect(validateSpatialManifest({ schema: 'kubus.spatial/1', type: 'gaussianSplat', id: 's1', artworkId: 'a1', captureId: 'c1', captureProvenance: { source: 'localCapture', captureId: 'c1' }, capturedAt: '2026-08-10T00:00:00Z', createdAt: '2026-08-10T00:00:00Z', variants: [{ role: 'spatial_mobile', cid: 'cid', sizeBytes: 1, mimeType: 'application/octet-stream', format: 'spz', storageClass: 'warm' }] }).schema).toBe('kubus.spatial/1');
  });
});
