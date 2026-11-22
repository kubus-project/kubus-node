import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CaptureStore } from '../src/captures/captureStore.js';
import { FACE_MASKING_REPORT_NAME, FACE_MASKING_REPORT_SCHEMA, PINNED_WEIGHTS_SHA256, effectiveMasking, resolveMasking, summariseReport } from '../src/captures/faceMasking.js';
import { PHOTO_MIN_BYTES } from '../src/captures/photoPackage.js';
import { VIDEO_MIN_BYTES } from '../src/captures/videoPackage.js';
import { parseAddVideoArguments, parseImportPhotosArguments, parseImportVideoArguments, parseProcessArguments, parseSupersedeArguments } from '../src/cli/captureImport.js';
import { CapabilityRegistry } from '../src/capabilities/registry.js';
import { faceMaskingProvenance, JobRuntime, maskingNeedsLook, missingMasking, noteNamesOperator, publicDerivation } from '../src/jobs/jobRuntime.js';
import { ManagedPins, canonicalPinCid } from '../src/ipfs/managedPins.js';
import { supersedeSpatialRecord } from '../src/spatial/supersede.js';
import { findSupersededContent, purgeSupersededContent, warnAboutSupersededContent } from '../src/spatial/supersededBlocks.js';
import { validateSpatialManifest } from '../src/spatial/models.js';
import { serveSpatialVariant } from '../src/gui/spatialGuiApi.js';
import { dropClientProvenanceClaims } from '../src/localApi/dispatch.js';
import { LocalStore } from '../src/state/localStore.js';
import { syntheticCid } from './fixtures/contentIds.js';

const dirs: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(dirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

async function tempDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'kubus-masking-'));
  dirs.push(dir);
  return dir;
}

/** A structurally valid JPEG header padded to a size; no decodable pixels (the Node only checks structure). */
function jpeg(seed: number): Buffer {
  const parts: Buffer[] = [Buffer.from([0xff, 0xd8])];
  const padding = Buffer.alloc(Math.min(PHOTO_MIN_BYTES + 2048 + seed, 60_000), 0x20 + (seed % 7));
  const comment = Buffer.from([0xff, 0xfe, 0, 0]);
  comment.writeUInt16BE(padding.length + 2, 2);
  parts.push(comment, padding);
  const frame = Buffer.alloc(19);
  frame[0] = 0xff; frame[1] = 0xc0; frame.writeUInt16BE(17, 2); frame[4] = 8;
  frame.writeUInt16BE(1200, 5); frame.writeUInt16BE(1600, 7); frame[9] = 3;
  frame.set([1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1], 10);
  parts.push(frame, Buffer.alloc(64, 0x11), Buffer.from([0xff, 0xd9]));
  return Buffer.concat(parts);
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

const sha = (buffer: Buffer) => createHash('sha256').update(buffer).digest('hex');

async function writePhotos(directory: string, count: number): Promise<Buffer[]> {
  await fs.mkdir(directory, { recursive: true });
  const written: Buffer[] = [];
  for (let index = 0; index < count; index += 1) {
    const data = jpeg(index);
    written.push(data);
    await fs.writeFile(path.join(directory, `Mural-${index + 1}.jpg`), data);
  }
  return written;
}

/** The report `face_mask.py mask` writes for these files: names are not in it, checksums are. */
function reportFor(files: Buffer[], regions: number[], overrides: Record<string, unknown> = {}) {
  return {
    schema: FACE_MASKING_REPORT_SCHEMA,
    detector: { name: 'YuNet', model: 'face_detection_yunet_2023mar', weightsSha256: PINNED_WEIGHTS_SHA256, scoreThreshold: 0.4, licence: 'MIT', opencv: '4.10.0' },
    images: files.map((file, index) => ({ sha256: sha(file), regions: regions[index] ?? 0, manualAdded: 0, manualExcluded: index === 1 ? 1 : 0 })),
    ...overrides,
  };
}

async function newStore() {
  const dir = await tempDir();
  const store = new LocalStore(path.join(dir, 'state.json'));
  await store.load();
  return { dir, store, captures: new CaptureStore(dir, store) };
}

describe('face-masking policy', () => {
  it('masks a capture bound to an artwork by default and honours an explicit choice either way', () => {
    expect(resolveMasking({ artworkId: 'art-1' })).toBe(true);
    expect(resolveMasking({})).toBe(false);
    expect(resolveMasking({ artworkId: 'art-1', maskFaces: false })).toBe(false);
    expect(resolveMasking({ maskFaces: true })).toBe(true);
  });

  it('gives a capture that predates the feature the default for its artwork', () => {
    expect(effectiveMasking({ artworkId: 'art-1' })).toEqual({ photos: 'worker', video: 'worker' });
    expect(effectiveMasking({})).toEqual({ photos: 'none', video: 'none' });
    expect(effectiveMasking({ artworkId: 'art-1', faceMasking: { photos: 'none', video: 'none' } })).toEqual({ photos: 'none', video: 'none' });
  });
});

describe('premasked photo report', () => {
  const files = [jpeg(1), jpeg(2), jpeg(3)];

  it('is bound to the files by checksum and yields counts per image in the capture order', () => {
    const summary = summariseReport(reportFor(files, [2, 0, 1]), files.map(sha));
    expect(summary).toMatchObject({ detector: 'YuNet', model: 'face_detection_yunet_2023mar', weightsSha256: PINNED_WEIGHTS_SHA256, images: 3, regions: 3, imagesWithRegions: 2, manualExcluded: 1, licence: 'MIT' });
    expect(summary.regionsPerImage).toEqual([2, 0, 1]);
    // The counts follow the order the photos are imported in, not the order of the report.
    const reordered = summariseReport(reportFor(files, [2, 0, 1]), [sha(files[2]!), sha(files[0]!), sha(files[1]!)]);
    expect(reordered.regionsPerImage).toEqual([1, 2, 0]);
  });

  it('records what the report left for a human to look at, summed, and zero when it flagged nothing', () => {
    const hashes = files.map(sha);
    expect(summariseReport(reportFor(files, [1, 0, 0]), hashes).needsLook).toEqual({ images: 0, weakExcluded: 0, largeBelowCertain: 0, items: [] });
    const flagged = reportFor(files, [1, 0, 0]);
    (flagged.images[0] as Record<string, unknown>).needsLook = { weakExcluded: 1 };
    (flagged.images[2] as Record<string, unknown>).needsLook = { weakExcluded: 2, largeBelowCertain: 1 };
    // Which images: their 1-based place in the capture's photo order (`photos/00001.jpg` is 1).
    expect(summariseReport(flagged, hashes).needsLook).toEqual({ images: 2, weakExcluded: 3, largeBelowCertain: 1, items: [{ image: 1, weakExcluded: 1 }, { image: 3, weakExcluded: 2, largeBelowCertain: 1 }] });
  });

  it('refuses a report that is not for exactly these files', () => {
    const hashes = files.map(sha);
    expect(() => summariseReport({ ...reportFor(files, []), schema: 'other' }, hashes)).toThrow(/unknown schema/);
    expect(() => summariseReport(reportFor(files.slice(0, 2), []), hashes)).toThrow(/covers 2 images; the directory holds 3/);
    expect(() => summariseReport(reportFor(files, []), [...hashes.slice(0, 2), sha(jpeg(9))])).toThrow(/not covered/);
    expect(() => summariseReport(reportFor(files, [], { detector: { name: 'YuNet', model: 'm' } }), hashes)).toThrow(/weights checksum/);
    expect(() => summariseReport(reportFor(files, [1, -1, 0]), hashes)).toThrow(/region count/);
    expect(() => summariseReport(reportFor(files, [1, 1.5, 0]), hashes)).toThrow(/region count/);
    expect(() => summariseReport('x', hashes)).toThrow(/unknown schema/);
  });

  it('counts each occurrence of identical files once', () => {
    const twin = [files[0]!, files[0]!, files[1]!];
    expect(summariseReport(reportFor(twin, [1, 2, 0]), twin.map(sha)).regions).toBe(3);
    expect(() => summariseReport(reportFor([files[0]!, files[1]!, files[1]!], [1, 1, 1]), twin.map(sha))).toThrow(/not covered/);
  });
});

describe('capture import records the masking decision', () => {
  it('records worker masking for a capture bound to an artwork, none without, and none when opted out', async () => {
    const { dir, captures } = await newStore();
    await writePhotos(path.join(dir, 'a'), 9);
    const bound = await captures.importPhotoDirectory(path.join(dir, 'a'), { artworkId: 'art-1', capturedAt: '2026-08-17T06:00:00Z' });
    expect(bound.faceMasking).toEqual({ photos: 'worker' });
    const unbound = await captures.importPhotoDirectory(path.join(dir, 'a'), {});
    expect(unbound.faceMasking).toEqual({ photos: 'none' });
    const optedOut = await captures.importPhotoDirectory(path.join(dir, 'a'), { artworkId: 'art-1', maskFaces: false });
    expect(optedOut.faceMasking).toEqual({ photos: 'none', optedOut: true });
    const forced = await captures.importPhotoDirectory(path.join(dir, 'a'), { maskFaces: true });
    expect(forced.faceMasking).toEqual({ photos: 'worker' });
  });

  it('records premasked photos with the report, and keeps the unmasked originals out of the store by design', async () => {
    const { dir, captures } = await newStore();
    const source = path.join(dir, 'masked', 'mural');
    const written = await writePhotos(source, 9);
    await fs.writeFile(path.join(source, FACE_MASKING_REPORT_NAME), JSON.stringify(reportFor(written, [2, 0, 1, 0, 0, 3, 0, 0, 0])));
    const capture = await captures.importPhotoDirectory(source, { artworkId: 'art-1' });
    expect(capture.faceMasking).toMatchObject({ photos: 'premasked', report: { images: 9, regions: 6, imagesWithRegions: 3, regionsPerImage: [2, 0, 1, 0, 0, 3, 0, 0, 0] } });
    // The report file is not an image: it is skipped, never stored in the capture.
    expect(capture.skippedFiles).toBe(1);
    expect(await fs.readdir(path.join(capture.directory, 'photos'))).toHaveLength(9);
    expect(JSON.stringify(await fs.readdir(capture.directory))).not.toContain('masking');
  });

  it('refuses a report that does not match the photos, or one that opts out of masking', async () => {
    const { dir, captures } = await newStore();
    const source = path.join(dir, 'masked', 'mural');
    const written = await writePhotos(source, 9);
    await fs.writeFile(path.join(source, FACE_MASKING_REPORT_NAME), JSON.stringify(reportFor(written, [])));
    await fs.writeFile(path.join(source, 'Mural-3.jpg'), jpeg(77)); // changed after masking
    await expect(captures.importPhotoDirectory(source, { artworkId: 'art-1' })).rejects.toMatchObject({ code: 'face_masking_report_mismatch' });
    await fs.writeFile(path.join(source, 'Mural-3.jpg'), written[2]!);
    await expect(captures.importPhotoDirectory(source, { artworkId: 'art-1', maskFaces: false })).rejects.toMatchObject({ code: 'face_masking_conflict' });
    await fs.writeFile(path.join(source, FACE_MASKING_REPORT_NAME), '{ not json');
    await expect(captures.importPhotoDirectory(source, { artworkId: 'art-1' })).rejects.toMatchObject({ code: 'face_masking_report_invalid' });
    expect(captures.list()).toHaveLength(0);
  });

  it('masks video by default for a bound capture, and a video added later keeps the photos masking and decides for itself', async () => {
    const { dir, captures } = await newStore();
    const video = path.join(dir, 'later.mp4');
    await fs.writeFile(video, fakeMp4());
    const imported = await captures.importVideoFile(video, { artworkId: 'art-1' });
    expect(imported.faceMasking).toEqual({ video: 'worker' });
    expect((await captures.importVideoFile(video, { artworkId: 'art-1', maskFaces: false })).faceMasking).toEqual({ video: 'none', optedOut: true });

    const source = path.join(dir, 'masked');
    const written = await writePhotos(source, 9);
    await fs.writeFile(path.join(source, FACE_MASKING_REPORT_NAME), JSON.stringify(reportFor(written, [1, 0, 0, 0, 0, 0, 0, 0, 0])));
    const base = await captures.importPhotoDirectory(source, { artworkId: 'art-1' });
    const mixed = await captures.addVideoToCapture(base.id, video, {});
    expect(mixed.faceMasking).toMatchObject({ photos: 'premasked', video: 'worker', report: { images: 9, regions: 1 } });
    const mixedOptOut = await captures.addVideoToCapture(base.id, video, { maskFaces: false });
    expect(mixedOptOut.faceMasking).toMatchObject({ photos: 'premasked', video: 'none', optedOut: true });

    // Photos that are unmasked only by default (no artwork) stay "by default" when a video is added with --no-mask-faces.
    const plain = path.join(dir, 'plain');
    await writePhotos(plain, 9);
    const unbound = await captures.importPhotoDirectory(plain, {});
    const unboundMixed = await captures.addVideoToCapture(unbound.id, video, { maskFaces: false });
    expect(unboundMixed.faceMasking).toEqual({ photos: 'none', video: 'none' });
    // An opt-out on the base capture carries over to the capture built from it.
    const chosen = await captures.importPhotoDirectory(plain, { maskFaces: false });
    expect((await captures.addVideoToCapture(chosen.id, video, {})).faceMasking).toEqual({ photos: 'none', video: 'none', optedOut: true });
  });

  it('survives a restart of the capture store', async () => {
    const { dir, store, captures } = await newStore();
    await writePhotos(path.join(dir, 'a'), 9);
    const capture = await captures.importPhotoDirectory(path.join(dir, 'a'), { artworkId: 'art-1' });
    const reopened = new CaptureStore(dir, store);
    expect(reopened.get(capture.id).faceMasking).toEqual({ photos: 'worker' });
  });
});

describe('client claims about masking are ignored', () => {
  it('drops faceMasking from metadata a paired client uploads', () => {
    const payload = { metadata: { kind: 'photos', faceMasking: { photos: 'none' }, frameCount: 3, derivedFromCaptureId: 'cap-1', capturedBy: 'Someone', mediaCapturedAt: { photos: '2020-01-01T00:00:00Z' } } };
    dropClientProvenanceClaims(payload);
    // The masking decision, the capture a revision derives from, the operator label and the per-medium times are the Node's to write.
    expect(payload.metadata).toEqual({ kind: 'photos', frameCount: 3 });
    expect(() => dropClientProvenanceClaims({})).not.toThrow();
    expect(() => dropClientProvenanceClaims(undefined as never)).not.toThrow();
  });
});

describe('command lines', () => {
  it('parses --mask-faces and --no-mask-faces and refuses both together', () => {
    expect(parseImportPhotosArguments(['/p', '--no-mask-faces'])).toMatchObject({ maskFaces: false });
    expect(parseImportPhotosArguments(['/p', '--mask-faces'])).toMatchObject({ maskFaces: true });
    expect(parseImportPhotosArguments(['/p'])).not.toHaveProperty('maskFaces');
    expect(() => parseImportPhotosArguments(['/p', '--mask-faces', '--no-mask-faces'])).toThrow(/cannot be combined/);
    expect(parseImportVideoArguments(['v.mp4', '--no-mask-faces'])).toMatchObject({ maskFaces: false });
    expect(parseImportVideoArguments(['v.mp4', '--mask-faces'])).toMatchObject({ maskFaces: true });
    expect(() => parseImportVideoArguments(['v.mp4', '--mask-faces', '--no-mask-faces'])).toThrow(/cannot be combined/);
    expect(() => parseImportVideoArguments(['v.mp4', '--no-mask-faces', '--mask-faces'])).toThrow(/cannot be combined/);
    expect(parseAddVideoArguments(['c', 'v.mp4', '--no-mask-faces'])).toMatchObject({ maskFaces: false });
    expect(parseProcessArguments(['c', '--previous', 's', '--revision-note', 'face masking and provenance'])).toEqual({ captureId: 'c', previousSpatialId: 's', revisionNote: 'face masking and provenance' });
    expect(parseSupersedeArguments(['old', '--by', 'new'])).toEqual({ spatialId: 'old', byId: 'new' });
    expect(() => parseSupersedeArguments(['old'])).toThrow(/--by/);
    expect(() => parseSupersedeArguments(['--by', 'x'])).toThrow(/Exactly one/);
  });
});

describe('masking in the job and the record', () => {
  const WORKER_ID = '66666666-6666-4666-8666-666666666666';
  const processing = { protocol: 'kubus.spatial-job/1', workerVersion: 'kubus-spatial-worker/5', reconstruction: { engine: 'nerfstudio', method: 'splatfacto', iterations: 1000, outputFormat: 'ply' } };
  const part = (images: number, regions = 3) => ({ ran: true, images, regions, imagesWithRegions: 2, regionsPerImage: Array.from({ length: images }, (_, index) => (index < regions ? 1 : 0)), detector: 'YuNet', model: 'face_detection_yunet_2023mar', weightsSha256: PINNED_WEIGHTS_SHA256, scoreThreshold: 0.4, licence: 'MIT', opencv: '4.10.0' });

  async function setup(options: { faceMasking?: boolean; faceReviewImages?: boolean; report?: (requested: any) => unknown; files?: string[] } = {}) {
    const { dir, store, captures } = await newStore();
    const bodies: any[] = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (url.endsWith('/health')) return new Response(JSON.stringify({ status: 'ready', cleanupProtocol: 1, workerInstanceId: WORKER_ID, gpu: { available: true, name: 'RTX' }, capabilities: ['spatial.reconstruct'], inputModes: ['frames', 'video', 'photos', 'mixed'], ...(options.faceMasking === false ? {} : { faceMasking: true, ...(options.faceReviewImages === false ? {} : { faceReviewImages: true }) }) }), { status: 200 });
      if (url.endsWith('/v1/jobs/cancel')) return new Response(JSON.stringify({ ...JSON.parse(String(init?.body)), cleanupProtocol: 1, quiescent: true }));
      if (url.endsWith('/v1/process')) {
        const body = JSON.parse(String(init?.body ?? '{}'));
        bodies.push(body);
        await fs.mkdir(body.outputDirectory, { recursive: true });
        await fs.writeFile(path.join(body.outputDirectory, 'result.ply'), Buffer.alloc(2048, 3));
        // The masked images the worker flagged, as it leaves them in the job's working directory.
        for (const file of options.files ?? []) {
          await fs.mkdir(path.dirname(path.join(body.outputDirectory, file)), { recursive: true });
          await fs.writeFile(path.join(body.outputDirectory, file), Buffer.from(`masked ${file}`));
        }
        const requested = body.input.maskFaces;
        const faceMasking = options.report ? options.report(requested) : requested ? { ...(requested.photos ? { photos: part(9) } : {}), ...(requested.video ? { video: part(48) } : {}) } : undefined;
        return new Response(JSON.stringify({
          variants: [{ role: 'spatial_archive', path: 'result.ply', mimeType: 'application/octet-stream', format: 'ply', storageClass: 'cold' }],
          processing,
          provenance: { kind: body.input.mode, sfm: { registeredViews: 9, submittedViews: 9, minRegisteredViews: 24, minRegistrationRatio: 0.6, gateLowered: false }, splatCount: 90, ...(faceMasking ? { faceMasking } : {}) },
        }), { status: 200 });
      }
      throw new Error(`unexpected fetch to ${url}`);
    });
    let counter = 0;
    const jobs = new JobRuntime({
      store, captureStore: captures,
      kubo: { pinAdd: async () => undefined, pinLs: async () => ({ Keys: {} }), addFileStreamed: async () => ({ Hash: syntheticCid(`out-${counter += 1}`) }), addBytes: async () => ({ Hash: syntheticCid(`manifest-${counter += 1}`) }) } as never,
      logger: { warn: () => undefined } as never,
      dataRoot: dir, concurrency: 1, workerUrl: 'http://kubus-spatial-worker:8790',
      participationGate: { assertUsefulOperation: async () => undefined } as never,
      workerAuth: { issue: async () => 'token' } as never,
      capabilities: new CapabilityRegistry({ id: async () => ({ ID: 'peer' }) } as never, 'http://kubus-spatial-worker:8790'),
    });
    await jobs.start();
    return { dir, store, captures, jobs, bodies };
  }

  async function settle(jobs: JobRuntime, id: string): Promise<void> {
    const deadline = Date.now() + 8000;
    while (!['completed', 'failed', 'cancelled'].includes(jobs.get(id).state) || jobs.health().running > 0) {
      if (Date.now() > deadline) throw new Error('job did not settle');
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }

  const records = (store: LocalStore) => Object.values(store.snapshot().spatial ?? {}) as Array<{ id: string; manifestCid: string; createdAt: string; manifest: any; state: string }>;

  it('asks the worker to mask photos of a bound capture and records what it reports, per image, privately', async () => {
    const { dir, store, captures, jobs, bodies } = await setup();
    await writePhotos(path.join(dir, 'a'), 9);
    const capture = await captures.importPhotoDirectory(path.join(dir, 'a'), { artworkId: 'art-1' });
    const job = await jobs.create('spatial.reconstruct', { captureId: capture.id });
    expect(job.input).toMatchObject({ mode: 'photos', maskFaces: { photos: true, video: false } });
    await settle(jobs, job.id);
    expect(jobs.get(job.id).state).toBe('completed');
    expect(bodies[0].input.maskFaces).toEqual({ photos: true, video: false });
    const [record] = records(store);
    const masking = record!.manifest.captureProvenance.derivation.faceMasking;
    expect(masking).toMatchObject({ ran: true, photos: { source: 'worker', detector: 'YuNet', model: 'face_detection_yunet_2023mar', images: 9, regions: 3, imagesWithRegions: 2 } });
    // The manifest is what gets pinned and published: no per-image counts and no manual-list counts in it anywhere.
    expect(JSON.stringify(record!.manifest)).not.toMatch(/regionsPerImage|manualAdded|manualExcluded/);
    // They are kept, privately, in the job record.
    expect((jobs.get(job.id).maskingDetail as any).photos.regionsPerImage).toHaveLength(9);
    // The record that can leave the Node says that masking ran and how many regions, never which image or where.
    expect(record!.manifest.processing.faceMasking).toEqual({ ran: true, photos: { source: 'worker', detector: 'YuNet', model: 'face_detection_yunet_2023mar', weightsSha256: PINNED_WEIGHTS_SHA256, weightsPinned: true, scoreThreshold: 0.4, images: 9, regions: 3, imagesWithRegions: 2 } });
    expect(JSON.stringify(record!.manifest.processing)).not.toContain('regionsPerImage');
  });

  it('fails the job, imports nothing, when the worker does not report masking it was asked for', async () => {
    const { dir, store, captures, jobs } = await setup({ report: () => undefined });
    await writePhotos(path.join(dir, 'a'), 9);
    const capture = await captures.importPhotoDirectory(path.join(dir, 'a'), { artworkId: 'art-1' });
    const job = await jobs.create('spatial.reconstruct', { captureId: capture.id });
    await settle(jobs, job.id);
    expect(jobs.get(job.id)).toMatchObject({ state: 'failed', error: { code: 'face_masking_failed' } });
    expect(records(store)).toHaveLength(0);
    // A report with no images, or one without the pinned checksum, is no better than none.
    for (const report of [{ photos: { ran: true, images: 0, weightsSha256: PINNED_WEIGHTS_SHA256 } }, { photos: { ran: true, images: 9 } }, { photos: { ran: false, images: 9, weightsSha256: PINNED_WEIGHTS_SHA256 } }, { photos: { ran: true, images: 9, weightsSha256: 'a'.repeat(64) } }]) {
      expect(missingMasking({ photos: true }, { faceMasking: report })).toEqual(['photos']);
    }
    expect(missingMasking({ photos: true, video: true }, { faceMasking: { photos: part(9) } })).toEqual(['video']);
    expect(missingMasking({ photos: false, video: false }, undefined)).toEqual([]);
    expect(missingMasking(undefined, undefined)).toEqual([]);
  });

  it('refuses a worker that cannot mask faces before reserving it', async () => {
    const { dir, captures, jobs, bodies } = await setup({ faceMasking: false });
    await writePhotos(path.join(dir, 'a'), 9);
    const capture = await captures.importPhotoDirectory(path.join(dir, 'a'), { artworkId: 'art-1' });
    const job = await jobs.create('spatial.reconstruct', { captureId: capture.id });
    await settle(jobs, job.id);
    expect(jobs.get(job.id).error?.code).toBe('worker_face_masking_unsupported');
    expect(bodies).toHaveLength(0);
    // An opted-out capture needs no such worker.
    const optedOut = await captures.importPhotoDirectory(path.join(dir, 'a'), { artworkId: 'art-1', maskFaces: false });
    const plain = await jobs.create('spatial.reconstruct', { captureId: optedOut.id });
    expect(plain.input).not.toHaveProperty('maskFaces');
    await settle(jobs, plain.id);
    expect(jobs.get(plain.id).state).toBe('completed');
  });

  it('does not ask for masking of premasked photos and carries the operator report into the record', async () => {
    const { dir, store, captures, jobs, bodies } = await setup();
    const source = path.join(dir, 'masked');
    const written = await writePhotos(source, 9);
    await fs.writeFile(path.join(source, FACE_MASKING_REPORT_NAME), JSON.stringify(reportFor(written, [2, 0, 1, 0, 0, 3, 0, 0, 0])));
    const capture = await captures.importPhotoDirectory(source, { artworkId: 'art-1' });
    const job = await jobs.create('spatial.reconstruct', { captureId: capture.id });
    expect(job.input).not.toHaveProperty('maskFaces');
    await settle(jobs, job.id);
    expect(jobs.get(job.id).state).toBe('completed');
    expect(bodies[0].input).not.toHaveProperty('maskFaces');
    const [record] = records(store);
    const masking = record!.manifest.captureProvenance.derivation.faceMasking;
    expect(masking).toMatchObject({ ran: true, photos: { source: 'premasked', attestation: 'operator_report', weightsPinned: true, detector: 'YuNet', weightsSha256: PINNED_WEIGHTS_SHA256, images: 9, regions: 6, imagesWithRegions: 3 } });
    expect(JSON.stringify(record!.manifest)).not.toMatch(/regionsPerImage|manualAdded|manualExcluded/);
    // The per-image counts of the operator's report stay in the private capture record.
    expect((captures.get(capture.id).faceMasking?.report as any).regionsPerImage).toEqual([2, 0, 1, 0, 0, 3, 0, 0, 0]);
    expect(record!.manifest.processing.faceMasking).toMatchObject({ ran: true, photos: { source: 'premasked', regions: 6 } });
  });

  it('masks the video part of a mixed capture while the premasked photos are left to the report', async () => {
    const { dir, store, captures, jobs, bodies } = await setup();
    const source = path.join(dir, 'masked');
    const written = await writePhotos(source, 9);
    await fs.writeFile(path.join(source, FACE_MASKING_REPORT_NAME), JSON.stringify(reportFor(written, [1, 0, 0, 0, 0, 0, 0, 0, 0])));
    const base = await captures.importPhotoDirectory(source, { artworkId: 'art-1' });
    const video = path.join(dir, 'later.mp4');
    await fs.writeFile(video, fakeMp4());
    const mixed = await captures.addVideoToCapture(base.id, video, {});
    const job = await jobs.create('spatial.reconstruct', { captureId: mixed.id });
    expect(job.input).toMatchObject({ mode: 'mixed', maskFaces: { photos: false, video: true } });
    await settle(jobs, job.id);
    expect(bodies[0].input.maskFaces).toEqual({ photos: false, video: true });
    const masking = records(store)[0]!.manifest.captureProvenance.derivation.faceMasking;
    expect(masking).toMatchObject({ ran: true, photos: { source: 'premasked', images: 9 }, video: { source: 'worker', images: 48 } });
  });

  it('records that masking did not run for an opted-out capture, and says nothing for posed frames', () => {
    expect(faceMaskingProvenance({ kind: 'photos', artworkId: 'art-1', faceMasking: { photos: 'none' } }, undefined)).toEqual({ ran: false });
    // A posed-frame package never passes the worker's intake: the record says so instead of staying silent.
    expect(faceMaskingProvenance({ kind: 'frames', artworkId: 'art-1' }, undefined)).toEqual({ ran: false, reason: 'posed_frames_not_masked' });
    expect(faceMaskingProvenance({ kind: 'video', artworkId: 'art-1', faceMasking: { video: 'worker' } }, { faceMasking: { video: part(48) } })).toMatchObject({ ran: true, video: { source: 'worker', images: 48 } });
    // What the worker reports is bounded: unknown keys and non-count arrays are dropped.
    const clean = faceMaskingProvenance({ kind: 'photos', faceMasking: { photos: 'worker' } }, { faceMasking: { photos: { ...part(9), coordinates: [[1, 2]], regionsPerImage: ['x'] } } }) as any;
    expect(clean.photos).not.toHaveProperty('coordinates');
    expect(clean.photos).not.toHaveProperty('regionsPerImage');
    expect(clean.photos.source).toBe('worker');
  });

  it('keeps what a worker part says a human should look at, as counts only', () => {
    const look = { images: 2, largeBelowCertain: 3, coordinates: [[1, 2]] };
    const kept = faceMaskingProvenance({ kind: 'photos', faceMasking: { photos: 'worker' } }, { faceMasking: { photos: { ...part(9), needsLook: look } } }) as any;
    expect(kept.photos.needsLook).toEqual({ images: 2, weakExcluded: 0, largeBelowCertain: 3 });
    // Which images are kept as bounded numbers; anything else a worker sends under it is dropped.
    const listed = faceMaskingProvenance({ kind: 'photos', faceMasking: { photos: 'worker' } }, { faceMasking: { photos: { ...part(9), needsLook: { images: 2, largeBelowCertain: 3, items: [{ image: 2, largeBelowCertain: 1, box: [1, 2] }, { image: 0 }, { image: 'x' }, null, { image: 7, weakExcluded: 2 }], itemsTruncated: true } } } }) as any;
    expect(listed.photos.needsLook.items).toEqual([{ image: 2, largeBelowCertain: 1 }, { image: 7, weakExcluded: 2 }]);
    expect(listed.photos.needsLook.itemsTruncated).toBe(true);
    expect(JSON.stringify(listed)).not.toContain('box');
    expect(maskingNeedsLook(kept)).toBe(2);
    expect(maskingNeedsLook({ ran: true, photos: { needsLook: { images: 1 } }, video: { needsLook: { images: 4 } } })).toBe(5);
    expect(maskingNeedsLook(undefined)).toBe(0);
    expect(maskingNeedsLook({ ran: true, photos: { images: 9 } })).toBe(0);
  });

  it('warns in the job log when masking left images for a human, keeps it out of the pinned manifest', async () => {
    const { dir, store, captures, jobs } = await setup({
      files: ['dataset/images/photo_00001.jpg', 'dataset/images/photo_00004.jpg'],
      report: () => ({ photos: { ...part(9), needsLook: { images: 2, weakExcluded: 1, largeBelowCertain: 3, items: [{ image: 2, largeBelowCertain: 2, file: 'dataset/images/photo_00001.jpg' }, { image: 5, weakExcluded: 1, largeBelowCertain: 1, file: 'dataset/images/photo_00004.jpg' }] } } }),
    });
    await writePhotos(path.join(dir, 'a'), 9);
    const capture = await captures.importPhotoDirectory(path.join(dir, 'a'), { artworkId: 'art-1' });
    const job = await jobs.create('spatial.reconstruct', { captureId: capture.id });
    await settle(jobs, job.id);
    const finished = jobs.get(job.id) as any;
    expect(finished.state).toBe('completed');
    const warning = finished.logs.find((entry: { level: string; message: string }) => entry.level === 'warn');
    expect(warning.message).toContain('2 image(s) a human has to look at');
    // The line says which kinds are non-zero, and that publishing needs the acknowledgement.
    expect(warning.message).toContain('3 large detection(s) it did not mask');
    expect(warning.message).toContain('1 weaker detection(s) inside an exclude box');
    expect(warning.message).toContain('cannot be published until that look is acknowledged');
    // The private job record says which images.
    expect(finished.maskingDetail.photos.needsLook).toMatchObject({ images: 2, largeBelowCertain: 3, items: [{ image: 2, largeBelowCertain: 2 }, { image: 5, weakExcluded: 1, largeBelowCertain: 1 }] });
    expect(JSON.stringify(records(store)[0]!.manifest)).not.toMatch(/needsLook|largeBelowCertain|faceReview/);
    // The private spatial record carries what the publish route checks, and the masked copies the operator looks at.
    const review = (records(store)[0] as any).faceReview;
    expect(review).toEqual({
      pending: 2, jobId: job.id, viewed: [],
      items: [{ part: 'photos', image: 2, file: 'photos-00002.jpg', largeBelowCertain: 2 }, { part: 'photos', image: 5, file: 'photos-00005.jpg', weakExcluded: 1, largeBelowCertain: 1 }],
    });
    const kept = path.join(dir, 'private', 'face-review', (records(store)[0] as any).id);
    expect((await fs.readFile(path.join(kept, 'photos-00002.jpg'))).toString()).toBe('masked dataset/images/photo_00001.jpg');
    // The job's own working directory is gone; the copies are what is left.
    await expect(fs.stat(path.join(dir, 'private', 'jobs', job.id))).rejects.toThrow();
  });

  it('keeps where the masked copy is and where in the footage a frame is, and drops anything that is not a worker image path', () => {
    const kept = faceMaskingProvenance({ kind: 'mixed', artworkId: 'a', faceMasking: { photos: 'worker', video: 'worker' } }, { faceMasking: {
      photos: { ...part(9), needsLook: { images: 3, largeBelowCertain: 3, items: [{ image: 1, largeBelowCertain: 1, file: 'dataset/images/photo_00000.jpg' }, { image: 2, largeBelowCertain: 1, file: '../../etc/passwd' }, { image: 3, largeBelowCertain: 1, file: 'C:/x/photo_00000.jpg' }] } },
      video: { ...part(48), needsLook: { images: 1, largeBelowCertain: 1, items: [{ image: 12, largeBelowCertain: 1, file: 'selected_frames/frame_00011.jpg', seconds: 41.3 }, { image: 13, file: 'dataset/images/video_00012.jpg', seconds: -4 }, { image: 14, seconds: 'soon' }] } },
    } }) as any;
    expect(kept.photos.needsLook.items).toEqual([{ image: 1, largeBelowCertain: 1, file: 'dataset/images/photo_00000.jpg' }, { image: 2, largeBelowCertain: 1 }, { image: 3, largeBelowCertain: 1 }]);
    expect(kept.video.needsLook.items).toEqual([{ image: 12, largeBelowCertain: 1, file: 'selected_frames/frame_00011.jpg', seconds: 41.3 }, { image: 13, file: 'dataset/images/video_00012.jpg' }, { image: 14 }]);
  });

  it('keeps the flagged masked copies of a video job (with where in the footage they are) and of premasked photos from the capture itself', async () => {
    const { dir, store, captures, jobs } = await setup({
      files: ['selected_frames/frame_00011.jpg'],
      report: () => ({ video: { ...part(48), needsLook: { images: 1, largeBelowCertain: 1, items: [{ image: 12, largeBelowCertain: 1, file: 'selected_frames/frame_00011.jpg', seconds: 41.3 }] } } }),
    });
    await fs.writeFile(path.join(dir, 'clip.mp4'), fakeMp4());
    const video = await captures.importVideoFile(path.join(dir, 'clip.mp4'), { artworkId: 'art-1' });
    const videoJob = await jobs.create('spatial.reconstruct', { captureId: video.id });
    await settle(jobs, videoJob.id);
    expect(jobs.get(videoJob.id).error).toBeUndefined();
    const record = records(store)[0] as any;
    expect(record.faceReview).toEqual({ pending: 1, jobId: videoJob.id, viewed: [], items: [{ part: 'video', image: 12, file: 'video-00012.jpg', largeBelowCertain: 1, seconds: 41.3 }] });
    expect((await fs.readFile(path.join(dir, 'private', 'face-review', record.id, 'video-00012.jpg'))).toString()).toBe('masked selected_frames/frame_00011.jpg');

    // Photos masked before import: the capture's own files are the masked images.
    const source = path.join(dir, 'premasked');
    const written = await writePhotos(source, 9);
    const flagged = reportFor(written, [1, 0, 0, 0, 0, 0, 0, 0, 0]);
    (flagged.images[3] as Record<string, unknown>).needsLook = { largeBelowCertain: 2 };
    await fs.writeFile(path.join(source, FACE_MASKING_REPORT_NAME), JSON.stringify(flagged));
    const premasked = await captures.importPhotoDirectory(source, { artworkId: 'art-2' });
    const photoJob = await jobs.create('spatial.reconstruct', { captureId: premasked.id });
    await settle(jobs, photoJob.id);
    expect(jobs.get(photoJob.id).error).toBeUndefined();
    const second = records(store).find((entry) => entry.manifest.artworkId === 'art-2') as any;
    expect(second.faceReview).toMatchObject({ pending: 1, items: [{ part: 'photos', image: 4, file: 'photos-00004.jpg', largeBelowCertain: 2 }] });
    expect((await fs.readFile(path.join(dir, 'private', 'face-review', second.id, 'photos-00004.jpg')))).toEqual(written[3]);
  });

  it('fails the job, with no record and no kept copies, when a flagged image has no copy to keep, and refuses a worker that cannot name them', async () => {
    const { dir, store, captures, jobs } = await setup({ report: () => ({ photos: { ...part(9), needsLook: { images: 1, largeBelowCertain: 1, items: [{ image: 2, largeBelowCertain: 1 }] } } }) });
    await writePhotos(path.join(dir, 'a'), 9);
    const capture = await captures.importPhotoDirectory(path.join(dir, 'a'), { artworkId: 'art-1' });
    const job = await jobs.create('spatial.reconstruct', { captureId: capture.id });
    await settle(jobs, job.id);
    expect(jobs.get(job.id)).toMatchObject({ state: 'failed', error: { code: 'face_review_images_unavailable' } });
    expect(records(store)).toHaveLength(0);
    expect(await fs.readdir(path.join(dir, 'private', 'face-review')).catch(() => [])).toEqual([]);

    // A worker image from before the file names (it masks, but cannot say which image is which) is refused up front.
    const old = await setup({ faceReviewImages: false });
    await writePhotos(path.join(old.dir, 'a'), 9);
    const oldCapture = await old.captures.importPhotoDirectory(path.join(old.dir, 'a'), { artworkId: 'art-1' });
    const oldJob = await old.jobs.create('spatial.reconstruct', { captureId: oldCapture.id });
    await settle(old.jobs, oldJob.id);
    expect(old.jobs.get(oldJob.id)).toMatchObject({ state: 'failed', error: { code: 'worker_face_review_unsupported' } });
    expect(old.bodies).toHaveLength(0);
  });

  it('only warns about the kind of detection that is non-zero', async () => {
    const { dir, captures, jobs } = await setup({ report: () => ({ photos: { ...part(9), needsLook: { images: 1, weakExcluded: 2, largeBelowCertain: 0 } } }) });
    await writePhotos(path.join(dir, 'a'), 9);
    const capture = await captures.importPhotoDirectory(path.join(dir, 'a'), { artworkId: 'art-1' });
    const job = await jobs.create('spatial.reconstruct', { captureId: capture.id });
    await settle(jobs, job.id);
    const warning = (jobs.get(job.id) as any).logs.find((entry: { level: string }) => entry.level === 'warn');
    expect(warning.message).toContain('2 weaker detection(s) inside an exclude box');
    expect(warning.message).not.toContain('large detection');
  });

  it('refuses a job that binds a capture imported without an artwork and without masking to an artwork', async () => {
    const { dir, store, captures, jobs } = await setup();
    await writePhotos(path.join(dir, 'a'), 9);
    const unbound = await captures.importPhotoDirectory(path.join(dir, 'a'), {});
    expect(unbound.faceMasking).toEqual({ photos: 'none' });
    // The default of a private capture is not a choice: naming an artwork at job time would publish unmasked pixels under it.
    await expect(jobs.create('spatial.reconstruct', { captureId: unbound.id, artworkId: 'art-1' })).rejects.toMatchObject({ statusCode: 422, code: 'job_artwork_binds_unmasked_capture' });
    expect(Object.keys(store.snapshot().jobs ?? {})).toHaveLength(0);
    // A record needs an artwork and import would refuse after the GPU run: the job is refused before it.
    await expect(jobs.create('spatial.reconstruct', { captureId: unbound.id })).rejects.toMatchObject({ statusCode: 422, code: 'job_artwork_required' });
    await expect(jobs.create('spatial.reconstruct', { captureId: unbound.id, artworkId: '' })).rejects.toMatchObject({ code: 'job_artwork_required' });
    expect(Object.keys(store.snapshot().jobs ?? {})).toHaveLength(0);
  });

  it('refuses the same for video and for the video part of a mixed capture', async () => {
    const { dir, captures, jobs } = await setup();
    await fs.writeFile(path.join(dir, 'clip.mp4'), fakeMp4());
    const video = await captures.importVideoFile(path.join(dir, 'clip.mp4'), {});
    await expect(jobs.create('spatial.reconstruct', { captureId: video.id, artworkId: 'art-1' })).rejects.toMatchObject({ code: 'job_artwork_binds_unmasked_capture' });
    await writePhotos(path.join(dir, 'a'), 9);
    const mixed = await captures.importPhotoDirectory(path.join(dir, 'a'), { videoPath: path.join(dir, 'clip.mp4') });
    expect(mixed.faceMasking).toMatchObject({ photos: 'none', video: 'none' });
    await expect(jobs.create('spatial.reconstruct', { captureId: mixed.id, artworkId: 'art-1' })).rejects.toMatchObject({ code: 'job_artwork_binds_unmasked_capture' });
  });

  it('accepts an artwork at job time for a capture masked on request, one imported for an artwork, and an explicit opt-out', async () => {
    const { dir, store, captures, jobs } = await setup();
    await writePhotos(path.join(dir, 'a'), 9);
    const forced = await captures.importPhotoDirectory(path.join(dir, 'a'), { maskFaces: true });
    const forcedJob = await jobs.create('spatial.reconstruct', { captureId: forced.id, artworkId: 'art-1' });
    expect(forcedJob.input).toMatchObject({ maskFaces: { photos: true } });
    await settle(jobs, forcedJob.id);
    // A capture imported for an artwork is masked whatever artwork the job names: nothing unmasked is bound.
    const bound = await captures.importPhotoDirectory(path.join(dir, 'a'), { artworkId: 'art-2' });
    const boundJob = await jobs.create('spatial.reconstruct', { captureId: bound.id, artworkId: 'art-3' });
    expect(boundJob.input).toMatchObject({ maskFaces: { photos: true } });
    await settle(jobs, boundJob.id);
    // An explicit --no-mask-faces is stored as a choice and is a different capture from the default one.
    const chosen = await captures.importPhotoDirectory(path.join(dir, 'a'), { maskFaces: false });
    expect(chosen.faceMasking).toEqual({ photos: 'none', optedOut: true });
    expect(chosen.id).not.toBe((await captures.importPhotoDirectory(path.join(dir, 'a'), {})).id);
    const chosenJob = await jobs.create('spatial.reconstruct', { captureId: chosen.id, artworkId: 'art-4' });
    expect(chosenJob.input.maskFaces).toBeUndefined();
    await settle(jobs, chosenJob.id);
    const done = Object.values(store.snapshot().spatial ?? {}) as Array<{ manifest: any }>;
    expect(done.find((record) => record.manifest.artworkId === 'art-4')!.manifest.processing.faceMasking).toEqual({ ran: false, reason: 'operator_opted_out' });
  });

  it('does not warn when masking flagged nothing', async () => {
    const { dir, captures, jobs } = await setup({ report: () => ({ photos: { ...part(9), needsLook: { images: 0, largeBelowCertain: 0 } } }) });
    await writePhotos(path.join(dir, 'a'), 9);
    const capture = await captures.importPhotoDirectory(path.join(dir, 'a'), { artworkId: 'art-1' });
    const job = await jobs.create('spatial.reconstruct', { captureId: capture.id });
    await settle(jobs, job.id);
    expect((jobs.get(job.id) as any).logs.some((entry: { level: string }) => entry.level === 'warn')).toBe(false);
  });

  it('numbers a masked re-run as a face_masking revision of the unmasked record, with the operator note', async () => {
    const { dir, store, captures, jobs } = await setup();
    await writePhotos(path.join(dir, 'a'), 9);
    const first = await captures.importPhotoDirectory(path.join(dir, 'a'), { artworkId: 'art-1', maskFaces: false });
    const before = await jobs.create('spatial.reconstruct', { captureId: first.id });
    await settle(jobs, before.id);
    const [old] = records(store);
    expect(old!.manifest.captureProvenance.derivation.faceMasking).toEqual({ ran: false, reason: 'operator_opted_out' });
    expect(old!.manifest.processing.faceMasking).toEqual({ ran: false, reason: 'operator_opted_out' });

    const source = path.join(dir, 'masked');
    const written = await writePhotos(source, 9);
    await fs.writeFile(path.join(source, FACE_MASKING_REPORT_NAME), JSON.stringify(reportFor(written, [1, 0, 0, 0, 0, 0, 0, 0, 0])));
    const masked = await captures.importPhotoDirectory(source, { artworkId: 'art-1' });
    const note = 'face masking and provenance (capturedBy, capturedAt zone)';
    const after = await jobs.create('spatial.reconstruct', { captureId: masked.id, previousSpatialId: old!.id, revisionNote: note });
    await settle(jobs, after.id);
    const revision = records(store).find((record) => record.id !== old!.id)!;
    expect(revision.manifest.revision).toMatchObject({ number: 2, reason: 'face_masking', note });
    // The manifest must not point back at the unmasked record, its manifest, or the capture holding the unmasked photos.
    expect(revision.manifest.revision).not.toHaveProperty('previousSpatialId');
    expect(revision.manifest.revision).not.toHaveProperty('previousManifestCid');
    expect(revision.manifest.revision).not.toHaveProperty('previousCaptureId');
    expect(JSON.stringify(revision.manifest)).not.toContain(old!.id);
    expect(JSON.stringify(revision.manifest)).not.toContain(old!.manifestCid);
    expect(JSON.stringify(revision.manifest)).not.toContain(first.id);

    // A further masked re-run is a plain re-solve: the earlier record was already masked.
    const again = await jobs.create('spatial.reconstruct', { captureId: masked.id, previousSpatialId: revision.id });
    await settle(jobs, again.id);
    expect(records(store).find((record) => record.manifest.revision.number === 3)!.manifest.revision).toMatchObject({ reason: 'resolve' });

    await expect(jobs.create('spatial.reconstruct', { captureId: masked.id, revisionNote: 'x'.repeat(201) })).rejects.toMatchObject({ code: 'job_revision_note_invalid' });
    await expect(jobs.create('spatial.reconstruct', { captureId: masked.id, revisionNote: 5 })).rejects.toMatchObject({ code: 'job_revision_note_invalid' });
  });

  it('never links a masked revision to an unmasked record, even when a video is added in the same step', async () => {
    const { dir, store, captures, jobs } = await setup();
    await writePhotos(path.join(dir, 'a'), 9);
    const legacy = await captures.importPhotoDirectory(path.join(dir, 'a'), { artworkId: 'art-1', maskFaces: false });
    const before = await jobs.create('spatial.reconstruct', { captureId: legacy.id });
    await settle(jobs, before.id);
    const [old] = records(store);
    const video = path.join(dir, 'later.mp4');
    await fs.writeFile(video, fakeMp4());
    const mixed = await captures.addVideoToCapture(legacy.id, video, {});
    const after = await jobs.create('spatial.reconstruct', { captureId: mixed.id });
    await settle(jobs, after.id);
    expect(jobs.get(after.id).state).toBe('completed');
    const revision = records(store).find((record) => record.id !== old!.id)!;
    expect(revision.manifest.revision).toEqual({ number: 2, reason: 'face_masking', inputs: { captureKind: 'mixed', photos: 9, video: true } });
    const text = JSON.stringify(revision.manifest);
    expect(text).not.toContain(old!.id);
    expect(text).not.toContain(old!.manifestCid);
    expect(text).not.toContain(legacy.id);
  });

  it('refuses a superseded record as the one to revise and never links a derived capture to it', async () => {
    const { dir, store, captures, jobs } = await setup();
    await writePhotos(path.join(dir, 'a'), 9);
    const base = await captures.importPhotoDirectory(path.join(dir, 'a'), { artworkId: 'art-1' });
    const first = await jobs.create('spatial.reconstruct', { captureId: base.id });
    await settle(jobs, first.id);
    const [old] = records(store);
    await store.update((state) => { (state.spatial as Record<string, { state: string }>)[old!.id]!.state = 'superseded'; });
    await expect(jobs.create('spatial.reconstruct', { captureId: base.id, previousSpatialId: old!.id })).rejects.toMatchObject({ statusCode: 422, code: 'previous_spatial_not_found' });
    const video = path.join(dir, 'later.mp4');
    await fs.writeFile(video, fakeMp4());
    const mixed = await captures.addVideoToCapture(base.id, video, {});
    const derived = await jobs.create('spatial.reconstruct', { captureId: mixed.id });
    expect(derived.input).not.toHaveProperty('previousSpatialId');
    await settle(jobs, derived.id);
  });

  it('refuses a revision note that carries the operator name, accents and case ignored', async () => {
    const { dir, captures, jobs } = await setup();
    await writePhotos(path.join(dir, 'a'), 9);
    const capture = await captures.importPhotoDirectory(path.join(dir, 'a'), { artworkId: 'art-1', capturedBy: 'Ada Exampl\u00e9 (aexample)' });
    for (const note of ['rerun for Ada Example', 'by EXAMPL\u00c9', 'handle aexample, provenance']) {
      await expect(jobs.create('spatial.reconstruct', { captureId: capture.id, revisionNote: note })).rejects.toMatchObject({ statusCode: 422, code: 'job_revision_note_names_operator' });
    }
    const ok = await jobs.create('spatial.reconstruct', { captureId: capture.id, revisionNote: 'face masking and provenance corrected' });
    expect(ok.input).toMatchObject({ revisionNote: 'face masking and provenance corrected' });
    await settle(jobs, ok.id);
    expect(noteNamesOperator('anything', undefined)).toBe(false);
    expect(noteNamesOperator('a dam in the mural', 'Dam Jan')).toBe(false);
  });

  it('does not accept a premasked report that names other weights than the pinned ones', async () => {
    const { dir, captures } = await setup();
    const source = path.join(dir, 'masked');
    const written = await writePhotos(source, 9);
    const report = reportFor(written, [0, 0, 0, 0, 0, 0, 0, 0, 0]);
    report.detector.weightsSha256 = 'c'.repeat(64);
    await fs.writeFile(path.join(source, FACE_MASKING_REPORT_NAME), JSON.stringify(report));
    await expect(captures.importPhotoDirectory(source, { artworkId: 'art-1' })).rejects.toMatchObject({ statusCode: 422, code: 'face_masking_report_unpinned' });
  });

  it('keeps the camera models of the operator out of the public derivation', () => {
    const open = publicDerivation({ photos: { count: 9, cameras: { 'Apple iPhone 16 Pro': 5 } }, splatCount: 5 }) as any;
    expect(open.photos).toEqual({ count: 9 });
    expect(open.splatCount).toBe(5);
  });

  it('records worker-masked parts as pinned and refuses a re-import that states different provenance', async () => {
    const { dir, store, captures, jobs } = await setup();
    await writePhotos(path.join(dir, 'a'), 9);
    const first = await captures.importPhotoDirectory(path.join(dir, 'a'), { artworkId: 'art-1', capturedBy: 'handle-one', capturedAt: '2026-08-17T03:59:31Z' });
    const retry = await captures.importPhotoDirectory(path.join(dir, 'a'), { artworkId: 'art-1', capturedBy: 'handle-one', capturedAt: '2026-08-17T03:59:31Z' });
    expect(retry.id).toBe(first.id);
    const quiet = await captures.importPhotoDirectory(path.join(dir, 'a'), { artworkId: 'art-1' });
    expect(quiet.id).toBe(first.id); // stating nothing is a plain retry
    await expect(captures.importPhotoDirectory(path.join(dir, 'a'), { artworkId: 'art-1', capturedBy: 'handle-two' }))
      .rejects.toMatchObject({ statusCode: 409, code: 'capture_exists_with_different_provenance', details: { differs: ['capturedBy'] } });
    await expect(captures.importPhotoDirectory(path.join(dir, 'a'), { artworkId: 'art-1', capturedBy: 'handle-one', capturedAt: '2026-08-18T03:59:31Z' }))
      .rejects.toMatchObject({ code: 'capture_exists_with_different_provenance', details: { differs: ['capturedAt'] } });
    expect(captures.get(first.id).capturedBy).toBe('handle-one');
    // The label is compared the way it was stored: padding around it is not a different operator.
    const padded = await captures.importPhotoDirectory(path.join(dir, 'a'), { artworkId: 'art-1', capturedBy: '  handle-one 	' });
    expect(padded.id).toBe(first.id);
    // A label over 200 characters is dropped on import (it stores nothing), so stating one cannot differ from it.
    const overlong = await captures.importPhotoDirectory(path.join(dir, 'a'), { artworkId: 'art-1', capturedBy: 'x'.repeat(201) });
    expect(overlong.id).toBe(first.id);
    const job = await jobs.create('spatial.reconstruct', { captureId: first.id });
    await settle(jobs, job.id);
    expect(records(store)[0]!.manifest.captureProvenance.derivation.faceMasking.photos.weightsPinned).toBe(true);
  });
});

describe('what a premasked report proves', () => {
  it('is operator-attested, and says whether it names the pinned weights', () => {
    const entry = { sha256: 'a'.repeat(64), regions: 0 };
    const report = (weightsSha256: string) => ({ schema: FACE_MASKING_REPORT_SCHEMA, detector: { name: 'YuNet', model: 'm', weightsSha256 }, images: [entry] });
    expect(summariseReport(report(PINNED_WEIGHTS_SHA256), ['a'.repeat(64)])).toMatchObject({ attestation: 'operator_report', weightsPinned: true });
    expect(summariseReport(report('c'.repeat(64)), ['a'.repeat(64)])).toMatchObject({ attestation: 'operator_report', weightsPinned: false });
  });

  it('keeps per-image and manual-list counts out of the public derivation', () => {
    const derivation = { faceMasking: { ran: true, photos: { source: 'worker', images: 2, regions: 1, imagesWithRegions: 1, regionsPerImage: [1, 0], manualAdded: 1, manualExcluded: 2, weightsPinned: true, attestation: 'operator_report' } }, splatCount: 5 };
    const open = publicDerivation(derivation) as any;
    expect(JSON.stringify(open)).not.toMatch(/regionsPerImage|manualAdded|manualExcluded/);
    expect(open.faceMasking.photos).toMatchObject({ source: 'worker', images: 2, regions: 1, weightsPinned: true, attestation: 'operator_report' });
    expect(open.splatCount).toBe(5);
  });

  it('accepts a face-masking revision with no link to the earlier record, and no other revision without one', () => {
    const base = {
      schema: 'kubus.spatial/1', type: 'gaussianSplat', id: 'x', artworkId: 'a', captureId: 'c', capturedAt: '2026-08-17T06:00:00Z',
      variants: [{ role: 'spatial_archive', cid: 'Qm', sizeBytes: 1, mimeType: 'application/octet-stream', format: 'ply', storageClass: 'cold' }],
      processing: { protocol: 'kubus.spatial-job/1', workerVersion: 'w', reconstruction: { engine: 'nerfstudio', method: 'splatfacto', iterations: 10, outputFormat: 'ply' } },
    };
    expect(() => validateSpatialManifest({ ...base, revision: { number: 2, reason: 'face_masking', inputs: { captureKind: 'photos' } } })).not.toThrow();
    expect(() => validateSpatialManifest({ ...base, revision: { number: 2, reason: 'resolve', inputs: { captureKind: 'photos' } } })).toThrow('spatial_manifest_revision_invalid');
  });
});

describe('superseding a spatial record', () => {
  const owners = (id: string) => `spatial:${id}`;

  async function stateWithTwoRecords(pinned = true) {
    const dir = await tempDir();
    const store = new LocalStore(path.join(dir, 'state.json'));
    await store.load();
    const removed: string[] = [];
    const kubo = {
      pinLs: async () => ({ Keys: {} }),
      pinAdd: async () => undefined,
      pinRm: async (cid: string) => { removed.push(cid); },
    };
    const manifest = (id: string, artworkId: string, cid: string) => ({
      schema: 'kubus.spatial/1', type: 'gaussianSplat', id, artworkId, captureId: `cap-${id}`, capturedAt: '2026-08-17T06:00:00Z',
      captureProvenance: { source: 'localCapture', captureId: `cap-${id}` },
      variants: [{ role: 'spatial_archive', cid, sizeBytes: 10, mimeType: 'application/octet-stream', format: 'ply', storageClass: 'cold' }],
      processing: { protocol: 'kubus.spatial-job/1', workerVersion: 'w', reconstruction: { engine: 'nerfstudio', method: 'splatfacto', iterations: 1000, outputFormat: 'ply' } },
      createdAt: '2026-11-22T10:00:00Z',
    });
    const oldCids = { manifest: syntheticCid('old-manifest'), splat: syntheticCid('old-splat') };
    const newCids = { manifest: syntheticCid('new-manifest'), splat: syntheticCid('new-splat') };
    await store.update((state) => {
      state.spatial = {
        old: { id: 'old', state: 'local', manifestCid: oldCids.manifest, manifest: manifest('old', 'art-1', oldCids.splat), createdAt: '2026-11-22T10:00:00.000Z', pinOwner: owners('old') },
        next: { id: 'next', state: 'local', manifestCid: newCids.manifest, manifest: manifest('next', 'art-1', newCids.splat), createdAt: '2026-11-22T12:00:00.000Z', pinOwner: owners('next') },
        other: { id: 'other', state: 'local', manifestCid: syntheticCid('o-m'), manifest: manifest('other', 'art-2', syntheticCid('o-s')), createdAt: '2026-11-22T12:00:00.000Z' },
      } as never;
    });
    if (pinned) {
      const pins = new ManagedPins(kubo as never, store);
      for (const cid of [oldCids.manifest, oldCids.splat]) await pins.acquire(cid, owners('old'));
      for (const cid of [newCids.manifest, newCids.splat]) await pins.acquire(cid, owners('next'));
    }
    return { dir, store, kubo, removed, oldCids, newCids };
  }

  it('marks the old record superseded, unpins only its content and leaves the new record pinned', async () => {
    const { store, kubo, removed, oldCids, newCids } = await stateWithTwoRecords();
    const result = await supersedeSpatialRecord({ store, kubo: kubo as never }, 'old', 'next');
    expect(result).toMatchObject({ id: 'old', state: 'superseded', supersededBy: 'next' });
    expect(result.released.map((item) => item.pinRemoved)).toEqual([true, true]);
    expect(removed.sort()).toEqual([oldCids.manifest, oldCids.splat].map(canonicalPinCid).sort());
    expect(removed).not.toContain(canonicalPinCid(newCids.splat));
    const spatial = store.snapshot().spatial as Record<string, { state: string; supersededBy?: string; supersededAt?: string }>;
    expect(spatial.old).toMatchObject({ state: 'superseded', supersededBy: 'next' });
    expect(spatial.old!.supersededAt).toBeTruthy();
    expect(spatial.next!.state).toBe('local');
    expect(store.snapshot().managedPins![canonicalPinCid(oldCids.splat)]).toMatchObject({ state: 'released' });
    expect(store.snapshot().managedPins![canonicalPinCid(newCids.splat)]).toMatchObject({ state: 'pinned' });
  });

  it('says so when the replacement does not record face masking, and stays quiet when it does', async () => {
    const { store, kubo } = await stateWithTwoRecords();
    const unmasked = await supersedeSpatialRecord({ store, kubo: kubo as never }, 'old', 'next');
    expect(unmasked.warnings).toEqual(['replacement_not_face_masked']);
    const again = await stateWithTwoRecords();
    await again.store.update((state) => {
      const next = (state.spatial as Record<string, { manifest: { captureProvenance: Record<string, unknown> } }>).next!;
      next.manifest.captureProvenance.derivation = { faceMasking: { ran: true } };
    });
    const masked = await supersedeSpatialRecord({ store: again.store, kubo: again.kubo as never }, 'old', 'next');
    expect(masked).not.toHaveProperty('warnings');
  });

  it('is idempotent and refuses unsuitable replacements', async () => {
    const { store, kubo, removed } = await stateWithTwoRecords();
    await supersedeSpatialRecord({ store, kubo: kubo as never }, 'old', 'next');
    const count = removed.length;
    await expect(supersedeSpatialRecord({ store, kubo: kubo as never }, 'old', 'next')).resolves.toMatchObject({ state: 'superseded' });
    expect(removed).toHaveLength(count);
    await expect(supersedeSpatialRecord({ store, kubo: kubo as never }, 'old', 'other')).rejects.toMatchObject({ code: 'spatial_supersede_artwork_mismatch' });
    await expect(supersedeSpatialRecord({ store, kubo: kubo as never }, 'old', 'old')).rejects.toMatchObject({ code: 'spatial_supersede_self' });
    await expect(supersedeSpatialRecord({ store, kubo: kubo as never }, 'missing', 'next')).rejects.toMatchObject({ code: 'spatial_record_not_found' });
    await expect(supersedeSpatialRecord({ store, kubo: kubo as never }, 'next', 'missing')).rejects.toMatchObject({ code: 'spatial_replacement_not_found' });
    // The replacement must be newer, and not itself superseded.
    await expect(supersedeSpatialRecord({ store, kubo: kubo as never }, 'next', 'old')).rejects.toMatchObject({ code: expect.stringMatching(/spatial_replacement_(unavailable|not_newer)/) });
  });

  it('never removes a pin it does not own', async () => {
    const { store, kubo, removed, oldCids } = await stateWithTwoRecords(false);
    // Pinned before this Node managed it: the ledger says preexisting, so it is kept.
    const ownedElsewhere = { ...kubo, pinLs: async () => ({ Keys: { [oldCids.splat]: { Type: 'recursive' } } }) };
    const pins = new ManagedPins(ownedElsewhere as never, store);
    await pins.acquire(oldCids.splat, owners('old'));
    await pins.acquire(oldCids.manifest, owners('old'));
    const result = await supersedeSpatialRecord({ store, kubo: kubo as never }, 'old', 'next');
    expect(removed).toEqual([canonicalPinCid(oldCids.manifest)]);
    expect(result.released.find((item) => item.cid === oldCids.splat)).toMatchObject({ pinRemoved: false, reason: 'preexisting_or_unknown_pin' });
  });

  it('says how many root blocks of the superseded record are still stored', async () => {
    const { store, kubo, oldCids } = await stateWithTwoRecords();
    const present = new Set([oldCids.manifest, oldCids.splat]);
    const result = await supersedeSpatialRecord({ store, kubo: { ...kubo, blockPresent: async (cid: string) => present.has(cid) } as never }, 'old', 'next');
    expect(result.blocksStillStored).toBe(2);
    const cold = await supersedeSpatialRecord({ store, kubo: { ...kubo, blockPresent: async () => false } as never }, 'old', 'next');
    expect(cold.blocksStillStored).toBe(0);
  });

  it('finds and removes exactly the blocks of superseded records, children first, and keeps what stays pinned', async () => {
    const { store, kubo, oldCids, newCids } = await stateWithTwoRecords();
    await supersedeSpatialRecord({ store, kubo: kubo as never }, 'old', 'next');
    const children = ['child-a', 'child-b', 'shared'].map(syntheticCid);
    const stored = new Set([oldCids.manifest, oldCids.splat, newCids.manifest, newCids.splat, ...children]);
    const order: string[] = [];
    const fake = {
      blockPresent: async (cid: string) => stored.has(cid),
      refsLocal: async (cid: string) => (cid === oldCids.splat ? [cid, ...children] : [cid]),
      blockRm: async (cids: string[]) => cids.map((cid) => {
        order.push(cid);
        if (cid === children[2]) return { cid, error: 'pinned: indirect through another record' };
        stored.delete(cid);
        return { cid };
      }),
    };
    const report = await findSupersededContent({ store, kubo: fake });
    expect(report).toMatchObject({ present: 2, records: [{ id: 'old' }] });
    const purged = await purgeSupersededContent({ store, kubo: fake });
    expect(purged.records).toEqual([{ id: 'old', blocksRemoved: 4, blocksKept: 1, keptReason: 'pinned: indirect through another record' }]);
    // Children before the root of each archive, and nothing of the current record is touched.
    expect(order.indexOf(oldCids.splat)).toBeGreaterThan(order.indexOf(children[0]!));
    expect(order).not.toContain(newCids.manifest);
    expect(order).not.toContain(newCids.splat);
    expect(stored.has(newCids.splat)).toBe(true);
    // A shared block that could not be removed keeps the record flagged as not purged; the roots are gone.
    expect((store.snapshot().spatial as Record<string, { contentPurgedAt?: string }>).old!.contentPurgedAt).toBeUndefined();
    expect(await findSupersededContent({ store, kubo: fake })).toMatchObject({ present: 0 });
    const again = await purgeSupersededContent({ store, kubo: fake });
    expect(again.blocksRemoved).toBe(0);
  });

  it('warns at start-up while superseded content is still stored, and never throws', async () => {
    const { store, kubo, oldCids } = await stateWithTwoRecords();
    await supersedeSpatialRecord({ store, kubo: kubo as never }, 'old', 'next');
    const warn = vi.fn();
    await warnAboutSupersededContent({ store, kubo: { blockPresent: async (cid: string) => cid === oldCids.splat }, logger: { warn } });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]![1])).toContain('purge-superseded');
    warn.mockClear();
    await warnAboutSupersededContent({ store, kubo: { blockPresent: async () => false }, logger: { warn } });
    expect(warn).not.toHaveBeenCalled();
    await warnAboutSupersededContent({ store, kubo: { blockPresent: async () => { throw new Error('kubo down'); } }, logger: { warn } });
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('refuses to retire a record that was offered to a backend, and accepts a replacement that was', async () => {
    const { store, kubo } = await stateWithTwoRecords();
    await store.update((state) => { (state.spatial as Record<string, { state: string }>).old!.state = 'publication_requested'; });
    await expect(supersedeSpatialRecord({ store, kubo: kubo as never }, 'old', 'next')).rejects.toMatchObject({ statusCode: 409, code: 'spatial_publication_active' });
    expect((store.snapshot().spatial as Record<string, { state: string }>).old!.state).toBe('publication_requested');
    await store.update((state) => {
      const spatial = state.spatial as Record<string, { state: string }>;
      spatial.old!.state = 'local';
      spatial.next!.state = 'publication_requested';
    });
    await expect(supersedeSpatialRecord({ store, kubo: kubo as never }, 'old', 'next')).resolves.toMatchObject({ state: 'superseded', supersededBy: 'next' });
  });

  it('does not call a record purged while a root is still in the store, and does not read a Kubo error as absent', async () => {
    const { store, kubo, oldCids } = await stateWithTwoRecords();
    await supersedeSpatialRecord({ store, kubo: kubo as never }, 'old', 'next');
    const stubborn = {
      blockPresent: async () => true,
      refsLocal: async (cid: string) => [cid],
      blockRm: async (cids: string[]) => cids.map((cid) => ({ cid })), // claims success, the block stays
    };
    const result = await purgeSupersededContent({ store, kubo: stubborn });
    expect(result.records[0]).toMatchObject({ id: 'old', blocksKept: 2, keptReason: expect.stringContaining('still in the store') });
    expect((store.snapshot().spatial as Record<string, { contentPurgedAt?: string }>).old!.contentPurgedAt).toBeUndefined();
    expect(oldCids.manifest).toBeTruthy();
    const broken = { ...stubborn, blockPresent: async () => { throw new Error('Kubo block/stat failed with HTTP 500: datastore is locked'); } };
    await expect(purgeSupersededContent({ store, kubo: broken })).rejects.toThrow('datastore is locked');
  });

  it('is no longer served', async () => {
    const { store, kubo } = await stateWithTwoRecords();
    await supersedeSpatialRecord({ store, kubo: kubo as never }, 'old', 'next');
    const res = { writeHead: () => undefined, end: () => undefined, on: () => undefined } as never;
    await expect(serveSpatialVariant({ headers: {} } as never, res, { store, kubo: {} as never }, 'old', 'spatial_archive')).rejects.toMatchObject({ statusCode: 410, code: 'spatial_record_superseded' });
  });
});
