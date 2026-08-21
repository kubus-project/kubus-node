import { afterEach, describe, expect, it, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CaptureStore } from '../src/captures/captureStore.js';
import { JobRuntime } from '../src/jobs/jobRuntime.js';
import { CapabilityRegistry } from '../src/capabilities/registry.js';
import { validateSpatialManifest } from '../src/spatial/models.js';
import { LocalStore } from '../src/state/localStore.js';
import { MIN_VIEWS_FOR_RECONSTRUCTION } from '../src/spatial/nerfstudioAdapter.js';
import { AnalyticsStore } from '../src/analytics/analyticsStore.js';

const dirs: string[] = [];

/** A minimal but adapter-valid kubus.capture/1 file set: enough posed, intrinsics-complete frames to clear the reconstruction floor. */
function validCaptureFiles(): Array<{ path: string; contentBase64: string }> {
  const frames = Array.from({ length: MIN_VIEWS_FOR_RECONSTRUCTION }, (_, index) => ({
    index,
    rgbPath: `rgb/${String(index).padStart(5, '0')}.jpg`,
    poseTranslation: [index * 0.1, 0, 0],
    poseRotation: [0, 0, 0, 1],
    intrinsics: { width: 1920, height: 1080, fx: 1400.5, fy: 1400.5, cx: 960, cy: 540 },
    timestampNanos: 1000 + index,
    depthAvailable: false,
  }));
  const jpgBytes = Buffer.from([0xff, 0xd8, 0xff, 0xd9]).toString('base64');
  return [
    ...frames.map((f) => ({ path: f.rgbPath, contentBase64: jpgBytes })),
    {
      path: 'frames.json',
      contentBase64: Buffer.from(JSON.stringify({ schema: 'kubus.capture.frames/1', frames })).toString('base64'),
    },
  ];
}
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(dirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

const TERMINAL_STATES = new Set(['completed', 'failed', 'cancelled']);

/** Waits for the job's async dispatch (including its state-file writes) to fully settle, rather than a fixed sleep that can race directory cleanup. */
async function waitForTerminal(jobs: { get: (id: string) => { state: string } }, jobId: string, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!TERMINAL_STATES.has(jobs.get(jobId).state)) {
    if (Date.now() > deadline) throw new Error(`job ${jobId} did not reach a terminal state within ${timeoutMs}ms`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  // The state flips to terminal inside the same store.update() call that
  // performs the write; give the microtask queue one more turn so that call
  // has fully returned before the test (and its afterEach cleanup) proceeds.
  await new Promise((resolve) => setTimeout(resolve, 5));
}

describe('private spatial runtime', () => {
  it('stores raw captures as private local records and fails jobs cleanly without a worker', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'kubus-spatial-')); dirs.push(dir);
    const store = new LocalStore(path.join(dir, 'state.json')); await store.load();
    const captures = new CaptureStore(dir, store);
    const capture = await captures.create({ schema: 'kubus.capture/1', artworkId: 'art-1', capturedAt: new Date().toISOString(), metadata: { intrinsics: true }, files: [{ path: 'frames/0001.jpg', contentBase64: Buffer.from('frame').toString('base64') }] });
    expect(capture.private).toBe(true);
    expect(store.snapshot().desiredCids).toEqual([]);
    const jobs = new JobRuntime({ store, captureStore: captures, kubo: {} as never, logger: { warn: () => undefined } as never, dataRoot: dir, concurrency: 1,
      participationGate: { assertUsefulOperation: async () => undefined } as never,
      workerAuth: { issue: async () => 'token' } as never,
    });
    await jobs.start();
    const job = await jobs.create('spatial.reconstruct', { captureId: capture.id, artworkId: 'art-1' });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(jobs.get(job.id).state).toBe('failed');
    expect(jobs.get(job.id).error?.code).toBe('worker_unavailable');
  });

  it('rejects dispatch against a configured worker the shared registry knows is unreachable, without a raw fetch attempt', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'kubus-spatial-')); dirs.push(dir);
    const store = new LocalStore(path.join(dir, 'state.json')); await store.load();
    const captures = new CaptureStore(dir, store);
    const capture = await captures.create({ schema: 'kubus.capture/1', artworkId: 'art-1', capturedAt: new Date().toISOString(), metadata: { intrinsics: true }, files: [{ path: 'frames/0001.jpg', contentBase64: Buffer.from('frame').toString('base64') }] });

    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation((input) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (url.endsWith('/health')) return Promise.reject(new Error('connect ECONNREFUSED'));
      throw new Error(`unexpected fetch to ${url}`);
    });
    const capabilities = new CapabilityRegistry({ id: async () => ({ ID: 'peer' }) } as never, 'http://kubus-spatial-worker:8790');

    const jobs = new JobRuntime({
      store, captureStore: captures, kubo: {} as never, logger: { warn: () => undefined } as never,
      dataRoot: dir, concurrency: 1, workerUrl: 'http://kubus-spatial-worker:8790',
      participationGate: { assertUsefulOperation: async () => undefined } as never,
      workerAuth: { issue: async () => 'token' } as never,
      capabilities,
    });
    await jobs.start();
    const job = await jobs.create('spatial.reconstruct', { captureId: capture.id, artworkId: 'art-1' });
    await waitForTerminal(jobs, job.id);

    expect(jobs.get(job.id).state).toBe('failed');
    expect(jobs.get(job.id).error?.code).toBe('worker_unavailable');
    expect(fetchSpy.mock.calls.every(([input]) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      return url.endsWith('/health');
    })).toBe(true);
  });

  it('dispatches to the worker once the shared registry confirms it is ready, instead of rejecting a stale-unavailable cache', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'kubus-spatial-')); dirs.push(dir);
    const store = new LocalStore(path.join(dir, 'state.json')); await store.load();
    const captures = new CaptureStore(dir, store);
    const capture = await captures.create({ schema: 'kubus.capture/1', artworkId: 'art-1', capturedAt: new Date().toISOString(), metadata: { intrinsics: true }, files: validCaptureFiles() });

    vi.spyOn(globalThis, 'fetch').mockImplementation((input) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (url.endsWith('/health')) {
        return Promise.resolve(new Response(JSON.stringify({
          status: 'ready', gpu: { available: true, name: 'RTX 3080 Ti' }, capabilities: ['spatial.reconstruct'],
        }), { status: 200 }));
      }
      if (url.endsWith('/v1/process')) {
        // A worker attempt was actually made — the eligibility check did not
        // reject this job against a stale cache.
        return Promise.resolve(new Response(JSON.stringify({ error: 'training_backend_unreachable' }), { status: 503 }));
      }
      throw new Error(`unexpected fetch to ${url}`);
    });
    const capabilities = new CapabilityRegistry({ id: async () => ({ ID: 'peer' }) } as never, 'http://kubus-spatial-worker:8790');

    const jobs = new JobRuntime({
      store, captureStore: captures, kubo: {} as never, logger: { warn: () => undefined } as never,
      dataRoot: dir, concurrency: 1, workerUrl: 'http://kubus-spatial-worker:8790',
      participationGate: { assertUsefulOperation: async () => undefined } as never,
      workerAuth: { issue: async () => 'token' } as never,
      capabilities,
    });
    await jobs.start();
    const job = await jobs.create('spatial.reconstruct', { captureId: capture.id, artworkId: 'art-1' });
    await waitForTerminal(jobs, job.id);

    // Failed via the worker's own response, not the pre-flight eligibility gate.
    expect(jobs.get(job.id).state).toBe('failed');
    expect(jobs.get(job.id).error?.code).toBe('worker_unsupported');
  });

  it('records started/completed processing analytics for a real successful job', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'kubus-spatial-')); dirs.push(dir);
    const store = new LocalStore(path.join(dir, 'state.json')); await store.load();
    const captures = new CaptureStore(dir, store);
    const capture = await captures.create({ schema: 'kubus.capture/1', artworkId: 'art-1', capturedAt: new Date().toISOString(), metadata: { intrinsics: true }, files: validCaptureFiles() });
    const analytics = new AnalyticsStore(path.join(dir, 'analytics.json'));
    await analytics.load();

    let outputDirectory = '';
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (url.endsWith('/health')) {
        return new Response(JSON.stringify({ status: 'ready', gpu: { available: true, name: 'RTX 3080 Ti' }, capabilities: ['spatial.reconstruct'] }), { status: 200 });
      }
      if (url.endsWith('/v1/process')) {
        const body = JSON.parse(String(init?.body ?? '{}'));
        outputDirectory = body.outputDirectory;
        await fs.mkdir(outputDirectory, { recursive: true });
        await fs.writeFile(path.join(outputDirectory, 'result.ply'), Buffer.alloc(1234, 1));
        return new Response(JSON.stringify({
          variants: [{ role: 'spatial_archive', path: 'result.ply', mimeType: 'application/octet-stream', format: 'ply', storageClass: 'cold' }],
          processing: { protocol: 'kubus.spatial-job/1', workerVersion: 'kubus-spatial-worker/1', reconstruction: { engine: 'nerfstudio', method: 'splatfacto', iterations: 1000, outputFormat: 'ply' } },
        }), { status: 200 });
      }
      throw new Error(`unexpected fetch to ${url}`);
    });
    const capabilities = new CapabilityRegistry({ id: async () => ({ ID: 'peer' }) } as never, 'http://kubus-spatial-worker:8790');

    const jobs = new JobRuntime({
      store, captureStore: captures,
      kubo: { addFileStreamed: async () => ({ Hash: 'bafyOutputCid' }), addBytes: async () => ({ Hash: 'bafyManifestCid' }) } as never,
      logger: { warn: () => undefined } as never,
      dataRoot: dir, concurrency: 1, workerUrl: 'http://kubus-spatial-worker:8790',
      participationGate: { assertUsefulOperation: async () => undefined } as never,
      workerAuth: { issue: async () => 'token' } as never,
      capabilities,
      analytics,
    });
    await jobs.start();
    const job = await jobs.create('spatial.reconstruct', { captureId: capture.id, artworkId: 'art-1' });
    await waitForTerminal(jobs, job.id);

    expect(jobs.get(job.id).state).toBe('completed');
    const buckets = analytics.query('24h');
    expect(buckets).toHaveLength(1);
    expect(buckets[0]!.processing.started).toBe(1);
    expect(buckets[0]!.processing.completed).toBe(1);
    expect(buckets[0]!.processing.totalInputBytes).toBe(capture.sizeBytes);
    expect(buckets[0]!.processing.totalOutputBytes).toBe(1234);
    expect(buckets[0]!.processing.totalDurationMs).toBeGreaterThanOrEqual(0);
  });

  it('validates the versioned renderer-neutral spatial manifest', () => {
    expect(validateSpatialManifest({ schema: 'kubus.spatial/1', type: 'gaussianSplat', id: 's1', artworkId: 'a1', captureId: 'c1', captureProvenance: { source: 'localCapture', captureId: 'c1' }, capturedAt: '2026-08-10T00:00:00Z', createdAt: '2026-08-10T00:00:00Z', variants: [{ role: 'spatial_mobile', cid: 'cid', sizeBytes: 1, mimeType: 'application/octet-stream', format: 'spz', storageClass: 'warm' }], processing: { protocol: 'kubus.spatial-job/1', workerVersion: 'kubus-spatial-worker/1', reconstruction: { engine: 'nerfstudio', method: 'splatfacto', iterations: 15000, outputFormat: 'spz' } } }).schema).toBe('kubus.spatial/1');
  });
});
