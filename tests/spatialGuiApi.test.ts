import { EventEmitter } from 'node:events';
import { promises as fs } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CaptureStore } from '../src/captures/captureStore.js';
import type { KuboClient } from '../src/ipfs/kuboClient.js';
import { LocalStore } from '../src/state/localStore.js';
import {
  getCaptureSummary,
  getSpatialRecord,
  listCaptureSummaries,
  listSpatialSummaries,
  serveCaptureFile,
  serveSpatialVariant,
} from '../src/gui/spatialGuiApi.js';

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

async function tempStore(): Promise<{ dir: string; store: LocalStore }> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'kubus-gui-api-'));
  dirs.push(dir);
  const store = new LocalStore(path.join(dir, 'state.json'));
  await store.load();
  return { dir, store };
}

function fakeManifest(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    schema: 'kubus.spatial/1',
    type: 'gaussianSplat',
    id: 'spatial-1',
    artworkId: 'artwork-1',
    captureId: 'capture-1',
    capturedAt: '2026-08-01T00:00:00.000Z',
    variants: [
      { role: 'spatial_archive', cid: 'bafybeigdyrztzudirp3ybneu4qwfrmagwo3ye25qmqu4vpvzjqe4prc7lm', sizeBytes: 100, mimeType: 'application/octet-stream', format: 'ply', storageClass: 'cold' },
    ],
    processing: { protocol: 'kubus.spatial-job/1', workerVersion: 'kubus-spatial-worker/1', reconstruction: { engine: 'nerfstudio', method: 'splatfacto', iterations: 15000, outputFormat: 'ply' } },
    createdAt: '2026-08-01T00:05:00.000Z',
    ...overrides,
  };
}

describe('listSpatialSummaries / getSpatialRecord', () => {
  it('summarizes a spatial record without exposing raw filesystem detail', async () => {
    const { store } = await tempStore();
    const manifest = fakeManifest();
    await store.update((state) => {
      (state.spatial ??= {})['spatial-1'] = { id: 'spatial-1', state: 'local', manifestCid: 'bafyManifestCid', manifest, createdAt: manifest.createdAt };
    });

    const summaries = listSpatialSummaries(store);
    expect(summaries).toHaveLength(1);
    expect(summaries[0]).toMatchObject({
      id: 'spatial-1',
      artworkId: 'artwork-1',
      captureId: 'capture-1',
      manifestCid: 'bafyManifestCid',
    });
    expect(summaries[0]!.variants).toEqual([
      { role: 'spatial_archive', format: 'ply', mimeType: 'application/octet-stream', sizeBytes: 100, storageClass: 'cold' },
    ]);
    // No `directory`/filesystem path anywhere in the summary.
    expect(JSON.stringify(summaries[0])).not.toMatch(/[A-Za-z]:\\|\/tmp\//);
  });

  it('throws a typed 404 for an unknown id', async () => {
    const { store } = await tempStore();
    expect(() => getSpatialRecord(store, 'missing')).toThrow('spatial_not_found');
  });

  it('ignores malformed entries instead of crashing the listing', async () => {
    const { store } = await tempStore();
    await store.update((state) => {
      (state.spatial ??= {})['broken'] = { not: 'a spatial record' };
    });
    expect(listSpatialSummaries(store)).toEqual([]);
  });
});

describe('listCaptureSummaries / getCaptureSummary', () => {
  it('lists real captures newest first', async () => {
    const { dir, store } = await tempStore();
    const captures = new CaptureStore(dir, store);
    const first = await captures.create({ schema: 'kubus.capture/1', artworkId: 'a1', capturedAt: '2026-08-01T00:00:00Z', metadata: {}, files: [{ path: 'rgb/0.jpg', contentBase64: Buffer.from('a').toString('base64') }] });
    await new Promise((resolve) => setTimeout(resolve, 5));
    const second = await captures.create({ schema: 'kubus.capture/1', artworkId: 'a2', capturedAt: '2026-08-02T00:00:00Z', metadata: {}, files: [{ path: 'rgb/0.jpg', contentBase64: Buffer.from('b').toString('base64') }] });

    const summaries = listCaptureSummaries(captures);
    expect(summaries.map((c) => c.id)).toEqual([second.id, first.id]);
    expect(getCaptureSummary(captures, first.id).id).toBe(first.id);
  });
});

describe('serveCaptureFile', () => {
  let dir: string;
  let store: LocalStore;
  let captures: CaptureStore;

  beforeEach(async () => {
    ({ dir, store } = await tempStore());
    captures = new CaptureStore(dir, store);
  });

  function fakeRes() {
    const emitter = new EventEmitter() as EventEmitter & { statusCode: number; headers: Record<string, unknown> };
    emitter.statusCode = 0;
    emitter.headers = {};
    return Object.assign(emitter, {
      writeHead: (status: number, hdrs: Record<string, unknown>) => { emitter.statusCode = status; emitter.headers = hdrs; },
      write: () => true,
      end: () => undefined,
    }) as unknown as ServerResponse & { statusCode: number; headers: Record<string, unknown> };
  }

  it('streams a real frame file with the right content type and length', async () => {
    const capture = await captures.create({
      schema: 'kubus.capture/1', artworkId: 'a1', capturedAt: '2026-08-01T00:00:00Z', metadata: {},
      files: [{ path: 'rgb/00000.jpg', contentBase64: Buffer.from([0xff, 0xd8, 0xff, 0xd9]).toString('base64') }],
    });

    const res = fakeRes();
    await serveCaptureFile(res, { captures }, capture.id, 'rgb/00000.jpg');
    expect(res.statusCode).toBe(200);
    expect(res.headers['Content-Type']).toBe('image/jpeg');
    expect(res.headers['Content-Length']).toBe('4');
  });

  it('rejects a path-traversal attempt without touching the filesystem', async () => {
    const capture = await captures.create({
      schema: 'kubus.capture/1', artworkId: 'a1', capturedAt: '2026-08-01T00:00:00Z', metadata: {},
      files: [{ path: 'rgb/00000.jpg', contentBase64: Buffer.from([0xff]).toString('base64') }],
    });
    const res = fakeRes();
    await expect(serveCaptureFile(res, { captures }, capture.id, '../../../etc/passwd')).rejects.toThrow('capture_file_path_invalid');
    // A leading slash is stripped (same convention as captureStore.ts's own
    // safeRelativePath), so this resolves *inside* the capture directory -
    // not a traversal, just a path that does not exist there.
    await expect(serveCaptureFile(res, { captures }, capture.id, '/etc/passwd')).rejects.toThrow('capture_file_not_found');
  });

  it('404s for a file not actually in the capture', async () => {
    const capture = await captures.create({
      schema: 'kubus.capture/1', artworkId: 'a1', capturedAt: '2026-08-01T00:00:00Z', metadata: {},
      files: [{ path: 'rgb/00000.jpg', contentBase64: Buffer.from([0xff]).toString('base64') }],
    });
    const res = fakeRes();
    await expect(serveCaptureFile(res, { captures }, capture.id, 'rgb/99999.jpg')).rejects.toThrow('capture_file_not_found');
  });
});

describe('serveSpatialVariant', () => {
  let store: LocalStore;
  const cid = 'bafybeigdyrztzudirp3ybneu4qwfrmagwo3ye25qmqu4vpvzjqe4prc7lm';
  const bytes = Buffer.from('0123456789abcdef');

  beforeEach(async () => {
    ({ store } = await tempStore());
    const manifest = fakeManifest({ variants: [{ role: 'spatial_archive', cid, sizeBytes: bytes.length, mimeType: 'application/octet-stream', format: 'ply', storageClass: 'cold' }] });
    await store.update((state) => {
      (state.spatial ??= {})['spatial-1'] = { id: 'spatial-1', state: 'local', manifestCid: 'bafyManifestCid', manifest, createdAt: manifest.createdAt };
    });
  });

  function fakeKubo(onCatStream: (cid: string, range?: { offset: number; length: number }) => Uint8Array): KuboClient {
    return {
      catStream: async (requestedCid: string, range?: { offset: number; length: number }) => {
        const slice = onCatStream(requestedCid, range);
        return { body: new Response(new Blob([slice as BlobPart])).body!, cancel: () => undefined };
      },
    } as unknown as KuboClient;
  }

  function fakeReqRes(rangeHeader?: string) {
    const req = { headers: { range: rangeHeader } } as IncomingMessage;
    const emitter = new EventEmitter() as EventEmitter & { statusCode: number; headers: Record<string, unknown> };
    emitter.statusCode = 0;
    emitter.headers = {};
    const res = Object.assign(emitter, {
      writeHead: (status: number, hdrs: Record<string, unknown>) => { emitter.statusCode = status; emitter.headers = hdrs; },
      write: () => true,
      end: () => undefined,
    }) as unknown as ServerResponse & { statusCode: number; headers: Record<string, unknown> };
    return { req, res };
  }

  it('streams the whole variant when no Range header is present', async () => {
    const kubo = fakeKubo(() => bytes);
    const { req, res } = fakeReqRes();
    await serveSpatialVariant(req, res, { store, kubo }, 'spatial-1', 'spatial_archive');
    expect((res as unknown as { statusCode: number }).statusCode).toBe(200);
  });

  it('answers a valid Range request with 206 and a correct Content-Range', async () => {
    const kubo = fakeKubo((_cid, range) => bytes.subarray(range!.offset, range!.offset + range!.length));
    const { req, res } = fakeReqRes('bytes=2-5');
    await serveSpatialVariant(req, res, { store, kubo }, 'spatial-1', 'spatial_archive');
    const typed = res as unknown as { statusCode: number; headers: Record<string, unknown> };
    expect(typed.statusCode).toBe(206);
    expect(typed.headers['Content-Range']).toBe(`bytes 2-5/${bytes.length}`);
    expect(typed.headers['Content-Length']).toBe('4');
  });

  it('answers an open-ended suffix Range request (bytes=-N)', async () => {
    const kubo = fakeKubo((_cid, range) => bytes.subarray(range!.offset, range!.offset + range!.length));
    const { req, res } = fakeReqRes('bytes=-4');
    await serveSpatialVariant(req, res, { store, kubo }, 'spatial-1', 'spatial_archive');
    const typed = res as unknown as { statusCode: number; headers: Record<string, unknown> };
    expect(typed.statusCode).toBe(206);
    expect(typed.headers['Content-Range']).toBe(`bytes 12-15/${bytes.length}`);
  });

  it('responds 416 for a range beyond the end of the file', async () => {
    const kubo = fakeKubo(() => bytes);
    const { req, res } = fakeReqRes(`bytes=${bytes.length + 10}-${bytes.length + 20}`);
    await serveSpatialVariant(req, res, { store, kubo }, 'spatial-1', 'spatial_archive');
    const typed = res as unknown as { statusCode: number; headers: Record<string, unknown> };
    expect(typed.statusCode).toBe(416);
    expect(typed.headers['Content-Range']).toBe(`bytes */${bytes.length}`);
  });

  it('404s for a variant role that does not exist on the record', async () => {
    const kubo = fakeKubo(() => bytes);
    const { req, res } = fakeReqRes();
    await expect(serveSpatialVariant(req, res, { store, kubo }, 'spatial-1', 'spatial_preview')).rejects.toThrow('spatial_variant_not_found');
  });
});
