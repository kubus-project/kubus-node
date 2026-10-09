import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CapabilityRegistry } from '../src/capabilities/registry.js';
import { CaptureStore } from '../src/captures/captureStore.js';
import { JobRuntime, type JobType, type LocalJob } from '../src/jobs/jobRuntime.js';
import { MIN_VIEWS_FOR_RECONSTRUCTION } from '../src/spatial/nerfstudioAdapter.js';
import { SpatialRecords, summarizeDerivatives } from '../src/spatial/spatialRecords.js';
import type { SpatialManifest } from '../src/spatial/models.js';
import { LocalStore } from '../src/state/localStore.js';

/**
 * The reconstruct -> master -> preview -> runtime pipeline in JobRuntime, run
 * against a stateful fake worker (it really writes the files a worker would)
 * and a content-addressed in-memory Kubo. The behaviours under test are the
 * ones the design promises: the master is durable before any derivative is
 * attempted, a derivative never costs the master, a crash resumes without
 * training again, a derivative is retryable by scene id, and scratch space is
 * always reclaimed.
 */

const MASTER = Buffer.alloc(2000, 0x4d);
const PREVIEW = Buffer.alloc(300, 0x50);
const RAD = [
  { name: 'scene.rad', bytes: Buffer.concat([Buffer.from('RAD0'), Buffer.alloc(60, 1)]) },
  { name: 'scene-0.radc', bytes: Buffer.alloc(500, 2) },
  { name: 'scene-1.radc', bytes: Buffer.alloc(300, 3) },
];
const ALL_CAPABILITIES = ['spatial.reconstruct', 'spatial.generate_preview', 'spatial.optimize'];

const sha = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex').slice(0, 44);

class MemoryKubo {
  readonly blobs = new Map<string, Buffer>();
  readonly directories = new Map<string, Map<string, string>>();
  readonly events: string[] = [];

  async addBytes(bytes: Uint8Array, name: string) {
    const buffer = Buffer.from(bytes);
    const cid = `Qm${sha(buffer)}`;
    this.blobs.set(cid, buffer);
    this.events.push(`kubo:manifest:${name}`);
    return { Hash: cid };
  }

  async addFileStreamed(filePath: string, name: string) {
    const buffer = await fs.readFile(filePath);
    const cid = `Qm${sha(buffer)}`;
    this.blobs.set(cid, buffer);
    this.events.push(`kubo:file:${name}`);
    return { Hash: cid };
  }

  async addDirectoryStreamed(directory: string, names: string[]) {
    const entries = new Map<string, string>();
    const files = [];
    for (const name of names) {
      const buffer = await fs.readFile(path.join(directory, name));
      const cid = `Qm${sha(buffer)}`;
      this.blobs.set(cid, buffer);
      entries.set(name, cid);
      files.push({ name, cid, sizeBytes: buffer.length });
    }
    const rootCid = `Qm${sha([...entries].map(([name, cid]) => `${name}=${cid}`).sort().join('\n'))}`;
    this.directories.set(rootCid, entries);
    this.events.push(`kubo:dir:${names.length}`);
    return { rootCid, files };
  }

  async listBundle(root: string) {
    return [...(this.directories.get(root)?.keys() ?? [])];
  }

  async catToFile(cid: string, destination: string) {
    const buffer = this.blobs.get(cid);
    if (!buffer) throw new Error(`block not found: ${cid}`);
    await fs.writeFile(destination, buffer);
    this.events.push('kubo:cat-master');
    return buffer.length;
  }
}

interface WorkerCall { type: string; body: { jobId: string; type: string; captureDirectory: string; outputDirectory: string; input: Record<string, unknown> } }
type WorkerHandler = (call: WorkerCall, signal: AbortSignal | undefined) => Promise<Response>;

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

const reconstruction = { engine: 'nerfstudio', method: 'splatfacto', iterations: 15000, outputFormat: 'ply' };

const defaultHandlers: Record<string, WorkerHandler> = {
  'spatial.reconstruct': async ({ body }) => {
    await fs.writeFile(path.join(body.outputDirectory, 'result.ply'), MASTER);
    return json({
      variants: [{ role: 'spatial_archive', path: 'result.ply', mimeType: 'application/octet-stream', format: 'ply', storageClass: 'cold' }],
      processing: { protocol: 'kubus.spatial-job/1', workerVersion: 'kubus-spatial-worker/2', reconstruction },
    });
  },
  'spatial.generate_preview': async ({ body }) => {
    await fs.writeFile(path.join(body.outputDirectory, 'preview.spz'), PREVIEW);
    return json({
      variants: [{ role: 'spatial_preview', path: 'preview.spz', mimeType: 'application/octet-stream', format: 'spz' }],
      derivative: { tool: 'spz', toolVersion: '3.0.0', sourceSplats: 200, splats: 100, sourceBytes: MASTER.length, bytes: PREVIEW.length, durationMs: 5, settings: { version: 3 } },
    });
  },
  'spatial.optimize': async ({ body }) => {
    const dir = path.join(body.outputDirectory, 'runtime');
    await fs.mkdir(dir, { recursive: true });
    for (const file of RAD) await fs.writeFile(path.join(dir, file.name), file.bytes);
    return json({
      variants: [{ role: 'spatial_mobile', bundle: { directory: 'runtime', entrypoint: 'scene.rad', files: RAD.map((file) => file.name) }, mimeType: 'application/octet-stream', format: 'rad' }],
      derivative: { tool: 'build-lod', toolVersion: 'f22236f95fdd', sourceSplats: 200, splats: 200, sourceBytes: MASTER.length, bytes: 860, durationMs: 9, settings: { chunked: true } },
    });
  },
};

const dirs: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(dirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

function validCaptureFiles(): Array<{ path: string; contentBase64: string }> {
  const frames = Array.from({ length: MIN_VIEWS_FOR_RECONSTRUCTION }, (_, index) => ({
    index, rgbPath: `rgb/${String(index).padStart(5, '0')}.jpg`, poseTranslation: [index * 0.1, 0, 0], poseRotation: [0, 0, 0, 1],
    intrinsics: { width: 1920, height: 1080, fx: 1400.5, fy: 1400.5, cx: 960, cy: 540 }, timestampNanos: 1000 + index, depthAvailable: false,
  }));
  const jpg = Buffer.from([0xff, 0xd8, 0xff, 0xd9]).toString('base64');
  return [
    ...frames.map((frame) => ({ path: frame.rgbPath, contentBase64: jpg })),
    { path: 'frames.json', contentBase64: Buffer.from(JSON.stringify({ schema: 'kubus.capture.frames/1', frames })).toString('base64') },
  ];
}

interface Rig {
  dir: string;
  store: LocalStore;
  kubo: MemoryKubo;
  records: SpatialRecords;
  jobs: JobRuntime;
  captureId: string;
  calls: WorkerCall[];
  handlers: Record<string, WorkerHandler>;
  workerCapabilities: string[];
  waitFor: (id: string) => Promise<LocalJob>;
  scenes: () => SpatialManifest[];
  workspaces: () => Promise<string[]>;
}

async function rig(options: { autoDerivatives?: boolean; seed?: (r: Pick<Rig, 'store' | 'kubo' | 'records' | 'dir'>) => Promise<void> } = {}): Promise<Rig> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'kubus-derivatives-'));
  dirs.push(dir);
  const store = new LocalStore(path.join(dir, 'state.json'));
  await store.load();
  const captures = new CaptureStore(dir, store);
  const capture = await captures.create({ schema: 'kubus.capture/1', artworkId: 'art-1', capturedAt: new Date().toISOString(), metadata: { intrinsics: true }, files: validCaptureFiles() });
  const kubo = new MemoryKubo();
  const records = new SpatialRecords({ store, kubo: kubo as never });
  const handlers = { ...defaultHandlers };
  const calls: WorkerCall[] = [];
  const state = { workerCapabilities: [...ALL_CAPABILITIES] };

  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (url.endsWith('/health')) return json({ status: 'ready', gpu: { available: true, name: 'RTX 3080 Ti' }, capabilities: state.workerCapabilities });
    if (url.endsWith('/v1/process')) {
      const body = JSON.parse(String(init?.body ?? '{}')) as WorkerCall['body'];
      const call = { type: body.type, body };
      calls.push(call);
      kubo.events.push(`worker:${body.type}`);
      const handler = handlers[body.type];
      if (!handler) return json({ detail: { code: 'worker_failed', message: `no handler for ${body.type}` } }, 500);
      return handler(call, init?.signal ?? undefined);
    }
    throw new Error(`unexpected fetch to ${url}`);
  });

  if (options.seed) await options.seed({ store, kubo, records, dir });

  const capabilities = new CapabilityRegistry({ id: async () => ({ ID: 'peer' }) } as never, 'http://kubus-spatial-worker:8790');
  const jobs = new JobRuntime({
    store, captureStore: captures, kubo: kubo as never, logger: { warn: () => undefined, info: () => undefined } as never,
    dataRoot: dir, concurrency: 1, workerUrl: 'http://kubus-spatial-worker:8790',
    participationGate: { assertUsefulOperation: async () => undefined } as never,
    workerAuth: { issue: async () => 'token' } as never,
    capabilities,
    autoDerivatives: options.autoDerivatives,
  });

  const waitFor = async (id: string): Promise<LocalJob> => {
    const deadline = Date.now() + 8000;
    while (!['completed', 'failed', 'cancelled'].includes(jobs.get(id).state)) {
      if (Date.now() > deadline) throw new Error(`job ${id} did not finish: ${JSON.stringify(jobs.get(id).stage)}`);
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    // A job is *finished* when the runtime has let go of it, not when its state
    // flips: cancel() records "cancelled" at once, while the run that was
    // aborted removes its workspace afterwards, and the state is written before
    // the call that records it returns. Wait for both, so assertions about
    // cleanup and cleanup of the temp directory never race either.
    while (jobs.health().running > 0) {
      if (Date.now() > deadline) throw new Error(`job ${id} never released the runtime`);
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    await store.update(() => undefined);
    return jobs.get(id);
  };

  return {
    dir, store, kubo, records, jobs, captureId: capture.id, calls, handlers,
    get workerCapabilities() { return state.workerCapabilities; },
    set workerCapabilities(value: string[]) { state.workerCapabilities = value; },
    waitFor,
    scenes: () => Object.values(store.snapshot().spatial ?? {}).map((record) => (record as { manifest: SpatialManifest }).manifest),
    workspaces: async () => fs.readdir(path.join(dir, 'private', 'jobs')).catch(() => []),
  };
}

const reconstruct = (r: Rig) => r.jobs.create('spatial.reconstruct', { captureId: r.captureId, artworkId: 'art-1' });
const roles = (manifest: SpatialManifest) => manifest.variants.map((variant) => variant.role);

/** A scene as the previous step of the pipeline leaves it: the master is durable, nothing else exists. */
async function seedMasterOnly({ kubo, records }: Pick<Rig, 'kubo' | 'records'>, id = 'scene-seed'): Promise<{ id: string; masterCid: string }> {
  const added = await kubo.addBytes(MASTER, 'result.ply');
  const manifest: SpatialManifest = {
    schema: 'kubus.spatial/1', type: 'gaussianSplat', id, artworkId: 'art-1', captureId: 'capture-seed',
    captureProvenance: { source: 'localCapture', captureId: 'capture-seed' }, capturedAt: '2026-08-01T00:00:00.000Z',
    variants: [{ role: 'spatial_archive', cid: added.Hash, sizeBytes: MASTER.length, mimeType: 'application/octet-stream', format: 'ply', storageClass: 'cold' }],
    processing: { protocol: 'kubus.spatial-job/1', workerVersion: 'kubus-spatial-worker/2', reconstruction: reconstruction as never },
    createdAt: '2026-08-01T00:05:00.000Z',
  };
  await records.create(manifest);
  kubo.events.length = 0;
  return { id, masterCid: added.Hash };
}

describe('reconstruction with derivatives', () => {
  it('saves the master, then makes the preview, then the runtime bundle, and records how each was made', async () => {
    const r = await rig();
    await r.jobs.start();
    const job = await r.waitFor((await reconstruct(r)).id);

    expect(job.state).toBe('completed');
    expect(r.scenes()).toHaveLength(1);
    const manifest = r.scenes()[0]!;
    expect(roles(manifest)).toEqual(['spatial_preview', 'spatial_mobile', 'spatial_archive']);
    const [preview, runtime, archive] = manifest.variants;
    expect(preview).toMatchObject({ cid: expect.any(String), format: 'spz', storageClass: 'hot', sizeBytes: PREVIEW.length });
    expect(runtime).toMatchObject({ entrypoint: 'scene.rad', fileCount: 3, format: 'rad', storageClass: 'warm', sizeBytes: RAD.reduce((sum, file) => sum + file.bytes.length, 0) });
    expect(runtime!.rootCid).toBeDefined();
    expect(runtime!.cid).toBeUndefined();
    expect(archive).toMatchObject({ format: 'ply', storageClass: 'cold', sizeBytes: MASTER.length });
    expect(manifest.processing.derivatives?.preview).toMatchObject({ tool: 'spz', toolVersion: '3.0.0', sourceSplats: 200, splats: 100, bytes: PREVIEW.length });
    expect(manifest.processing.derivatives?.runtime).toMatchObject({ tool: 'build-lod', toolVersion: 'f22236f95fdd', bytes: runtime!.sizeBytes });
    expect(job.output).toMatchObject({ derivativeSummary: { preview: { state: 'ready' }, runtime: { state: 'ready' } } });
  });

  it('makes the master durable, with a record, before it asks the worker for any derivative', async () => {
    const r = await rig();
    await r.jobs.start();
    await r.waitFor((await reconstruct(r)).id);
    const events = r.kubo.events;
    const masterSaved = events.indexOf('kubo:file:result.ply');
    const recordCreated = events.findIndex((event, index) => index > masterSaved && event.startsWith('kubo:manifest:'));
    const firstDerivative = events.findIndex((event) => event === 'worker:spatial.generate_preview');
    expect(masterSaved).toBeGreaterThan(-1);
    expect(recordCreated).toBeGreaterThan(masterSaved);
    expect(firstDerivative).toBeGreaterThan(recordCreated);
    expect(events.indexOf('worker:spatial.optimize')).toBeGreaterThan(firstDerivative);
  });

  it('asks only for a master when derivatives are switched off', async () => {
    const r = await rig({ autoDerivatives: false });
    await r.jobs.start();
    const job = await r.waitFor((await reconstruct(r)).id);
    expect(job.state).toBe('completed');
    expect(roles(r.scenes()[0]!)).toEqual(['spatial_archive']);
    expect(r.calls.map((call) => call.type)).toEqual(['spatial.reconstruct']);
    expect(job.output).toMatchObject({ derivativeSummary: { preview: { state: 'missing' }, runtime: { state: 'missing' } } });
  });
});

describe('a derivative that fails never costs the master', () => {
  it('keeps the master and the other derivative when the preview fails, and says why', async () => {
    const r = await rig();
    r.handlers['spatial.generate_preview'] = async () => json({ detail: { code: 'spz_failed', message: 'SPZ packing ran out of memory' } }, 500);
    await r.jobs.start();
    const job = await r.waitFor((await reconstruct(r)).id);

    expect(job.state).toBe('completed');
    const manifest = r.scenes()[0]!;
    expect(roles(manifest)).toEqual(['spatial_mobile', 'spatial_archive']);
    const archive = manifest.variants.find((variant) => variant.role === 'spatial_archive')!;
    expect(r.kubo.blobs.get(archive.cid!)?.equals(MASTER)).toBe(true);
    expect(job.output).toMatchObject({ derivativeSummary: { preview: { state: 'failed', error: { code: 'spz_failed', message: 'SPZ packing ran out of memory' } }, runtime: { state: 'ready' } } });
    expect(job.logs.some((entry) => entry.level === 'warn' && entry.message.includes('SPZ packing ran out of memory'))).toBe(true);
  });

  it('keeps the master when both derivatives fail, and the scene is still a complete archive record', async () => {
    const r = await rig();
    r.handlers['spatial.generate_preview'] = async () => json({ detail: { code: 'spz_failed', message: 'no' } }, 500);
    r.handlers['spatial.optimize'] = async () => json({ detail: { code: 'build_lod_failed', message: 'no' } }, 500);
    await r.jobs.start();
    const job = await r.waitFor((await reconstruct(r)).id);
    expect(job.state).toBe('completed');
    expect(roles(r.scenes()[0]!)).toEqual(['spatial_archive']);
    expect(job.output).toMatchObject({ derivativeSummary: { preview: { state: 'failed' }, runtime: { state: 'failed' } } });
    expect(await r.workspaces()).toEqual([]);
  });

  it('records a worker that cannot make derivatives as a clear, retryable condition', async () => {
    const r = await rig();
    r.workerCapabilities = ['spatial.reconstruct'];
    await r.jobs.start();
    const job = await r.waitFor((await reconstruct(r)).id);
    expect(job.state).toBe('completed');
    expect(roles(r.scenes()[0]!)).toEqual(['spatial_archive']);
    expect(job.output).toMatchObject({ derivativeSummary: { preview: { state: 'failed', error: { code: 'worker_cannot_derive' } }, runtime: { state: 'failed', error: { code: 'worker_cannot_derive' } } } });
    expect(r.calls.map((call) => call.type)).toEqual(['spatial.reconstruct']);
  });

  it.each([
    ['a preview file the worker named but never wrote', 'spatial.generate_preview', { variants: [{ role: 'spatial_preview', path: 'ghost.spz', mimeType: 'application/octet-stream', format: 'spz' }], derivative: { tool: 'spz', toolVersion: '3', bytes: 1 } }, 'worker_output_missing'],
    ['a response with no derivative block', 'spatial.generate_preview', { variants: [{ role: 'spatial_preview', path: 'preview.spz', mimeType: 'application/octet-stream', format: 'spz' }] }, 'worker_output_invalid'],
    ['a response with no variants at all', 'spatial.generate_preview', { derivative: { tool: 'spz', toolVersion: '3', bytes: 1 } }, 'worker_output_invalid'],
    ['the wrong representation', 'spatial.generate_preview', { variants: [{ role: 'spatial_archive', path: 'preview.spz', mimeType: 'application/octet-stream', format: 'ply' }], derivative: { tool: 'spz', toolVersion: '3', bytes: 1 } }, 'worker_output_invalid'],
    ['a bundle whose listing omits a chunk it wrote', 'spatial.optimize', { variants: [{ role: 'spatial_mobile', bundle: { directory: 'runtime', entrypoint: 'scene.rad', files: ['scene.rad'] }, mimeType: 'application/octet-stream', format: 'rad' }], derivative: { tool: 'build-lod', toolVersion: 'x', bytes: 1 } }, 'worker_output_invalid'],
    ['a bundle directory that was never written', 'spatial.optimize', { variants: [{ role: 'spatial_mobile', bundle: { directory: 'nowhere', entrypoint: 'scene.rad', files: ['scene.rad'] }, mimeType: 'application/octet-stream', format: 'rad' }], derivative: { tool: 'build-lod', toolVersion: 'x', bytes: 1 } }, 'worker_output_missing'],
  ])('records %s as a failed derivative, not a lost scene', async (_label, type, response, code) => {
    const r = await rig();
    if (type === 'spatial.generate_preview') await fs.writeFile(path.join(r.dir, 'unused'), '');
    r.handlers[type] = async ({ body }) => {
      // Write the honest files first, so only the described problem is wrong.
      await defaultHandlers[type]!({ type, body }, undefined);
      return json(response);
    };
    await r.jobs.start();
    const job = await r.waitFor((await reconstruct(r)).id);
    expect(job.state).toBe('completed');
    const manifest = r.scenes()[0]!;
    expect(roles(manifest)).toContain('spatial_archive');
    const kind = type === 'spatial.generate_preview' ? 'preview' : 'runtime';
    expect(job.output).toMatchObject({ derivativeSummary: { [kind]: { state: 'failed', error: { code } } } });
    expect(roles(manifest)).not.toContain(kind === 'preview' ? 'spatial_preview' : 'spatial_mobile');
  });

  it('propagates the worker\'s own error code and the older {error} shape', async () => {
    const r = await rig();
    r.handlers['spatial.generate_preview'] = async () => json({ error: 'spz_binding_missing' }, 500);
    r.handlers['spatial.optimize'] = async () => json({ detail: 'plain text detail' }, 503);
    await r.jobs.start();
    const job = await r.waitFor((await reconstruct(r)).id);
    expect(job.output).toMatchObject({ derivativeSummary: {
      preview: { state: 'failed', error: { code: 'worker_failed', message: 'spz_binding_missing' } },
      runtime: { state: 'failed', error: { code: 'worker_unsupported', message: 'plain text detail' } },
    } });
  });
});

describe('resuming after an interruption', () => {
  const interrupted = (id: string, spatialId: string | undefined, captureId = 'capture-seed'): LocalJob => ({
    id, type: 'spatial.reconstruct', capability: 'spatial.reconstruction', state: 'running', stage: 'training', progress: null,
    input: { captureId, artworkId: 'art-1' }, ...(spatialId ? { checkpoint: { spatialId } } : {}),
    createdAt: '2026-08-01T00:00:00.000Z', updatedAt: '2026-08-01T00:00:00.000Z', logs: [],
  });

  it('does not train again when the master was already saved: it derives from the preserved master', async () => {
    let masterSeenByWorker: Buffer | undefined;
    const r = await rig({
      seed: async ({ store, kubo, records }) => {
        const { id } = await seedMasterOnly({ kubo, records });
        await store.update((state) => { (state.jobs ??= {})['job-crashed'] = interrupted('job-crashed', id); });
      },
    });
    r.handlers['spatial.generate_preview'] = async (call) => {
      masterSeenByWorker = await fs.readFile(path.join(call.body.outputDirectory, String(call.body.input.master)));
      return defaultHandlers['spatial.generate_preview']!(call, undefined);
    };
    await r.jobs.start();
    const job = await r.waitFor('job-crashed');

    expect(job.state).toBe('completed');
    expect(r.calls.map((call) => call.type)).toEqual(['spatial.generate_preview', 'spatial.optimize']);
    expect(r.scenes()).toHaveLength(1);
    expect(r.scenes()[0]!.id).toBe('scene-seed');
    expect(roles(r.scenes()[0]!)).toEqual(['spatial_preview', 'spatial_mobile', 'spatial_archive']);
    expect(masterSeenByWorker?.equals(MASTER)).toBe(true);
    expect(job.logs.some((entry) => entry.message.includes('Resuming from the preserved master'))).toBe(true);
    expect(job.logs.some((entry) => entry.message === 'Recovered after node restart')).toBe(true);
  });

  it('trains again, once, when the interruption came before any master existed', async () => {
    const r = await rig({
      seed: async ({ store }) => { await store.update((state) => { (state.jobs ??= {})['job-early'] = interrupted('job-early', undefined); }); },
    });
    // The seeded job names a capture that does not exist; give it the real one.
    await r.store.update((state) => { (state.jobs!['job-early'] as LocalJob).input = { captureId: r.captureId, artworkId: 'art-1' }; });
    await r.jobs.start();
    const job = await r.waitFor('job-early');
    expect(job.state).toBe('completed');
    expect(r.calls.filter((call) => call.type === 'spatial.reconstruct')).toHaveLength(1);
    expect(r.scenes()).toHaveLength(1);
  });

  it('forgets a "being made" note left by the crash, so the scene is not reported as busy forever', async () => {
    const r = await rig({
      seed: async ({ store, kubo, records }) => {
        const { id } = await seedMasterOnly({ kubo, records });
        await records.markDerivative(id, 'preview', { state: 'running', jobId: 'job-gone', at: '2026-08-01T00:00:00.000Z' });
        await store.update(() => undefined);
      },
    });
    expect(summarizeDerivatives(r.records.get('scene-seed')).preview.state).toBe('running');
    await r.jobs.start();
    expect(summarizeDerivatives(r.records.get('scene-seed')).preview.state).toBe('missing');
  });
});

describe('retrying a derivative by scene id', () => {
  it('makes the missing preview from the preserved master without training', async () => {
    let master: Buffer | undefined;
    const r = await rig({ seed: async ({ kubo, records }) => { await seedMasterOnly({ kubo, records }); } });
    r.handlers['spatial.generate_preview'] = async (call) => {
      master = await fs.readFile(path.join(call.body.outputDirectory, String(call.body.input.master)));
      return defaultHandlers['spatial.generate_preview']!(call, undefined);
    };
    await r.jobs.start();
    const job = await r.waitFor((await r.jobs.create('spatial.generate_preview', { spatialId: 'scene-seed' })).id);

    expect(job.state).toBe('completed');
    expect(r.calls.map((call) => call.type)).toEqual(['spatial.generate_preview']);
    expect(roles(r.scenes()[0]!)).toEqual(['spatial_preview', 'spatial_archive']);
    expect(master?.equals(MASTER)).toBe(true);
    expect(r.kubo.events).toContain('kubo:cat-master');
    expect(r.scenes()).toHaveLength(1);
  });

  it('spatial.optimize makes both derivatives unless told otherwise', async () => {
    const r = await rig({ seed: async ({ kubo, records }) => { await seedMasterOnly({ kubo, records }); } });
    await r.jobs.start();
    const job = await r.waitFor((await r.jobs.create('spatial.optimize', { spatialId: 'scene-seed' })).id);
    expect(job.state).toBe('completed');
    expect(r.calls.map((call) => call.type)).toEqual(['spatial.generate_preview', 'spatial.optimize']);
    expect(roles(r.scenes()[0]!)).toEqual(['spatial_preview', 'spatial_mobile', 'spatial_archive']);
  });

  it('honours an explicit derivative list and skips what already exists', async () => {
    const r = await rig({ seed: async ({ kubo, records }) => { await seedMasterOnly({ kubo, records }); } });
    await r.jobs.start();
    const first = await r.waitFor((await r.jobs.create('spatial.optimize', { spatialId: 'scene-seed', derivatives: ['runtime'] })).id);
    expect(first.state).toBe('completed');
    expect(roles(r.scenes()[0]!)).toEqual(['spatial_mobile', 'spatial_archive']);
    expect(r.calls.map((call) => call.type)).toEqual(['spatial.optimize']);

    r.calls.length = 0;
    const second = await r.waitFor((await r.jobs.create('spatial.optimize', { spatialId: 'scene-seed' })).id);
    expect(second.state).toBe('completed');
    // Only the missing preview is made; the runtime that exists is left alone.
    expect(r.calls.map((call) => call.type)).toEqual(['spatial.generate_preview']);
  });

  it('refuses to start a retry when nothing is missing, unless the caller forces a regeneration', async () => {
    const r = await rig();
    await r.jobs.start();
    const built = await r.waitFor((await reconstruct(r)).id);
    const spatialId = (built.output as { id: string }).id;
    await expect(r.jobs.create('spatial.optimize', { spatialId })).rejects.toMatchObject({ statusCode: 409, code: 'derivatives_already_ready' });

    r.calls.length = 0;
    const forced = await r.waitFor((await r.jobs.create('spatial.optimize', { spatialId, force: true })).id);
    expect(forced.state).toBe('completed');
    expect(r.calls.map((call) => call.type)).toEqual(['spatial.generate_preview', 'spatial.optimize']);
    expect(roles(r.scenes()[0]!)).toEqual(['spatial_preview', 'spatial_mobile', 'spatial_archive']);
  });

  it('clears the earlier failure once the retry succeeds', async () => {
    const r = await rig({ seed: async ({ kubo, records }) => { await seedMasterOnly({ kubo, records }); } });
    await r.records.markDerivative('scene-seed', 'preview', { state: 'failed', jobId: 'old', at: 'x', error: { code: 'spz_failed', message: 'out of memory' } });
    expect(summarizeDerivatives(r.records.get('scene-seed')).preview.state).toBe('failed');
    await r.jobs.start();
    await r.waitFor((await r.jobs.create('spatial.generate_preview', { spatialId: 'scene-seed' })).id);
    expect(summarizeDerivatives(r.records.get('scene-seed')).preview).toEqual({ state: 'ready' });
  });

  it('reports a retry that produced nothing as failed, not as a success that did nothing', async () => {
    const r = await rig({ seed: async ({ kubo, records }) => { await seedMasterOnly({ kubo, records }); } });
    r.handlers['spatial.generate_preview'] = async () => json({ detail: { code: 'spz_failed', message: 'still out of memory' } }, 500);
    await r.jobs.start();
    const job = await r.waitFor((await r.jobs.create('spatial.generate_preview', { spatialId: 'scene-seed' })).id);

    expect(job.state).toBe('failed');
    expect(job.error).toEqual({ code: 'spz_failed', message: 'still out of memory' });
    expect(summarizeDerivatives(r.records.get('scene-seed')).preview).toEqual({ state: 'failed', error: { code: 'spz_failed', message: 'still out of memory' } });
    // The master is untouched.
    expect(roles(r.scenes()[0]!)).toEqual(['spatial_archive']);
  });

  it('keeps a retry that made one of two derivatives as a success, with the other\'s reason recorded', async () => {
    const r = await rig({ seed: async ({ kubo, records }) => { await seedMasterOnly({ kubo, records }); } });
    r.handlers['spatial.optimize'] = async () => json({ detail: { code: 'build_lod_failed', message: 'no' } }, 500);
    await r.jobs.start();
    const job = await r.waitFor((await r.jobs.create('spatial.optimize', { spatialId: 'scene-seed' })).id);
    expect(job.state).toBe('completed');
    expect(roles(r.scenes()[0]!)).toEqual(['spatial_preview', 'spatial_archive']);
    expect(summarizeDerivatives(r.records.get('scene-seed')).runtime.state).toBe('failed');
  });

  it('validates what it is asked to retry', async () => {
    const r = await rig({ seed: async ({ kubo, records }) => { await seedMasterOnly({ kubo, records }); } });
    await r.jobs.start();
    await expect(r.jobs.create('spatial.optimize', {})).rejects.toMatchObject({ statusCode: 400, code: 'job_spatial_required' });
    await expect(r.jobs.create('spatial.optimize', { spatialId: 'no-such-scene' })).rejects.toMatchObject({ statusCode: 404, code: 'spatial_not_found' });
    await expect(r.jobs.create('spatial.explode' as JobType, { spatialId: 'scene-seed' })).rejects.toMatchObject({ statusCode: 400, code: 'job_type_unsupported' });
    expect(r.jobs.list()).toHaveLength(0);
  });

  it('will not derive from a scene that has no preserved master', async () => {
    const r = await rig({
      seed: async ({ kubo, records }) => {
        const { id } = await seedMasterOnly({ kubo, records }, 'scene-nomaster');
        // A scene whose only variant is a derivative: deriving "from" it would pass a degraded copy off as the original.
        const stored = records.get(id);
        const manifest = structuredClone(stored.manifest);
        manifest.variants = [{ role: 'spatial_preview', cid: 'QmPreviewOnly', sizeBytes: 1, mimeType: 'application/octet-stream', format: 'spz', storageClass: 'hot' }];
        await records.create({ ...manifest, id: 'scene-nomaster2' });
      },
    });
    await r.jobs.start();
    await expect(r.jobs.create('spatial.optimize', { spatialId: 'scene-nomaster2' })).rejects.toMatchObject({ statusCode: 422, code: 'master_unavailable' });
  });

  it('answers a second request for a scene with the job already in flight instead of starting another', async () => {
    const r = await rig({ seed: async ({ kubo, records }) => { await seedMasterOnly({ kubo, records }); } });
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    r.handlers['spatial.generate_preview'] = async (call) => { await gate; return defaultHandlers['spatial.generate_preview']!(call, undefined); };
    await r.jobs.start();
    const first = await r.jobs.create('spatial.generate_preview', { spatialId: 'scene-seed' });
    const second = await r.jobs.create('spatial.optimize', { spatialId: 'scene-seed' });
    expect(second.id).toBe(first.id);
    release();
    await r.waitFor(first.id);
    expect(r.jobs.list()).toHaveLength(1);
  });

  it('cannot be asked to retrain: a derivative job never reaches the reconstruction step', async () => {
    const r = await rig({ seed: async ({ kubo, records }) => { await seedMasterOnly({ kubo, records }); } });
    await r.jobs.start();
    await r.waitFor((await r.jobs.create('spatial.optimize', { spatialId: 'scene-seed', captureId: r.captureId })).id);
    expect(r.calls.some((call) => call.type === 'spatial.reconstruct')).toBe(false);
  });
});

describe('cancelling', () => {
  it('stops a derivative in flight, keeps the master, and does not leave the scene reported as busy', async () => {
    const r = await rig({ seed: async ({ kubo, records }) => { await seedMasterOnly({ kubo, records }); } });
    let started: () => void = () => undefined;
    const reachedWorker = new Promise<void>((resolve) => { started = resolve; });
    r.handlers['spatial.generate_preview'] = (_call, signal) => new Promise<Response>((_resolve, reject) => {
      started();
      signal?.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
    });
    await r.jobs.start();
    const job = await r.jobs.create('spatial.generate_preview', { spatialId: 'scene-seed' });
    await reachedWorker;
    expect(summarizeDerivatives(r.records.get('scene-seed')).preview.state).toBe('running');

    await r.jobs.cancel(job.id);
    const finished = await r.waitFor(job.id);
    expect(finished.state).toBe('cancelled');
    expect(roles(r.scenes()[0]!)).toEqual(['spatial_archive']);
    // A cancelled attempt is not "running", and not a failure either: nothing was learned about the derivative.
    expect(summarizeDerivatives(r.records.get('scene-seed')).preview.state).toBe('missing');
    expect(await r.workspaces()).toEqual([]);
  });

  it('can retry the derivative after cancelling it', async () => {
    const r = await rig({ seed: async ({ kubo, records }) => { await seedMasterOnly({ kubo, records }); } });
    let started: () => void = () => undefined;
    const reachedWorker = new Promise<void>((resolve) => { started = resolve; });
    r.handlers['spatial.generate_preview'] = (_call, signal) => new Promise<Response>((_resolve, reject) => {
      started();
      signal?.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
    });
    await r.jobs.start();
    const job = await r.jobs.create('spatial.generate_preview', { spatialId: 'scene-seed' });
    await reachedWorker;
    await r.jobs.cancel(job.id);
    await r.waitFor(job.id);

    r.handlers['spatial.generate_preview'] = defaultHandlers['spatial.generate_preview']!;
    const retry = await r.waitFor((await r.jobs.create('spatial.generate_preview', { spatialId: 'scene-seed' })).id);
    expect(retry.state).toBe('completed');
    expect(roles(r.scenes()[0]!)).toEqual(['spatial_preview', 'spatial_archive']);
  });
});

describe('scratch space', () => {
  it('is gone after a successful job', async () => {
    const r = await rig();
    await r.jobs.start();
    await r.waitFor((await reconstruct(r)).id);
    expect(await r.workspaces()).toEqual([]);
  });

  it('is gone after a job that failed before it produced anything', async () => {
    const r = await rig();
    r.handlers['spatial.reconstruct'] = async () => json({ detail: { code: 'training_failed', message: 'diverged' } }, 500);
    await r.jobs.start();
    const job = await r.waitFor((await reconstruct(r)).id);
    expect(job.state).toBe('failed');
    expect(job.error).toEqual({ code: 'training_failed', message: 'diverged' });
    expect(r.scenes()).toHaveLength(0);
    expect(await r.workspaces()).toEqual([]);
  });

  it('is gone after a cancelled reconstruction', async () => {
    const r = await rig();
    let started: () => void = () => undefined;
    const reachedWorker = new Promise<void>((resolve) => { started = resolve; });
    r.handlers['spatial.reconstruct'] = (_call, signal) => new Promise<Response>((_resolve, reject) => {
      started();
      signal?.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
    });
    await r.jobs.start();
    const job = await reconstruct(r);
    await reachedWorker;
    await r.jobs.cancel(job.id);
    expect((await r.waitFor(job.id)).state).toBe('cancelled');
    expect(r.scenes()).toHaveLength(0);
    expect(await r.workspaces()).toEqual([]);
  });

  it('is cleared at startup, for jobs that cannot still be running', async () => {
    const r = await rig();
    for (const name of ['stale-a', 'stale-b']) {
      await fs.mkdir(path.join(r.dir, 'private', 'jobs', name, 'dataset'), { recursive: true });
      await fs.writeFile(path.join(r.dir, 'private', 'jobs', name, 'dataset', 'big.bin'), Buffer.alloc(1024));
    }
    expect(await r.workspaces()).toHaveLength(2);
    await r.jobs.start();
    expect(await r.workspaces()).toEqual([]);
  });

  it('never touches a capture, a record or a Kubo object while cleaning up', async () => {
    const r = await rig();
    await r.jobs.start();
    const job = await r.waitFor((await reconstruct(r)).id);
    expect(job.state).toBe('completed');
    expect(r.scenes()).toHaveLength(1);
    const captureDir = path.join(r.dir, 'private');
    expect((await fs.readdir(captureDir)).sort()).toContain('jobs');
    const archive = r.scenes()[0]!.variants.find((variant) => variant.role === 'spatial_archive')!;
    expect(r.kubo.blobs.get(archive.cid!)?.equals(MASTER)).toBe(true);
  });
});
