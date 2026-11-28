import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CaptureStore, copyVerified } from '../src/captures/captureStore.js';
import { PINNED_WEIGHTS_SHA256 } from '../src/captures/faceMasking.js';
import { inspectCapturePackage } from '../src/captures/capturePackage.js';
import { importRoots, resolveImportSource } from '../src/captures/importPaths.js';
import { PHOTO_MAX_COUNT, PHOTO_MIN_BYTES, PHOTO_MIN_COUNT, inspectPhotoPackage, listPhotoSources } from '../src/captures/photoPackage.js';
import { VIDEO_MIN_BYTES } from '../src/captures/videoPackage.js';
import { parseAddVideoArguments, parseImportPhotosArguments, parseImportVideoArguments, parseProcessArguments } from '../src/cli/captureImport.js';
import { CapabilityRegistry } from '../src/capabilities/registry.js';
import { JobRuntime } from '../src/jobs/jobRuntime.js';
import { validateSpatialManifest } from '../src/spatial/models.js';
import { workerFailure } from '../src/spatial/workerClient.js';
import { spatialViewerBootstrapJs } from '../src/gui/templates/spatialViewer.js';
import { spatialViewerBundle } from '../src/gui/public/vendor/spatialViewerBundle.js';
import { LocalStore } from '../src/state/localStore.js';
import { syntheticCid } from './fixtures/contentIds.js';

const dirs: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(dirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

async function tempDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'kubus-photos-'));
  dirs.push(dir);
  return dir;
}

/** A structurally valid JPEG header (optionally with an EXIF orientation) padded to `size`; no decodable pixels. */
function jpeg(options: { width?: number; height?: number; orientation?: number; truncated?: boolean; size?: number } = {}): Buffer {
  const { width = 1600, height = 1200, orientation, truncated = false, size = PHOTO_MIN_BYTES + 2048 } = options;
  const parts: Buffer[] = [Buffer.from([0xff, 0xd8])];
  if (orientation) {
    const tiff = Buffer.alloc(26);
    tiff.write('II', 0, 'latin1');
    tiff.writeUInt16LE(42, 2);
    tiff.writeUInt32LE(8, 4);
    tiff.writeUInt16LE(1, 8);
    tiff.writeUInt16LE(0x0112, 10);
    tiff.writeUInt16LE(3, 12);
    tiff.writeUInt32LE(1, 14);
    tiff.writeUInt16LE(orientation, 18);
    const body = Buffer.concat([Buffer.from('Exif\0\0', 'latin1'), tiff]);
    const segment = Buffer.from([0xff, 0xe1, 0, 0]);
    segment.writeUInt16BE(body.length + 2, 2);
    parts.push(segment, body);
  }
  const padding = Buffer.alloc(Math.min(size, 60_000), 0x20);
  const comment = Buffer.from([0xff, 0xfe, 0, 0]);
  comment.writeUInt16BE(padding.length + 2, 2);
  parts.push(comment, padding);
  const frame = Buffer.alloc(19);
  frame[0] = 0xff; frame[1] = 0xc0; frame.writeUInt16BE(17, 2); frame[4] = 8;
  frame.writeUInt16BE(height, 5); frame.writeUInt16BE(width, 7); frame[9] = 3;
  frame.set([1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1], 10);
  parts.push(frame, Buffer.alloc(64, 0x11));
  if (!truncated) parts.push(Buffer.from([0xff, 0xd9]));
  return Buffer.concat(parts);
}

function png(width = 1600, height = 1200): Buffer {
  const header = Buffer.alloc(8 + 8 + 13 + 4);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(header, 0);
  header.writeUInt32BE(13, 8);
  header.write('IHDR', 12, 'latin1');
  header.writeUInt32BE(width, 16);
  header.writeUInt32BE(height, 20);
  const iend = Buffer.concat([Buffer.alloc(4), Buffer.from('IEND', 'latin1'), Buffer.alloc(4)]);
  return Buffer.concat([header, Buffer.alloc(PHOTO_MIN_BYTES, 1), iend]);
}

function box(type: string, payload: Buffer): Buffer {
  const header = Buffer.alloc(8);
  header.writeUInt32BE(8 + payload.length, 0);
  header.write(type, 4, 'latin1');
  return Buffer.concat([header, payload]);
}

function fakeMp4(durationSeconds = 25): Buffer {
  const ftyp = box('ftyp', Buffer.concat([Buffer.from('isom'), Buffer.alloc(4), Buffer.from('isom')]));
  const body = Buffer.alloc(100);
  body.writeUInt32BE(1000, 12);
  body.writeUInt32BE(durationSeconds * 1000, 16);
  return Buffer.concat([ftyp, box('mdat', Buffer.alloc(VIDEO_MIN_BYTES + 4096, 7)), box('moov', box('mvhd', body))]);
}

async function writePhotos(directory: string, count: number, make: (index: number) => Buffer = (index) => jpeg({ orientation: index % 2 ? 6 : undefined }), prefix = 'IMG_'): Promise<void> {
  await fs.mkdir(directory, { recursive: true });
  for (let index = 0; index < count; index += 1) await fs.writeFile(path.join(directory, `${prefix}${index + 1}.jpg`), make(index));
}

async function captureWithPhotos(count: number, make?: (index: number) => Buffer): Promise<string> {
  const dir = await tempDir();
  await writePhotos(path.join(dir, 'photos'), count, make);
  return dir;
}

describe('photo capture package', () => {
  it('accepts a photo set and reports counts, formats and EXIF-oriented photos', async () => {
    const dir = await captureWithPhotos(10, (index) => (index === 0 ? png() : jpeg({ orientation: index % 3 === 0 ? 6 : 1 })));
    await fs.rename(path.join(dir, 'photos', 'IMG_1.jpg'), path.join(dir, 'photos', 'IMG_1.png'));
    const result = await inspectPhotoPackage(dir);
    expect(result.ok).toBe(true);
    expect(result.photos).toMatchObject({ count: 10, formats: { png: 1, jpg: 9 }, minLongSide: 1600, maxLongSide: 1600, exifOrientedCount: 3 });
    await expect(inspectCapturePackage(dir)).resolves.toMatchObject({ ok: true, kind: 'photos', photos: { count: 10 } });
  });

  it('refuses too few and too many photos', async () => {
    await expect(inspectPhotoPackage(await captureWithPhotos(PHOTO_MIN_COUNT - 1))).resolves.toMatchObject({ ok: false, code: 'capture_photos_too_few' });
    const many = await captureWithPhotos(PHOTO_MAX_COUNT + 1, () => Buffer.alloc(1)); // the count is checked before any file is read
    await expect(inspectPhotoPackage(many)).resolves.toMatchObject({ ok: false, code: 'capture_photos_too_many' });
  });

  it('refuses a file that is not the image its extension says, a truncated one, a tiny one and an oversized one', async () => {
    const wrongFormat = await captureWithPhotos(10, (index) => (index === 4 ? png() : jpeg()));
    await expect(inspectPhotoPackage(wrongFormat)).resolves.toMatchObject({ ok: false, code: 'capture_photo_invalid' });
    const truncated = await captureWithPhotos(10, (index) => jpeg({ truncated: index === 3 }));
    await expect(inspectPhotoPackage(truncated)).resolves.toMatchObject({ ok: false, code: 'capture_photo_invalid', message: expect.stringContaining('truncated') });
    const small = await captureWithPhotos(10, (index) => jpeg({ width: index === 2 ? 320 : 1600, height: index === 2 ? 240 : 1200 }));
    await expect(inspectPhotoPackage(small)).resolves.toMatchObject({ ok: false, code: 'capture_photo_invalid' });
    const bomb = await captureWithPhotos(10, (index) => jpeg({ width: index === 2 ? 19_000 : 1600, height: index === 2 ? 19_000 : 1200 }));
    await expect(inspectPhotoPackage(bomb)).resolves.toMatchObject({ ok: false, code: 'capture_photo_invalid' });
    const tiny = await captureWithPhotos(10, (index) => (index === 1 ? jpeg({ size: 0 }) : jpeg()));
    await expect(inspectPhotoPackage(tiny)).resolves.toMatchObject({ ok: false, code: 'capture_photo_size_invalid' });
    const garbage = await captureWithPhotos(10, (index) => (index === 6 ? Buffer.alloc(PHOTO_MIN_BYTES + 10, 9) : jpeg()));
    await expect(inspectPhotoPackage(garbage)).resolves.toMatchObject({ ok: false, code: 'capture_photo_invalid' });
  });

  it('refuses a symbolic link and ignores sub-directories and non-image files', async () => {
    const dir = await captureWithPhotos(10);
    await fs.mkdir(path.join(dir, 'photos', 'nested'));
    await fs.writeFile(path.join(dir, 'photos', 'nested', 'IMG_99.jpg'), jpeg());
    await fs.writeFile(path.join(dir, 'photos', 'notes.txt'), 'x');
    expect(await listPhotoSources(dir)).toHaveLength(10);
    const outside = path.join(await tempDir(), 'secret.jpg');
    await fs.writeFile(outside, jpeg());
    const linked = await fs.symlink(outside, path.join(dir, 'photos', 'IMG_100.jpg')).then(() => true, () => false);
    if (linked) await expect(inspectPhotoPackage(dir)).resolves.toMatchObject({ ok: false, code: 'capture_photo_invalid', message: expect.stringContaining('symbolic link') });
  });

  it('recognises mixed and video-only packages and lets frames.json win', async () => {
    const dir = await captureWithPhotos(10);
    await fs.mkdir(path.join(dir, 'video'));
    await fs.writeFile(path.join(dir, 'video', 'source.mp4'), fakeMp4());
    await expect(inspectCapturePackage(dir)).resolves.toMatchObject({ ok: true, kind: 'mixed', photos: { count: 10 }, video: { extension: 'mp4' } });
    // A mixed capture with bad photos names the photo problem; with a bad video, the video problem.
    const short = await captureWithPhotos(10);
    await fs.mkdir(path.join(short, 'video'));
    await fs.writeFile(path.join(short, 'video', 'source.mp4'), fakeMp4(1));
    await expect(inspectCapturePackage(short)).resolves.toMatchObject({ ok: false, code: 'capture_video_too_short', kind: 'mixed' });
    await fs.writeFile(path.join(dir, 'frames.json'), JSON.stringify({ schema: 'kubus.capture.frames/1', frames: [] }));
    await expect(inspectCapturePackage(dir)).resolves.toMatchObject({ ok: false, code: 'capture_frames_invalid' });
  });
});

describe('local photo import', () => {
  async function setup(count = 12) {
    const dir = await tempDir();
    const store = new LocalStore(path.join(dir, 'state.json')); await store.load();
    const captures = new CaptureStore(dir, store);
    const source = path.join(dir, 'drop', 'Mural');
    await writePhotos(source, count, (index) => jpeg({ orientation: index % 2 ? 6 : undefined, size: 20_000 + index }), 'Mural-');
    return { dir, store, captures, source };
  }

  it('imports a directory privately under constant names, keeps no original file name, and is idempotent', async () => {
    const { captures, source, dir } = await setup();
    await fs.writeFile(path.join(source, 'Thumbs.db'), 'x');
    const first = await captures.importPhotoDirectory(source, { artworkId: 'art-1', markerId: 'marker-1', capturedAt: '2026-08-17T06:00:00Z', capturedBy: 'unconfirmed' });
    expect(first).toMatchObject({ kind: 'photos', private: true, artworkId: 'art-1', markerId: 'marker-1', capturedAt: '2026-08-17T06:00:00.000Z', capturedBy: 'unconfirmed', skippedFiles: 1 });
    expect(first.photos).toMatchObject({ count: 12, exifOrientedCount: 6 });
    expect(first.directory.startsWith(path.join(dir, 'private', 'captures'))).toBe(true);
    const names = (await fs.readdir(path.join(first.directory, 'photos'))).sort();
    expect(names[0]).toBe('00001.jpg');
    expect(names).toHaveLength(12);
    const metadata = JSON.stringify(JSON.parse(await fs.readFile(path.join(first.directory, 'capture.json'), 'utf8')));
    expect(metadata).not.toContain('Mural');
    expect(metadata).not.toContain('Thumbs');
    const again = await captures.importPhotoDirectory(source, { artworkId: 'art-1', markerId: 'marker-1' });
    expect(again.id).toBe(first.id);
    expect(captures.list()).toHaveLength(1);
    expect((await captures.importPhotoDirectory(source, { artworkId: 'art-2' })).id).not.toBe(first.id);
  });

  it('refuses a missing directory, too few photos, a bad photo and a link, leaving no capture behind', async () => {
    const { captures, dir, source } = await setup(12);
    await expect(captures.importPhotoDirectory(path.join(dir, 'nope'))).rejects.toMatchObject({ code: 'capture_photo_source_not_found' });
    await expect(captures.importPhotoDirectory(path.join(dir, 'drop', 'Mural', 'Mural-1.jpg'))).rejects.toMatchObject({ code: 'capture_photo_source_not_found' });
    const few = path.join(dir, 'drop', 'few');
    await writePhotos(few, 3);
    await expect(captures.importPhotoDirectory(few)).rejects.toMatchObject({ code: 'capture_photos_too_few' });
    await fs.writeFile(path.join(source, 'Mural-3.jpg'), Buffer.alloc(PHOTO_MIN_BYTES + 5, 4));
    await expect(captures.importPhotoDirectory(source)).rejects.toMatchObject({ code: 'capture_photo_invalid' });
    const linkDir = path.join(dir, 'drop', 'linked');
    await writePhotos(linkDir, 10);
    const linked = await fs.symlink(path.join(source, 'Mural-1.jpg'), path.join(linkDir, 'IMG_50.jpg')).then(() => true, () => false);
    if (linked) await expect(captures.importPhotoDirectory(linkDir)).rejects.toMatchObject({ code: 'capture_photo_invalid' });
    expect(captures.list()).toHaveLength(0);
    expect(await fs.readdir(path.join(dir, 'private', 'captures')).catch(() => [])).toEqual([]);
  });

  it('imports photos and a video together as one mixed capture dated by the earliest medium', async () => {
    const { captures, dir, source } = await setup();
    const video = path.join(dir, 'drop', 'clip.mp4');
    await fs.writeFile(video, fakeMp4());
    const record = await captures.importPhotoDirectory(source, { artworkId: 'art-1', capturedAt: '2026-08-17T06:00:00Z', videoPath: video, videoCapturedAt: '2026-11-30T10:00:00Z' });
    expect(record).toMatchObject({ kind: 'mixed', video: { extension: 'mp4' }, photos: { count: 12 }, capturedAt: '2026-08-17T06:00:00.000Z' });
    expect(record.mediaCapturedAt).toEqual({ photos: '2026-08-17T06:00:00.000Z', video: '2026-11-30T10:00:00.000Z' });
    expect(record.derivedFrom).toBeUndefined();
  });

  it('adds a later video to a photo capture as a NEW mixed capture and keeps the photo capture untouched', async () => {
    const { captures, dir, source } = await setup();
    const base = await captures.importPhotoDirectory(source, { artworkId: 'art-1', markerId: 'marker-1', capturedAt: '2026-08-17T06:00:00Z', capturedBy: 'unconfirmed' });
    const before = JSON.stringify((await fs.readdir(path.join(base.directory, 'photos'))).sort());
    const video = path.join(dir, 'drop', 'later.mp4');
    await fs.writeFile(video, fakeMp4());
    const mixed = await captures.addVideoToCapture(base.id, video, { capturedAt: '2026-12-02T09:00:00Z' });
    expect(mixed.id).not.toBe(base.id);
    expect(mixed).toMatchObject({ kind: 'mixed', artworkId: 'art-1', markerId: 'marker-1', capturedBy: 'unconfirmed', derivedFrom: { captureId: base.id }, photos: { count: 12 }, video: { extension: 'mp4' } });
    expect(mixed.capturedAt).toBe('2026-08-17T06:00:00.000Z');
    expect(mixed.mediaCapturedAt).toEqual({ photos: '2026-08-17T06:00:00.000Z', video: '2026-12-02T09:00:00.000Z' });
    expect(await fs.readdir(path.join(mixed.directory, 'photos'))).toHaveLength(12);
    // The base capture is kept exactly as it was and still processable.
    expect(JSON.stringify((await fs.readdir(path.join(base.directory, 'photos'))).sort())).toBe(before);
    expect(captures.get(base.id)).toMatchObject({ kind: 'photos' });
    expect((await captures.inspect(base.id)).ok).toBe(true);
    expect((await captures.addVideoToCapture(base.id, video, { capturedAt: '2026-12-02T09:00:00Z' })).id).toBe(mixed.id);
    // Only a photo capture can be extended, and only with a readable video.
    await expect(captures.addVideoToCapture(mixed.id, video)).rejects.toMatchObject({ code: 'capture_extension_invalid' });
    await expect(captures.addVideoToCapture(base.id, path.join(dir, 'missing.mp4'))).rejects.toMatchObject({ code: 'capture_video_source_not_found' });
    await expect(captures.addVideoToCapture('nope', video)).rejects.toMatchObject({ statusCode: 404 });
    expect(captures.list()).toHaveLength(2);
  });

  it('stores a source file only when the bytes copied are the bytes that were hashed', async () => {
    const dir = await tempDir();
    const file = path.join(dir, 'a.jpg');
    await fs.writeFile(file, Buffer.from('first version'));
    const hashed = (await import('node:crypto')).createHash('sha256').update('first version').digest('hex');
    const good = copyVerified(file, hashed);
    for await (const chunk of good.chunks) void chunk;
    expect(() => good.verify()).not.toThrow();
    // The file changed after it was hashed (the report vouched for the earlier bytes).
    await fs.writeFile(file, Buffer.from('second version'));
    const changed = copyVerified(file, hashed);
    for await (const chunk of changed.chunks) void chunk;
    try { changed.verify(); throw new Error('verify should have thrown'); } catch (error) { expect(error).toMatchObject({ code: 'capture_source_changed' }); }
    // A copy that did not read to the end is not a verified copy either.
    const partial = copyVerified(file, hashed);
    expect(() => partial.verify()).toThrow();
  });

  it('confines a directory import to the import roots', async () => {
    const dir = await tempDir();
    const roots = importRoots(dir, {});
    const inside = path.join(roots[0]!, 'mural');
    await writePhotos(inside, 8);
    await expect(resolveImportSource(inside, roots)).resolves.toBe(await fs.realpath(inside));
    await expect(resolveImportSource(dir, roots)).rejects.toMatchObject({ code: 'import_path_not_allowed' });
    await expect(resolveImportSource(path.join(inside, '..', '..'), roots)).rejects.toMatchObject({ code: 'import_path_not_allowed' });
  });

  it('does not name the Node filesystem in the refusal of an import path', async () => {
    const dir = await tempDir();
    const roots = importRoots(dir, {});
    await fs.mkdir(roots[0]!, { recursive: true });
    const refused = await resolveImportSource(dir, roots).catch((error) => error);
    const missing = await resolveImportSource(path.join(dir, 'nowhere'), roots).catch((error) => error);
    for (const error of [refused, missing]) {
      expect(JSON.stringify({ message: error.message, details: error.details })).not.toContain(dir);
      expect(error.details).not.toHaveProperty('importRoots');
    }
    expect(refused.details.message).toContain('KUBUS_IMPORT_DIRS');
  });

  it('parses the command lines', () => {
    expect(parseImportPhotosArguments(['/p', '--artwork', 'a', '--marker', 'm', '--captured-at', '2026-08-17T06:00:00Z', '--captured-by', 'x', '--video', 'v.mp4', '--process', '--floater-crop']))
      .toEqual({ directory: '/p', artworkId: 'a', markerId: 'm', capturedAt: '2026-08-17T06:00:00Z', capturedBy: 'x', videoFile: 'v.mp4', process: true, floaterCrop: true });
    expect(() => parseImportPhotosArguments([])).toThrow(/directory path is required/);
    expect(() => parseImportPhotosArguments(['a', 'b'])).toThrow(/Only one photo directory/);
    expect(() => parseImportPhotosArguments(['a', '--bogus'])).toThrow(/Unknown option/);
    expect(() => parseImportPhotosArguments(['a', '--artwork'])).toThrow(/needs a value/);
    expect(parseAddVideoArguments(['cap-1', 'v.mp4', '--process'])).toEqual({ captureId: 'cap-1', file: 'v.mp4', process: true });
    expect(() => parseAddVideoArguments(['cap-1'])).toThrow(/capture id and a video/);
    expect(parseProcessArguments(['cap-1', '--previous', 'sp-1', '--floater-crop'])).toEqual({ captureId: 'cap-1', previousSpatialId: 'sp-1', floaterCrop: true });
    expect(() => parseProcessArguments([])).toThrow(/Exactly one capture id/);
    expect(parseImportVideoArguments(['v.mp4', '--floater-crop'])).toMatchObject({ floaterCrop: true });
  });
});

describe('photo reconstruction job and spatial revisions', () => {
  const WORKER_ID = '55555555-5555-4555-8555-555555555555';
  const MATRIX = [0.5, 0, 0, 0, 0, 0, -0.5, 0, 0, 0.5, 0, 0, 1, 2, 3, 1];

  /** What the worker reports for the parts it was asked to mask. */
  const maskingReport = (requested: { photos?: boolean; video?: boolean }) => {
    const part = (images: number) => ({ ran: true, images, regions: 3, imagesWithRegions: 2, regionsPerImage: Array.from({ length: images }, (_, index) => (index < 3 ? 1 : 0)), detector: 'YuNet', model: 'face_detection_yunet_2023mar', weightsSha256: PINNED_WEIGHTS_SHA256 });
    return { ...(requested.photos ? { photos: part(12) } : {}), ...(requested.video ? { video: part(48) } : {}) };
  };

  const processing = { protocol: 'kubus.spatial-job/1', workerVersion: 'kubus-spatial-worker/5', reconstruction: { engine: 'nerfstudio', method: 'splatfacto', iterations: 1000, outputFormat: 'ply' } };

  async function setup(inputModes: string[], onProcess?: (body: any) => Promise<Response>) {
    const dir = await tempDir();
    const store = new LocalStore(path.join(dir, 'state.json')); await store.load();
    const captures = new CaptureStore(dir, store);
    const source = path.join(dir, 'drop', 'mural');
    await writePhotos(source, 12);
    const photos = await captures.importPhotoDirectory(source, { artworkId: 'art-1', markerId: 'marker-1', capturedAt: '2026-08-17T06:00:00Z' });
    const bodies: any[] = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (url.endsWith('/health')) return new Response(JSON.stringify({ status: 'ready', cleanupProtocol: 1, workerInstanceId: WORKER_ID, gpu: { available: true, name: 'RTX 3080 Ti' }, capabilities: ['spatial.reconstruct'], inputModes, faceMasking: true, faceReviewImages: true }), { status: 200 });
      if (url.endsWith('/v1/jobs/cancel')) return new Response(JSON.stringify({ ...JSON.parse(String(init?.body)), cleanupProtocol: 1, quiescent: true }));
      if (url.endsWith('/v1/process')) {
        const body = JSON.parse(String(init?.body ?? '{}'));
        bodies.push(body);
        if (onProcess) return onProcess(body);
        await fs.mkdir(body.outputDirectory, { recursive: true });
        await fs.writeFile(path.join(body.outputDirectory, 'result.ply'), Buffer.alloc(2048, 3));
        return new Response(JSON.stringify({
          variants: [{ role: 'spatial_archive', path: 'result.ply', mimeType: 'application/octet-stream', format: 'ply', storageClass: 'cold' }],
          transform: { matrix: MATRIX, matrixOrder: 'column-major', up: [0, 0, 1], method: 'camera_up' },
          viewerDefaults: { quality: 'archive' },
          processing: { ...processing, orientation: { method: 'camera_up', confidence: 0.98 }, floaterCrop: { applied: true, splatsBefore: 100, splatsAfter: 90 } },
          provenance: { kind: body.input.mode, ...(body.input.maskFaces ? { faceMasking: maskingReport(body.input.maskFaces) } : {}), photos: { submitted: 12, usable: 12 }, ...(body.input.maskFaces?.video ? { frames: { selected: 48 } } : {}), sfm: { registeredViews: 12, submittedViews: 12 }, splatCount: 90, orientation: { method: 'camera_up' }, crop: { applied: true, splatsBefore: 100, splatsAfter: 90 }, timings: { training: 30 } },
        }), { status: 200 });
      }
      throw new Error(`unexpected fetch to ${url}`);
    });
    let manifestCounter = 0;
    const jobs = new JobRuntime({
      store, captureStore: captures,
      kubo: { pinAdd: async () => undefined, pinLs: async () => ({ Keys: {} }), addFileStreamed: async () => ({ Hash: syntheticCid('output') }), addBytes: async () => ({ Hash: syntheticCid(`manifest-${manifestCounter += 1}`) }) } as never,
      logger: { warn: () => undefined } as never,
      dataRoot: dir, concurrency: 1, workerUrl: 'http://kubus-spatial-worker:8790',
      participationGate: { assertUsefulOperation: async () => undefined } as never,
      workerAuth: { issue: async () => 'token' } as never,
      capabilities: new CapabilityRegistry({ id: async () => ({ ID: 'peer' }) } as never, 'http://kubus-spatial-worker:8790'),
    });
    await jobs.start();
    return { dir, store, captures, jobs, photos, bodies };
  }

  async function settle(jobs: JobRuntime, id: string): Promise<void> {
    const deadline = Date.now() + 8000;
    while (!['completed', 'failed', 'cancelled'].includes(jobs.get(id).state) || jobs.health().running > 0) {
      if (Date.now() > deadline) throw new Error('job did not settle');
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }

  const spatialRecords = (store: LocalStore) => Object.values(store.snapshot().spatial ?? {}) as Array<{ id: string; manifestCid: string; createdAt: string; manifest: any }>;

  it('queues a photo capture in photos mode, starts at the photo stage and hands the capture directory to the worker', async () => {
    const { jobs, photos, bodies } = await setup(['frames', 'photos']);
    const job = await jobs.create('spatial.reconstruct', { captureId: photos.id, artworkId: 'art-1', floaterCrop: true });
    expect(job.input).toMatchObject({ mode: 'photos', floaterCrop: true });
    await settle(jobs, job.id);
    expect(jobs.get(job.id).state).toBe('completed');
    expect(bodies[0]).toMatchObject({ captureDirectory: photos.directory, input: { mode: 'photos', floaterCrop: true } });
    const messages = jobs.get(job.id).logs.map((entry) => entry.message).join('\n');
    expect(messages).toContain('Preparing photos for the worker');
    expect(messages).toContain('orientation by camera_up');
    expect(messages).toContain('floater crop kept 90 of 100 splats');
  });

  it('refuses a worker that cannot take photos before reserving it, and a mode that disagrees with the capture', async () => {
    const { jobs, photos, bodies } = await setup(['frames', 'video']);
    const job = await jobs.create('spatial.reconstruct', { captureId: photos.id });
    await settle(jobs, job.id);
    expect(jobs.get(job.id).error?.code).toBe('worker_photos_unsupported');
    expect(bodies).toHaveLength(0);
    await expect(jobs.create('spatial.reconstruct', { captureId: photos.id, mode: 'video' })).rejects.toMatchObject({ statusCode: 422, code: 'capture_input_mode_mismatch' });
  });

  it('surfaces the typed photo errors to the operator', async () => {
    for (const [code, message] of [['photos_unreadable', 'Only 3 of 12 photos could be decoded'], ['sfm_failed', 'COLMAP registered only 15 of 23 views']] as const) {
      const { jobs, photos } = await setup(['photos'], async () => new Response(JSON.stringify({ detail: { code, message, details: { submittedPhotos: 12, usablePhotos: 3, registeredViews: 15, submittedViews: 23, tail: 'must not leak' } } }), { status: 422 }));
      const job = await jobs.create('spatial.reconstruct', { captureId: photos.id });
      await settle(jobs, job.id);
      const failed = jobs.get(job.id);
      expect(failed.state).toBe('failed');
      expect(failed.error?.code).toBe(code);
      expect(failed.error?.message).toContain(message);
      expect(failed.error?.message).not.toContain('must not leak');
    }
    expect(workerFailure({ detail: { code: 'photos_unreadable', message: 'm', details: { submittedPhotos: 5, usablePhotos: 2 } } }, 422).message).toBe('m (submittedPhotos=5, usablePhotos=2)');
    // The worker's own refusal to run a flagged-image job that could not be reviewed keeps its code.
    expect(workerFailure({ detail: { code: 'face_review_images_unavailable', message: 'm' } }, 500).code).toBe('face_review_images_unavailable');
    expect(workerFailure({ detail: { code: 'output_conversion_failed', message: 'm' } }, 500).code).toBe('output_conversion_failed');
  });

  it('stores the worker transform and orientation in the manifest and numbers the first record 1', async () => {
    const { jobs, photos, store } = await setup(['photos']);
    const job = await jobs.create('spatial.reconstruct', { captureId: photos.id, artworkId: 'art-1' });
    await settle(jobs, job.id);
    const [record] = spatialRecords(store);
    expect(record!.manifest.transform).toMatchObject({ matrix: MATRIX, matrixOrder: 'column-major', up: [0, 0, 1], method: 'camera_up' });
    expect(record!.manifest.processing).toMatchObject({ orientation: { method: 'camera_up' }, floaterCrop: { applied: true, splatsAfter: 90 } });
    expect(record!.manifest.revision).toEqual({ number: 1, reason: 'initial', inputs: { captureKind: 'photos', photos: 12 } });
    expect(record!.manifest.captureProvenance.derivation).toMatchObject({ kind: 'photos', splatCount: 90, orientation: { method: 'camera_up' }, crop: { applied: true }, timings: { training: 30 } });
    expect(record!.manifest.capturedAt).toBe('2026-08-17T06:00:00.000Z');
  });

  it('links a video added later to the earlier record as a new revision and leaves the old record as it was', async () => {
    const { jobs, photos, store, captures, dir } = await setup(['photos', 'mixed']);
    const first = await jobs.create('spatial.reconstruct', { captureId: photos.id, artworkId: 'art-1' });
    await settle(jobs, first.id);
    const [old] = spatialRecords(store);
    const oldSnapshot = JSON.stringify(old);

    const video = path.join(dir, 'drop', 'later.mp4');
    await fs.writeFile(video, fakeMp4());
    const mixed = await captures.addVideoToCapture(photos.id, video, { capturedAt: '2026-12-02T09:00:00Z' });
    const second = await jobs.create('spatial.reconstruct', { captureId: mixed.id, artworkId: 'art-1' });
    expect(second.input).toMatchObject({ mode: 'mixed', previousSpatialId: old!.id });
    await settle(jobs, second.id);
    expect(jobs.get(second.id).state).toBe('completed');

    const records = spatialRecords(store);
    expect(records).toHaveLength(2);
    const revision = records.find((record) => record.id !== old!.id)!;
    expect(revision.manifest.id).not.toBe(old!.manifest.id);
    expect(revision.manifest.revision).toEqual({
      number: 2, reason: 'video_added', previousSpatialId: old!.id, previousManifestCid: old!.manifestCid, previousCaptureId: photos.id,
      inputs: { captureKind: 'mixed', photos: 12, video: true },
    });
    expect(revision.manifest.captureId).toBe(mixed.id);
    expect(JSON.stringify(records.find((record) => record.id === old!.id))).toBe(oldSnapshot);

    // A third revision numbers from the second.
    const third = await jobs.create('spatial.reconstruct', { captureId: mixed.id, artworkId: 'art-1', previousSpatialId: revision.id });
    await settle(jobs, third.id);
    const latest = spatialRecords(store).find((record) => record.manifest.revision.number === 3)!;
    expect(latest.manifest.revision).toMatchObject({ number: 3, reason: 'resolve', previousSpatialId: revision.id });
  });

  it('validates the revision options', async () => {
    const { jobs, photos, store } = await setup(['photos']);
    const done = await jobs.create('spatial.reconstruct', { captureId: photos.id });
    await settle(jobs, done.id);
    await expect(jobs.create('spatial.reconstruct', { captureId: photos.id, floaterCrop: 'yes' })).rejects.toMatchObject({ statusCode: 400, code: 'job_floater_crop_invalid' });
    await expect(jobs.create('spatial.reconstruct', { captureId: photos.id, previousSpatialId: 'nope' })).rejects.toMatchObject({ statusCode: 422, code: 'previous_spatial_not_found' });
    await expect(jobs.create('spatial.reconstruct', { captureId: photos.id, previousSpatialId: 7 })).rejects.toMatchObject({ statusCode: 400, code: 'job_previous_spatial_invalid' });
    // A record of another artwork cannot be revised by this capture.
    await store.update((state) => { const record = Object.values(state.spatial ?? {})[0] as { manifest: { artworkId: string } }; record.manifest.artworkId = 'art-other'; });
    const id = spatialRecords(store)[0]!.id;
    await expect(jobs.create('spatial.reconstruct', { captureId: photos.id, previousSpatialId: id })).rejects.toMatchObject({ statusCode: 422, code: 'previous_spatial_artwork_mismatch' });
  });
});

describe('spatial manifest viewer fields', () => {
  const base = () => ({
    schema: 'kubus.spatial/1', type: 'gaussianSplat', id: 's1', artworkId: 'a1', captureId: 'c1', capturedAt: '2026-08-17T06:00:00Z',
    processing: { protocol: 'kubus.spatial-job/1', workerVersion: 'w', reconstruction: { engine: 'nerfstudio', method: 'splatfacto', iterations: 1000, outputFormat: 'ply' } },
    variants: [{ role: 'spatial_archive', cid: 'cid', sizeBytes: 1, mimeType: 'application/octet-stream', format: 'ply', storageClass: 'cold' }],
    createdAt: '2026-08-17T06:00:00Z',
  });

  it('accepts a 16-number finite matrix and a numbered revision, and rejects malformed ones', () => {
    const matrix = Array.from({ length: 16 }, (_, index) => (index % 5 === 0 ? 1 : 0));
    expect(() => validateSpatialManifest({ ...base(), transform: { matrix }, revision: { number: 1, reason: 'initial', inputs: { captureKind: 'photos' } } })).not.toThrow();
    for (const bad of [matrix.slice(1), [...matrix.slice(1), Number.NaN], 'x']) {
      expect(() => validateSpatialManifest({ ...base(), transform: { matrix: bad } })).toThrow('spatial_manifest_transform_invalid');
    }
    expect(() => validateSpatialManifest({ ...base(), revision: { number: 0, reason: 'initial', inputs: {} } })).toThrow('spatial_manifest_revision_invalid');
    expect(() => validateSpatialManifest({ ...base(), revision: { number: 2, reason: 'resolve', inputs: {} } })).toThrow('spatial_manifest_revision_invalid');
  });
});

describe('Node viewer applies the manifest transform', () => {
  async function runBootstrap(manifestResponse: () => Promise<unknown>) {
    const loaded: unknown[][] = [];
    const status = { hidden: true, textContent: '' };
    const sandbox: Record<string, unknown> = {
      document: { querySelector: () => status },
      location: { search: '?id=spatial-1&role=spatial_archive' },
      localStorage: { getItem: () => 'token-1' },
      URL: { createObjectURL: () => 'blob:content' },
      console: { error: () => undefined },
      window: { loadSpatial: async (...args: unknown[]) => { loaded.push(args); } },
      URLSearchParams,
      Object, encodeURIComponent,
      fetch: async (url: string) => {
        if (url.endsWith('/manifest')) return manifestResponse();
        return { ok: true, blob: async () => new Blob(['ply']) };
      },
    };
    vm.runInNewContext(spatialViewerBootstrapJs, sandbox);
    for (let turn = 0; turn < 20 && loaded.length === 0; turn += 1) await new Promise((resolve) => setTimeout(resolve, 5));
    return { loaded, status };
  }

  it('passes the manifest transform to loadSpatial together with the blob URL', async () => {
    const matrix = Array.from({ length: 16 }, (_, index) => index);
    const { loaded } = await runBootstrap(async () => ({ ok: true, json: async () => ({ success: true, data: { transform: { matrix } } }) }));
    expect(loaded).toEqual([['blob:content', { matrix }]]);
  });

  it('still opens a record that has no transform or whose manifest cannot be read', async () => {
    expect((await runBootstrap(async () => ({ ok: true, json: async () => ({ success: true, data: {} }) }))).loaded).toEqual([['blob:content', undefined]]);
    expect((await runBootstrap(async () => ({ ok: false }))).loaded).toEqual([['blob:content', undefined]]);
    expect((await runBootstrap(async () => { throw new Error('offline'); })).loaded).toEqual([['blob:content', undefined]]);
  });

  it('keeps the one local patch of the vendored bundle: loadSpatial takes the transform and applies the matrix', () => {
    expect(spatialViewerBundle).toContain('window.loadSpatial=async(B,T)=>');
    expect(spatialViewerBundle.split('JE.matrix.fromArray(T.matrix)').length - 1).toBe(1);
    expect(spatialViewerBundle).toContain('JE.matrix.decompose(JE.position,JE.quaternion,JE.scale)');
    expect(spatialViewerBundle).toContain('T.matrix.length===16');
  });
});
