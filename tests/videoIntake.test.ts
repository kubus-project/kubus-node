import http from 'node:http';
import { promises as fs } from 'node:fs';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CaptureStore } from '../src/captures/captureStore.js';
import { inspectCapturePackage } from '../src/captures/capturePackage.js';
import { importRoots, resolveImportSource } from '../src/captures/importPaths.js';
import { VIDEO_MAX_SECONDS, VIDEO_MIN_BYTES } from '../src/captures/videoPackage.js';
import { parseImportVideoArguments } from '../src/cli/captureImport.js';
import { JobRuntime } from '../src/jobs/jobRuntime.js';
import { CapabilityRegistry } from '../src/capabilities/registry.js';
import { WORKER_REQUEST_CEILING_MS, WORKER_TOOL_TIMEOUTS_MS, createWorkerAgent, longWorkerFetch, workerFailure } from '../src/spatial/workerClient.js';
import { LocalStore } from '../src/state/localStore.js';
import { syntheticCid } from './fixtures/contentIds.js';

const dirs: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(dirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

async function tempDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'kubus-video-'));
  dirs.push(dir);
  return dir;
}

function box(type: string, payload: Buffer): Buffer {
  const header = Buffer.alloc(8);
  header.writeUInt32BE(8 + payload.length, 0);
  header.write(type, 4, 'latin1');
  return Buffer.concat([header, payload]);
}

/** A structurally valid MP4: ftyp, moov/mvhd stating `durationSeconds`, then padding mdat. No decodable video. */
function fakeMp4(options: { durationSeconds?: number; withMoov?: boolean; padding?: number; version?: 0 | 1 } = {}): Buffer {
  const { durationSeconds = 20, withMoov = true, padding = VIDEO_MIN_BYTES + 4096, version = 0 } = options;
  const ftyp = box('ftyp', Buffer.concat([Buffer.from('isom'), Buffer.alloc(4), Buffer.from('isom')]));
  const timescale = 1000;
  const body = Buffer.alloc(version === 1 ? 112 : 100);
  body.writeUInt8(version, 0);
  if (version === 1) {
    body.writeUInt32BE(timescale, 20);
    body.writeBigUInt64BE(BigInt(Math.round(durationSeconds * timescale)), 24);
  } else {
    body.writeUInt32BE(timescale, 12);
    body.writeUInt32BE(Math.round(durationSeconds * timescale), 16);
  }
  const moov = withMoov ? box('moov', box('mvhd', body)) : Buffer.alloc(0);
  return Buffer.concat([ftyp, box('mdat', Buffer.alloc(padding, 7)), moov]);
}

async function writeVideo(directory: string, name: string, bytes: Buffer): Promise<string> {
  await fs.mkdir(path.join(directory, 'video'), { recursive: true });
  const target = path.join(directory, 'video', name);
  await fs.writeFile(target, bytes);
  return target;
}

describe('video capture package', () => {
  it('accepts one MP4 with a readable header and reports its duration', async () => {
    const dir = await tempDir();
    await writeVideo(dir, 'source.mp4', fakeMp4({ durationSeconds: 21.5 }));
    const report = await inspectCapturePackage(dir);
    expect(report).toMatchObject({ ok: true, kind: 'video', frameCount: 0 });
    expect(report.video).toMatchObject({ extension: 'mp4', path: 'video/source.mp4', durationSeconds: 21.5 });
  });

  it('reads a 64-bit (version 1) movie header', async () => {
    const dir = await tempDir();
    await writeVideo(dir, 'source.mov', fakeMp4({ durationSeconds: 12, version: 1 }));
    const report = await inspectCapturePackage(dir);
    expect(report.ok).toBe(true);
    expect(report.video?.durationSeconds).toBe(12);
  });

  it('refuses a truncated upload that has no movie header', async () => {
    const dir = await tempDir();
    await writeVideo(dir, 'source.mp4', fakeMp4({ withMoov: false }));
    expect(await inspectCapturePackage(dir)).toMatchObject({ ok: false, kind: 'video', code: 'capture_video_unreadable' });
  });

  it('refuses footage shorter or longer than the bounds', async () => {
    const dir = await tempDir();
    await writeVideo(dir, 'source.mp4', fakeMp4({ durationSeconds: 1.2 }));
    expect(await inspectCapturePackage(dir)).toMatchObject({ ok: false, code: 'capture_video_too_short' });
    await writeVideo(dir, 'source.mp4', fakeMp4({ durationSeconds: VIDEO_MAX_SECONDS + 30 }));
    expect(await inspectCapturePackage(dir)).toMatchObject({ ok: false, code: 'capture_video_too_long' });
  });

  it('refuses a file that is too small or not a video container', async () => {
    const dir = await tempDir();
    await writeVideo(dir, 'source.mp4', Buffer.alloc(100, 1));
    expect(await inspectCapturePackage(dir)).toMatchObject({ ok: false, code: 'capture_video_size_invalid' });
    await writeVideo(dir, 'source.mp4', Buffer.alloc(VIDEO_MIN_BYTES + 10, 1));
    expect(await inspectCapturePackage(dir)).toMatchObject({ ok: false, code: 'capture_video_unreadable' });
  });

  it('accepts a WebM/Matroska EBML signature', async () => {
    const dir = await tempDir();
    await writeVideo(dir, 'source.webm', Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3]), Buffer.alloc(VIDEO_MIN_BYTES + 10, 2)]));
    expect(await inspectCapturePackage(dir)).toMatchObject({ ok: true, kind: 'video' });
  });

  it('allows exactly one video per capture', async () => {
    const dir = await tempDir();
    await writeVideo(dir, 'source.mp4', fakeMp4());
    await writeVideo(dir, 'source.mov', fakeMp4());
    expect(await inspectCapturePackage(dir)).toMatchObject({ ok: false, code: 'capture_video_multiple' });
  });

  it('still reports a missing frames.json when there is no video either', async () => {
    const dir = await tempDir();
    await fs.mkdir(path.join(dir, 'rgb'), { recursive: true });
    await fs.writeFile(path.join(dir, 'rgb', '00000.jpg'), Buffer.from([0xff, 0xd8]));
    expect(await inspectCapturePackage(dir)).toMatchObject({ ok: false, code: 'capture_frames_missing' });
  });

  it('commits a streamed video draft as a video capture', async () => {
    const dir = await tempDir();
    const store = new LocalStore(path.join(dir, 'state.json')); await store.load();
    const captures = new CaptureStore(dir, store);
    const draft = await captures.beginDraft({ schema: 'kubus.capture/1', artworkId: 'art-1', capturedAt: new Date().toISOString(), metadata: {} });
    await captures.writeDraftFile(draft.id, 'video/source.mp4', fakeMp4({ durationSeconds: 30 }), 'video/mp4');
    const record = await captures.commitDraft(draft.id);
    expect(record).toMatchObject({ kind: 'video', video: { extension: 'mp4', durationSeconds: 30 } });
    expect((await captures.inspect(record.id)).ok).toBe(true);
  });
});

describe('local video import', () => {
  async function setup() {
    const dir = await tempDir();
    const store = new LocalStore(path.join(dir, 'state.json')); await store.load();
    const captures = new CaptureStore(dir, store);
    const source = path.join(dir, 'clip.mp4');
    await fs.writeFile(source, fakeMp4({ durationSeconds: 25 }));
    return { dir, store, captures, source };
  }

  it('imports a local file past the upload cap path, privately, and is idempotent', async () => {
    const { captures, source, dir } = await setup();
    const first = await captures.importVideoFile(source, { artworkId: 'art-1', markerId: 'marker-1' });
    expect(first).toMatchObject({ kind: 'video', private: true, artworkId: 'art-1', markerId: 'marker-1', state: 'stored' });
    expect(first.directory.startsWith(path.join(dir, 'private', 'captures'))).toBe(true);
    await expect(fs.stat(path.join(first.directory, 'video', 'source.mp4'))).resolves.toBeTruthy();
    const metadata = JSON.parse(await fs.readFile(path.join(first.directory, 'capture.json'), 'utf8'));
    expect(JSON.stringify(metadata)).not.toContain('clip.mp4');
    const again = await captures.importVideoFile(source, { artworkId: 'art-1', markerId: 'marker-1' });
    expect(again.id).toBe(first.id);
    expect(captures.list()).toHaveLength(1);
    const other = await captures.importVideoFile(source, { artworkId: 'art-2' });
    expect(other.id).not.toBe(first.id);
  });

  it('refuses a missing file, a wrong extension and a too-short video without leaving a capture behind', async () => {
    const { captures, dir } = await setup();
    await expect(captures.importVideoFile(path.join(dir, 'nope.mp4'))).rejects.toMatchObject({ code: 'capture_video_source_not_found' });
    const text = path.join(dir, 'clip.txt');
    await fs.writeFile(text, Buffer.alloc(VIDEO_MIN_BYTES + 1));
    await expect(captures.importVideoFile(text)).rejects.toMatchObject({ code: 'capture_video_extension_unsupported' });
    const short = path.join(dir, 'short.mp4');
    await fs.writeFile(short, fakeMp4({ durationSeconds: 1 }));
    await expect(captures.importVideoFile(short)).rejects.toMatchObject({ code: 'capture_video_too_short' });
    expect(captures.list()).toHaveLength(0);
    const leftovers = await fs.readdir(path.join(dir, 'private', 'captures')).catch(() => []);
    expect(leftovers).toEqual([]);
  });

  it('confines the running Node to its import directories', async () => {
    const dir = await tempDir();
    const roots = importRoots(dir, {});
    await fs.mkdir(roots[0]!, { recursive: true });
    const inside = path.join(roots[0]!, 'a.mp4');
    await fs.writeFile(inside, 'x');
    const outside = path.join(dir, 'state.json');
    await fs.writeFile(outside, '{}');
    await expect(resolveImportSource(inside, roots)).resolves.toBe(await fs.realpath(inside));
    await expect(resolveImportSource(outside, roots)).rejects.toMatchObject({ code: 'import_path_not_allowed' });
    await expect(resolveImportSource(path.join(roots[0]!, '..', 'state.json'), roots)).rejects.toMatchObject({ code: 'import_path_not_allowed' });
    await expect(resolveImportSource(path.join(roots[0]!, 'missing.mp4'), roots)).rejects.toMatchObject({ code: 'capture_video_source_not_found' });
    await expect(resolveImportSource('', roots)).rejects.toMatchObject({ code: 'import_path_required' });
    const link = path.join(roots[0]!, 'link.mp4');
    const linked = await fs.symlink(outside, link).then(() => true, () => false);
    if (linked) await expect(resolveImportSource(link, roots)).rejects.toMatchObject({ code: 'import_path_not_allowed' });
  });

  it('parses the command line', () => {
    expect(parseImportVideoArguments(['clip.mp4', '--artwork', 'a1', '--marker', 'm1', '--process']))
      .toEqual({ file: 'clip.mp4', artworkId: 'a1', markerId: 'm1', process: true });
    expect(() => parseImportVideoArguments([])).toThrow(/path is required/);
    expect(() => parseImportVideoArguments(['a.mp4', 'b.mp4'])).toThrow(/Only one video/);
    expect(() => parseImportVideoArguments(['a.mp4', '--artwork'])).toThrow(/needs a value/);
    expect(() => parseImportVideoArguments(['a.mp4', '--bogus'])).toThrow(/Unknown option/);
  });
});

describe('long worker request (N3)', () => {
  async function slowServer(delayMs: number): Promise<{ url: string; close: () => Promise<void> }> {
    const server = http.createServer((_request, response) => {
      setTimeout(() => {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ done: true }));
      }, delayMs);
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;
    return { url: `http://127.0.0.1:${port}/v1/process`, close: () => new Promise((resolve) => { server.closeAllConnections(); server.close(() => resolve()); }) };
  }

  // undici checks timeouts on a coarse (about one second) timer, so the delays here are seconds, not milliseconds.
  it('a bounded headers timeout abandons a slow response (the default 5-minute failure, scaled down)', async () => {
    const server = await slowServer(3000);
    const agent = createWorkerAgent({ headersTimeoutMs: 500 });
    try {
      await expect(longWorkerFetch(server.url, { method: 'POST' }, { agent })).rejects.toMatchObject({ cause: { code: 'UND_ERR_HEADERS_TIMEOUT' } });
    } finally {
      await agent.close();
      await server.close();
    }
  });

  it('the worker agent waits past that bound for the same slow response', async () => {
    const server = await slowServer(3000);
    const agent = createWorkerAgent();
    try {
      const response = await longWorkerFetch(server.url, { method: 'POST' }, { agent });
      expect(await response.json()).toEqual({ done: true });
    } finally {
      await agent.close();
      await server.close();
    }
  });

  it('still honours an abort while waiting', async () => {
    const server = await slowServer(5000);
    const agent = createWorkerAgent();
    const controller = new AbortController();
    try {
      const pending = longWorkerFetch(server.url, { method: 'POST', signal: controller.signal }, { agent });
      setTimeout(() => controller.abort(), 100);
      await expect(pending).rejects.toBeTruthy();
    } finally {
      await agent.close();
      await server.close();
    }
  });

  it('reads FastAPI detail, as a string or as a typed object, not `error`', () => {
    expect(workerFailure({ detail: 'training_config_not_found' }, 500)).toEqual({ code: 'worker_failed', message: 'training_config_not_found' });
    expect(workerFailure({ detail: 'gpu_unsupported' }, 503)).toEqual({ code: 'worker_unsupported', message: 'gpu_unsupported' });
    expect(workerFailure({ error: 'legacy' }, 500)).toEqual({ code: 'worker_failed', message: 'legacy' });
    expect(workerFailure(null, 502)).toEqual({ code: 'worker_failed', message: 'worker_http_502' });
    const typed = workerFailure({ detail: { code: 'sfm_failed', message: 'COLMAP registered 5 of 90 frames', details: { submittedViews: 90, registeredViews: 5, tail: 'secret log text' } } }, 422);
    expect(typed.code).toBe('sfm_failed');
    expect(typed.message).toBe('COLMAP registered 5 of 90 frames (submittedViews=90, registeredViews=5)');
    expect(typed.message).not.toContain('secret log text');
    expect(workerFailure({ detail: { code: 'made_up', message: 'x' } }, 422).code).toBe('worker_failed');
  });
});

describe('worker request ceiling', () => {
  it('sits above the sum of the worker tool timeouts for a video job (30 h)', () => {
    const sum = Object.values(WORKER_TOOL_TIMEOUTS_MS).reduce((total, ms) => total + ms, 0);
    expect(sum).toBe(30 * 60 * 60 * 1000);
    expect(WORKER_REQUEST_CEILING_MS).toBeGreaterThan(sum);
    expect(WORKER_REQUEST_CEILING_MS).toBe(31 * 60 * 60 * 1000);
  });
});

describe('video reconstruction job', () => {
  const WORKER_ID = '44444444-4444-4444-8444-444444444444';

  async function runtime(workerHealth: Record<string, unknown>, onProcess: (body: any, init?: RequestInit) => Promise<Response>, options: { framesCapture?: boolean } = {}) {
    const dir = await tempDir();
    const store = new LocalStore(path.join(dir, 'state.json')); await store.load();
    const captures = new CaptureStore(dir, store);
    let capture;
    if (options.framesCapture) {
      const frames = Array.from({ length: 24 }, (_, index) => ({
        index, rgbPath: `rgb/${String(index).padStart(5, '0')}.jpg`, poseTranslation: [index * 0.1, 0, 0], poseRotation: [0, 0, 0, 1],
        intrinsics: { width: 1920, height: 1080, fx: 1400.5, fy: 1400.5, cx: 960, cy: 540 }, timestampNanos: 1000 + index, depthAvailable: false,
      }));
      const jpg = Buffer.from([0xff, 0xd8, 0xff, 0xd9]).toString('base64');
      capture = await captures.create({
        schema: 'kubus.capture/1', artworkId: 'art-1', capturedAt: new Date().toISOString(), metadata: { intrinsics: true },
        files: [
          ...frames.map((frame) => ({ path: frame.rgbPath, contentBase64: jpg })),
          { path: 'frames.json', contentBase64: Buffer.from(JSON.stringify({ schema: 'kubus.capture.frames/1', frames })).toString('base64') },
        ],
      });
    } else {
      const source = path.join(dir, 'clip.mp4');
      await fs.writeFile(source, fakeMp4({ durationSeconds: 25 }));
      capture = await captures.importVideoFile(source, { artworkId: 'art-1', markerId: 'marker-1' });
    }
    const processBodies: any[] = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (url.endsWith('/health')) {
        return new Response(JSON.stringify({ status: 'ready', cleanupProtocol: 1, workerInstanceId: WORKER_ID, gpu: { available: true, name: 'RTX 3080 Ti' }, capabilities: ['spatial.reconstruct'], ...workerHealth }), { status: 200 });
      }
      if (url.endsWith('/v1/jobs/cancel')) {
        const request = JSON.parse(String(init?.body));
        return new Response(JSON.stringify({ ...request, cleanupProtocol: 1, quiescent: true }));
      }
      if (url.endsWith('/v1/process')) {
        const body = JSON.parse(String(init?.body ?? '{}'));
        processBodies.push(body);
        return onProcess(body, init);
      }
      throw new Error(`unexpected fetch to ${url}`);
    });
    const jobs = new JobRuntime({
      store, captureStore: captures,
      kubo: { pinAdd: async () => undefined, pinLs: async () => ({ Keys: {} }), addFileStreamed: async () => ({ Hash: syntheticCid('output') }), addBytes: async () => ({ Hash: syntheticCid('manifest') }) } as never,
      logger: { warn: () => undefined } as never,
      dataRoot: dir, concurrency: 1, workerUrl: 'http://kubus-spatial-worker:8790',
      participationGate: { assertUsefulOperation: async () => undefined } as never,
      workerAuth: { issue: async () => 'token' } as never,
      capabilities: new CapabilityRegistry({ id: async () => ({ ID: 'peer' }) } as never, 'http://kubus-spatial-worker:8790'),
    });
    await jobs.start();
    return { jobs, capture, store, processBodies, dir, captures };
  }

  async function settle(jobs: JobRuntime, id: string): Promise<void> {
    const deadline = Date.now() + 8000;
    while (!['completed', 'failed', 'cancelled'].includes(jobs.get(id).state) || jobs.health().running > 0) {
      if (Date.now() > deadline) throw new Error('job did not settle');
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }

  it('queues a video capture in video mode and hands the capture directory to the worker untouched', async () => {
    const { jobs, capture, processBodies } = await runtime({ inputModes: ['frames', 'video'] }, async () => new Response(JSON.stringify({ detail: { code: 'video_unreadable', message: 'ffprobe could not read the video' } }), { status: 422 }));
    const job = await jobs.create('spatial.reconstruct', { captureId: capture.id, artworkId: 'art-1' });
    expect(job.input.mode).toBe('video');
    await settle(jobs, job.id);
    expect(processBodies[0]).toMatchObject({ captureDirectory: capture.directory, input: { mode: 'video' } });
  });

  it('surfaces each typed worker error to the operator', async () => {
    for (const [code, message] of [
      ['video_unreadable', 'ffprobe could not read the video'],
      ['video_too_short', 'The video is 1.2 s'],
      ['frames_too_blurry', 'The footage is too soft overall'],
      ['sfm_failed', 'COLMAP registered 5 of 90 frames'],
    ] as const) {
      const { jobs, capture } = await runtime({ inputModes: ['video'] }, async () => new Response(JSON.stringify({ detail: { code, message, details: { registeredViews: 5, submittedViews: 90 } } }), { status: 422 }));
      const job = await jobs.create('spatial.reconstruct', { captureId: capture.id });
      await settle(jobs, job.id);
      const failed = jobs.get(job.id);
      expect(failed.state).toBe('failed');
      expect(failed.error?.code).toBe(code);
      expect(failed.error?.message).toContain(message);
    }
  });

  it('refuses a worker that cannot take video before reserving it', async () => {
    const { jobs, capture, processBodies } = await runtime({}, async () => new Response('{}', { status: 200 }));
    const job = await jobs.create('spatial.reconstruct', { captureId: capture.id });
    await settle(jobs, job.id);
    expect(jobs.get(job.id).error?.code).toBe('worker_video_unsupported');
    expect(processBodies).toHaveLength(0);
  });

  it('rejects a mode that disagrees with the capture', async () => {
    const { jobs, capture } = await runtime({ inputModes: ['video'] }, async () => new Response('{}', { status: 200 }));
    await expect(jobs.create('spatial.reconstruct', { captureId: capture.id, mode: 'frames' }))
      .rejects.toMatchObject({ statusCode: 422, code: 'capture_input_mode_mismatch' });
  });

  it('follows the worker stages and imports the splat with its derivation recorded', async () => {
    const stages: string[] = [];
    let jobsRef: JobRuntime | undefined;
    let jobId = '';
    const { jobs, capture, store } = await runtime({ inputModes: ['video'] }, async (body) => {
      const output = body.outputDirectory as string;
      await fs.mkdir(output, { recursive: true });
      const progress = async (stage: string, detail: object) => {
        await fs.writeFile(path.join(output, 'worker-progress.json'), JSON.stringify({ stage, detail }));
        // Poll interval is 2 s; give the watcher a turn without waiting that long by the final poll on stop.
      };
      await progress('extracting_frames', { video: { durationSeconds: 25, width: 1920, height: 1080 } });
      await new Promise((resolve) => setTimeout(resolve, 2300));
      stages.push(jobsRef!.get(jobId).stage);
      await progress('solving_poses', { frames: { extracted: 187, blurDropped: 30, duplicateDropped: 12, selected: 75 } });
      await new Promise((resolve) => setTimeout(resolve, 2300));
      stages.push(jobsRef!.get(jobId).stage);
      await progress('training', { iterations: 1000 });
      await fs.writeFile(path.join(output, 'result.ply'), Buffer.alloc(2048, 3));
      return new Response(JSON.stringify({
        variants: [{ role: 'spatial_archive', path: 'result.ply', mimeType: 'application/octet-stream', format: 'ply', storageClass: 'cold' }],
        processing: { protocol: 'kubus.spatial-job/1', workerVersion: 'kubus-spatial-worker/3', reconstruction: { engine: 'nerfstudio', method: 'splatfacto', iterations: 1000, outputFormat: 'ply' } },
        provenance: { kind: 'video', frames: { selected: 75 }, sfm: { tool: 'colmap', submittedViews: 75, registeredViews: 70, registrationRatio: 0.933 }, splatCount: 123456, injected: 'ignored' },
      }), { status: 200 });
    });
    jobsRef = jobs;
    const job = await jobs.create('spatial.reconstruct', { captureId: capture.id, artworkId: 'art-1', markerId: 'marker-1' });
    jobId = job.id;
    await settle(jobs, job.id);
    const done = jobs.get(job.id);
    expect(done.error).toBeUndefined();
    expect(done.state).toBe('completed');
    expect(stages).toEqual(['extracting_frames', 'solving_poses']);
    const messages = done.logs.map((entry) => entry.message).join('\n');
    expect(messages).toContain('Extracting and filtering frames from the video (25.0 s, 1920x1080)');
    expect(messages).toContain('Solving camera poses (COLMAP): 187 extracted, 30 blurry dropped, 12 near-duplicate dropped, 75 kept');
    expect(messages).toContain('COLMAP registered 70 of 75 views; 123456 splats');
    const record = Object.values(store.snapshot().spatial ?? {})[0] as { manifest: { captureProvenance: Record<string, any> } };
    expect(record.manifest.captureProvenance.derivation).toMatchObject({ kind: 'video', splatCount: 123456, sfm: { registeredViews: 70 } });
    expect(record.manifest.captureProvenance.derivation.injected).toBeUndefined();
  }, 20000);

  it('logs the training stage once for a posed-frame job even when the worker reports it too', async () => {
    const { jobs, capture } = await runtime({ inputModes: ['frames'] }, async (body) => {
      const output = body.outputDirectory as string;
      await fs.mkdir(output, { recursive: true });
      await fs.writeFile(path.join(output, 'worker-progress.json'), JSON.stringify({ stage: 'training', detail: { iterations: 1000 } }));
      // One watcher poll (2 s) elapses while the request is open.
      await new Promise((resolve) => setTimeout(resolve, 2300));
      return new Response(JSON.stringify({ detail: { code: 'sfm_failed', message: 'stop here' } }), { status: 422 });
    }, { framesCapture: true });
    const job = await jobs.create('spatial.reconstruct', { captureId: capture.id, artworkId: 'art-1' });
    await settle(jobs, job.id);
    const training = jobs.get(job.id).logs.filter((entry) => entry.message.startsWith('Training'));
    expect(training).toHaveLength(1);
  }, 20000);
});
