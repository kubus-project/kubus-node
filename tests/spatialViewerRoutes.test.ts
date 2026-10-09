import { promises as fs } from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AppConfig } from '../src/config/schema.js';
import { startGuiServer, type GuiServerHandle } from '../src/gui/guiServer.js';
import { ViewerCapabilities } from '../src/gui/viewerCapabilities.js';
import { redactSecrets } from '../src/logging/logBuffer.js';
import { ActionLock } from '../src/runtime/actionLock.js';
import { LocalStore } from '../src/state/localStore.js';

/**
 * The Spatial viewer's capability routes, exercised over real sockets against a
 * real GUI server. Only Kubo is faked, and the fake keeps Kubo's offset/length
 * semantics; tests/spatialKubo.integration.test.ts checks those against a real one.
 */

const GUI_TOKEN = 'gui-secret-for-tests';
const cid = (tag: string) => `bafy${tag.padEnd(50, 'a')}`;

const pattern = (length: number, seed: number) => Buffer.from(Array.from({ length }, (_, index) => (index * 7 + seed) % 251));

const PREVIEW_A = pattern(300, 1);
const PREVIEW_B = pattern(300, 99);
const ARCHIVE_A = pattern(5000, 3);
const RAD_ENTRY = pattern(64, 5);
const RAD_CHUNK_0 = pattern(120, 6);
const RAD_CHUNK_1 = pattern(90, 7);

class FakeKubo {
  readonly files = new Map<string, Buffer>();
  readonly bundles = new Map<string, Map<string, { hash: string; bytes: Buffer }>>();
  readonly catCalls: Array<{ cid: string; range?: { offset: number; length: number }; inner?: string }> = [];
  readonly statCalls: Array<{ root: string; name: string }> = [];
  failCat = false;

  async fileStat(root: string, name: string) {
    this.statCalls.push({ root, name });
    const file = this.bundles.get(root)?.get(name);
    return file ? { hash: file.hash, sizeBytes: file.bytes.length, type: 'file' as const } : null;
  }

  async catStream(target: string, range?: { offset: number; length: number }, inner?: string) {
    this.catCalls.push({ cid: target, range, inner });
    if (this.failCat) throw new Error('kubo unavailable');
    const bytes = inner === undefined ? this.files.get(target) : this.bundles.get(target)?.get(inner)?.bytes;
    if (!bytes) throw new Error('not found');
    const slice = range ? bytes.subarray(range.offset, range.offset + range.length) : bytes;
    const half = Math.ceil(slice.length / 2);
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        // Two chunks, so a route that only handled single-chunk bodies would show.
        controller.enqueue(new Uint8Array(slice.subarray(0, half)));
        if (slice.length > half) controller.enqueue(new Uint8Array(slice.subarray(half)));
        controller.close();
      },
    });
    return { body, cancel: () => undefined };
  }
}

const variant = (role: string, extra: Record<string, unknown>) => ({
  role, sizeBytes: 1, mimeType: 'application/octet-stream', format: 'bin',
  storageClass: ({ spatial_preview: 'hot', spatial_mobile: 'warm', spatial_archive: 'cold' } as Record<string, string>)[role], ...extra,
});

function manifest(id: string, variants: unknown[]) {
  return {
    schema: 'kubus.spatial/1', type: 'gaussianSplat', id, artworkId: 'artwork-1', captureId: `capture-${id}`,
    captureProvenance: { source: 'localCapture', captureId: `capture-${id}` }, capturedAt: '2026-08-01T00:00:00.000Z',
    variants,
    processing: { protocol: 'kubus.spatial-job/1', workerVersion: 'kubus-spatial-worker/2', reconstruction: { engine: 'nerfstudio', method: 'splatfacto', iterations: 15000, outputFormat: 'ply' } },
    createdAt: '2026-08-01T00:05:00.000Z',
  };
}

interface Harness {
  server: GuiServerHandle;
  origin: string;
  kubo: FakeKubo;
  store: LocalStore;
  capabilities: ViewerCapabilities;
  logged: string[];
  clock: { now: number };
}

const dirs: string[] = [];
const servers: GuiServerHandle[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
  await Promise.all(dirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

async function harness(options: { maxActive?: number; idleTtlMs?: number; maxLifetimeMs?: number; guiEnabled?: boolean } = {}): Promise<Harness> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'kubus-viewer-routes-'));
  dirs.push(dir);
  const store = new LocalStore(path.join(dir, 'state.json'));
  await store.load();

  const kubo = new FakeKubo();
  kubo.files.set(cid('previewA'), PREVIEW_A);
  kubo.files.set(cid('previewB'), PREVIEW_B);
  kubo.files.set(cid('archiveA'), ARCHIVE_A);
  kubo.bundles.set(cid('radA'), new Map([
    ['scene.rad', { hash: cid('hentry'), bytes: RAD_ENTRY }],
    ['scene-0.radc', { hash: cid('hchunk0'), bytes: RAD_CHUNK_0 }],
    ['scene-1.radc', { hash: cid('hchunk1'), bytes: RAD_CHUNK_1 }],
  ]));

  await store.update((state) => {
    const spatial = (state.spatial ??= {}) as Record<string, unknown>;
    const record = (id: string, variants: unknown[]) => {
      const m = manifest(id, variants);
      spatial[id] = { id, state: 'local', manifestCid: cid(`manifest${id}`), manifest: m, createdAt: m.createdAt };
    };
    record('scene-a', [
      variant('spatial_preview', { cid: cid('previewA'), sizeBytes: PREVIEW_A.length, format: 'spz', mimeType: 'application/octet-stream' }),
      variant('spatial_mobile', { rootCid: cid('radA'), entrypoint: 'scene.rad', fileCount: 3, sizeBytes: RAD_ENTRY.length + RAD_CHUNK_0.length + RAD_CHUNK_1.length, format: 'rad' }),
      variant('spatial_archive', { cid: cid('archiveA'), sizeBytes: ARCHIVE_A.length, format: 'ply' }),
    ]);
    record('scene-b', [variant('spatial_preview', { cid: cid('previewB'), sizeBytes: PREVIEW_B.length, format: 'spz' })]);
    record('scene-archive-only', [variant('spatial_archive', { cid: cid('archiveA'), sizeBytes: ARCHIVE_A.length, format: 'ply' })]);
  });

  const clock = { now: 1_000_000 };
  const capabilities = new ViewerCapabilities({ now: () => clock.now, maxActive: options.maxActive, idleTtlMs: options.idleTtlMs, maxLifetimeMs: options.maxLifetimeMs });
  const logged: string[] = [];
  const record = (...args: unknown[]) => { logged.push(JSON.stringify(args)); };
  const server = await startGuiServer({
    api: { getHealth: async () => ({ ok: true }) } as never,
    kubo: kubo as never,
    store,
    config: {
      guiHost: '127.0.0.1', guiAllowRemote: false, guiToken: GUI_TOKEN, guiEnabled: options.guiEnabled ?? true, guiPort: 0,
      localApiEnabled: false, apiBaseUrl: 'http://api.test', ipfsGatewayUrl: 'http://127.0.0.1:8080', cidClassFilters: [],
    } as unknown as AppConfig,
    logger: { info: record, warn: record, error: record, debug: record } as never,
    actionLock: new ActionLock(),
    viewerCapabilities: capabilities,
  });
  servers.push(server);
  return { server, origin: new URL(server.url).origin, kubo, store, capabilities, logged, clock };
}

interface RawResponse { status: number; headers: http.IncomingHttpHeaders; body: Buffer }

/** A request with the path sent exactly as given: fetch() would normalise `..` away. */
function raw(origin: string, method: string, rawPath: string, headers: Record<string, string> = {}): Promise<RawResponse> {
  const url = new URL(origin);
  return new Promise((resolve, reject) => {
    const req = http.request({ host: url.hostname, port: url.port, method, path: rawPath, headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.on('error', reject);
    req.end();
  });
}

const auth = { Authorization: `Bearer ${GUI_TOKEN}` };

async function ticket(h: Harness, spatialId: string, body: Record<string, unknown> = {}) {
  const response = await fetch(`${h.origin}/gui/api/spatial/${spatialId}/viewer-ticket`, {
    method: 'POST', headers: { ...auth, 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  return { response, json: await response.json() as { success: boolean; data?: { representations: Array<{ role: string; url: string; bundle: boolean; format: string; sizeBytes: number; expiresAt: string }>; archiveOnly: boolean; archive?: { sizeBytes: number; format: string } }; error?: string; code?: string } };
}

const tokenOf = (url: string) => url.split('/')[3]!;

describe('viewer ticket endpoint', () => {
  it('is behind the GUI credential', async () => {
    const h = await harness();
    const none = await fetch(`${h.origin}/gui/api/spatial/scene-a/viewer-ticket`, { method: 'POST' });
    expect(none.status).toBe(401);
    const wrong = await fetch(`${h.origin}/gui/api/spatial/scene-a/viewer-ticket`, { method: 'POST', headers: { Authorization: 'Bearer nope' } });
    expect(wrong.status).toBe(401);
    expect(h.capabilities.size()).toBe(0);
  });

  it('issues preview first, then the runtime bundle, and never the archive by default', async () => {
    const h = await harness();
    const { response, json } = await ticket(h, 'scene-a');
    expect(response.status).toBe(201);
    expect(response.headers.get('cache-control')).toBe('no-store');
    const reps = json.data!.representations;
    expect(reps.map((rep) => rep.role)).toEqual(['spatial_preview', 'spatial_mobile']);
    expect(reps[0]).toMatchObject({ format: 'spz', bundle: false, sizeBytes: PREVIEW_A.length });
    expect(reps[1]).toMatchObject({ format: 'rad', bundle: true });
    expect(reps[0]!.url).toMatch(/^\/gui\/content\/[A-Za-z0-9_-]{43}\/preview\.spz$/);
    expect(reps[1]!.url).toMatch(/^\/gui\/content\/[A-Za-z0-9_-]{43}\/scene\.rad$/);
    expect(json.data!.archiveOnly).toBe(false);
    // The archive is advertised so the UI can offer it, but no URL is minted for it.
    expect(json.data!.archive).toEqual({ sizeBytes: ARCHIVE_A.length, format: 'ply' });
    expect(JSON.stringify(json)).not.toContain(cid('archiveA'));
    expect(h.capabilities.size()).toBe(2);
  });

  it('hands the viewer its capability URL intact (the one response that is not redacted)', async () => {
    const h = await harness();
    const { json } = await ticket(h, 'scene-a');
    const url = json.data!.representations[0]!.url;
    expect(url).not.toContain('[redacted]');
    const content = await raw(h.origin, 'GET', url);
    expect(content.status).toBe(200);
  });

  it('opens the archive only when the caller names it', async () => {
    const h = await harness();
    const { response, json } = await ticket(h, 'scene-a', { role: 'spatial_archive' });
    expect(response.status).toBe(201);
    expect(json.data!.representations.map((rep) => rep.role)).toEqual(['spatial_archive']);
    const content = await raw(h.origin, 'GET', json.data!.representations[0]!.url);
    expect(content.status).toBe(200);
    expect(content.body.equals(ARCHIVE_A)).toBe(true);
  });

  it('reports a scene that has only its archive without minting anything for it', async () => {
    const h = await harness();
    const { json } = await ticket(h, 'scene-archive-only');
    expect(json.data!.representations).toEqual([]);
    expect(json.data!.archiveOnly).toBe(true);
    expect(h.capabilities.size()).toBe(0);
  });

  it('rejects an unknown scene, an unknown role and a malformed role', async () => {
    const h = await harness();
    expect((await ticket(h, 'no-such-scene')).response.status).toBe(404);
    expect((await ticket(h, 'scene-b', { role: 'spatial_archive' })).response.status).toBe(404);
    const bad = await ticket(h, 'scene-a', { role: 42 });
    expect(bad.response.status).toBe(400);
    expect(bad.json.code).toBe('viewer_role_invalid');
    expect(h.capabilities.size()).toBe(0);
  });

  it('revokes every grant for a scene, and only that scene, when the operator asks', async () => {
    const h = await harness();
    const a = (await ticket(h, 'scene-a')).json.data!.representations;
    const b = (await ticket(h, 'scene-b')).json.data!.representations;
    const unauthenticated = await fetch(`${h.origin}/gui/api/spatial/scene-a/viewer-ticket`, { method: 'DELETE' });
    expect(unauthenticated.status).toBe(401);
    expect((await raw(h.origin, 'GET', a[0]!.url)).status).toBe(200);

    const revoked = await fetch(`${h.origin}/gui/api/spatial/scene-a/viewer-ticket`, { method: 'DELETE', headers: auth });
    expect(((await revoked.json()) as { data: { revoked: number } }).data.revoked).toBe(2);
    expect((await raw(h.origin, 'GET', a[0]!.url)).status).toBe(404);
    expect((await raw(h.origin, 'GET', a[1]!.url)).status).toBe(404);
    expect((await raw(h.origin, 'GET', b[0]!.url)).status).toBe(200);
  });
});

describe('viewer content route', () => {
  let h: Harness;
  let preview: string;
  let rad: string;

  beforeEach(async () => {
    h = await harness();
    const reps = (await ticket(h, 'scene-a')).json.data!.representations;
    preview = reps[0]!.url;
    rad = reps[1]!.url;
  });

  it('serves a single file with the exact bytes and the expected headers, without the GUI credential', async () => {
    const response = await raw(h.origin, 'GET', preview);
    expect(response.status).toBe(200);
    expect(response.body.equals(PREVIEW_A)).toBe(true);
    expect(response.headers['content-length']).toBe(String(PREVIEW_A.length));
    expect(response.headers['accept-ranges']).toBe('bytes');
    expect(response.headers['content-type']).toBe('application/octet-stream');
    expect(response.headers['x-content-type-options']).toBe('nosniff');
    expect(response.headers['etag']).toBe(`"${cid('previewA')}"`);
    expect(response.headers['cache-control']).toContain('private');
  });

  it('serves a bundle entry and each of its chunks by name, from inside the bundle only', async () => {
    const entry = await raw(h.origin, 'GET', rad);
    expect(entry.status).toBe(200);
    expect(entry.body.equals(RAD_ENTRY)).toBe(true);
    expect(h.kubo.catCalls.at(-1)).toMatchObject({ cid: cid('radA'), inner: 'scene.rad' });

    const base = rad.slice(0, rad.lastIndexOf('/'));
    const chunk = await raw(h.origin, 'GET', `${base}/scene-1.radc`);
    expect(chunk.status).toBe(200);
    expect(chunk.body.equals(RAD_CHUNK_1)).toBe(true);
    expect(chunk.headers['content-length']).toBe(String(RAD_CHUNK_1.length));
    expect(chunk.headers['etag']).toBe(`"${cid('hchunk1')}"`);
    // Only the entry carries the declared type; a chunk is opaque bytes.
    expect(chunk.headers['content-type']).toBe('application/octet-stream');
  });

  it('answers HEAD with the headers and no body, without reading the content', async () => {
    const before = h.kubo.catCalls.length;
    const head = await raw(h.origin, 'HEAD', preview);
    expect(head.status).toBe(200);
    expect(head.body.length).toBe(0);
    expect(head.headers['content-length']).toBe(String(PREVIEW_A.length));
    expect(head.headers['accept-ranges']).toBe('bytes');
    expect(h.kubo.catCalls.length).toBe(before);
  });

  it('honours a byte range with 206 and the matching Content-Range', async () => {
    const part = await raw(h.origin, 'GET', preview, { Range: 'bytes=10-99' });
    expect(part.status).toBe(206);
    expect(part.headers['content-range']).toBe(`bytes 10-99/${PREVIEW_A.length}`);
    expect(part.headers['content-length']).toBe('90');
    expect(part.body.equals(PREVIEW_A.subarray(10, 100))).toBe(true);
    expect(h.kubo.catCalls.at(-1)?.range).toEqual({ offset: 10, length: 90 });

    const open = await raw(h.origin, 'GET', preview, { Range: 'bytes=250-' });
    expect(open.status).toBe(206);
    expect(open.body.equals(PREVIEW_A.subarray(250))).toBe(true);

    const suffix = await raw(h.origin, 'GET', preview, { Range: 'bytes=-20' });
    expect(suffix.status).toBe(206);
    expect(suffix.headers['content-range']).toBe(`bytes 280-299/${PREVIEW_A.length}`);
    expect(suffix.body.equals(PREVIEW_A.subarray(280))).toBe(true);

    const clamped = await raw(h.origin, 'GET', preview, { Range: 'bytes=290-9999' });
    expect(clamped.status).toBe(206);
    expect(clamped.headers['content-range']).toBe(`bytes 290-299/${PREVIEW_A.length}`);
  });

  it('honours a range inside a bundle chunk', async () => {
    const base = rad.slice(0, rad.lastIndexOf('/'));
    const part = await raw(h.origin, 'GET', `${base}/scene-0.radc`, { Range: 'bytes=5-14' });
    expect(part.status).toBe(206);
    expect(part.headers['content-range']).toBe(`bytes 5-14/${RAD_CHUNK_0.length}`);
    expect(part.body.equals(RAD_CHUNK_0.subarray(5, 15))).toBe(true);
    expect(h.kubo.catCalls.at(-1)).toMatchObject({ cid: cid('radA'), inner: 'scene-0.radc', range: { offset: 5, length: 10 } });
  });

  it('answers an unsatisfiable or malformed range with 416 and the size', async () => {
    for (const range of ['bytes=300-', 'bytes=9999-99999', 'bytes=0-1,5-9', 'items=0-1', 'bytes=-', 'bytes=-0']) {
      const response = await raw(h.origin, 'GET', preview, { Range: range });
      expect(response.status, range).toBe(416);
      expect(response.headers['content-range'], range).toBe(`bytes */${PREVIEW_A.length}`);
      expect(response.body.length, range).toBe(0);
    }
  });

  it('answers a matching validator with 304 and no body, and a stale one with the content', async () => {
    const etag = `"${cid('previewA')}"`;
    const before = h.kubo.catCalls.length;
    const same = await raw(h.origin, 'GET', preview, { 'If-None-Match': etag });
    expect(same.status).toBe(304);
    expect(same.body.length).toBe(0);
    expect(same.headers['etag']).toBe(etag);
    expect(h.kubo.catCalls.length).toBe(before);

    expect((await raw(h.origin, 'GET', preview, { 'If-None-Match': `W/${etag}` })).status).toBe(304);
    expect((await raw(h.origin, 'GET', preview, { 'If-None-Match': `"other", ${etag}` })).status).toBe(304);
    const stale = await raw(h.origin, 'GET', preview, { 'If-None-Match': '"something-else"' });
    expect(stale.status).toBe(200);
    expect(stale.body.equals(PREVIEW_A)).toBe(true);
  });

  it('refuses methods other than GET and HEAD', async () => {
    for (const method of ['POST', 'PUT', 'DELETE', 'PATCH']) {
      const response = await raw(h.origin, method, preview);
      expect(response.status, method).toBe(405);
      expect(response.headers['allow']).toBe('GET, HEAD');
    }
  });

  it('shows no difference between a missing, wrong and expired grant', async () => {
    const guess = `/gui/content/${'A'.repeat(43)}/preview.spz`;
    const unknown = await raw(h.origin, 'GET', guess);
    const malformed = await raw(h.origin, 'GET', '/gui/content/short/preview.spz');
    const wrongFile = await raw(h.origin, 'GET', preview.replace('preview.spz', 'other.spz'));
    for (const response of [unknown, malformed, wrongFile]) {
      expect(response.status).toBe(404);
      expect(response.body.toString()).toBe(unknown.body.toString());
    }
  });

  it('keeps a single-file grant to its own file, and a bundle grant to files that exist in its bundle', async () => {
    const base = preview.slice(0, preview.lastIndexOf('/'));
    expect((await raw(h.origin, 'GET', `${base}/scene.rad`)).status).toBe(404);
    const radBase = rad.slice(0, rad.lastIndexOf('/'));
    expect((await raw(h.origin, 'GET', `${radBase}/missing.radc`)).status).toBe(404);
    expect((await raw(h.origin, 'HEAD', `${radBase}/missing.radc`)).status).toBe(404);
  });

  it('refuses path traversal and anything that is not a single plain file name', async () => {
    const radBase = rad.slice(0, rad.lastIndexOf('/'));
    const token = tokenOf(rad);
    const attempts = [
      `${radBase}/..%2fscene.rad`,
      `${radBase}/%2e%2e%2fscene.rad`,
      `${radBase}/..%5cscene.rad`,
      `${radBase}/%2e%2e`,
      `${radBase}/scene.rad%00.png`,
      `${radBase}/.hidden`,
      `${radBase}/sub%2fscene.rad`,
      `${radBase}/scene.rad%20`,
      `/gui/content/${token}/`,
      `/gui/content/${token}`,
      `/gui/content/${token}/a/b`,
      `/gui/content/${token}%2f..%2f..%2fapi%2fstatus`,
      `/gui/content//${'x'.repeat(43)}/scene.rad`,
    ];
    for (const attempt of attempts) {
      const response = await raw(h.origin, 'GET', attempt);
      expect(response.status, attempt).toBe(404);
      expect(response.body.toString(), attempt).not.toContain('"data"');
    }
    // None of that reached Kubo with a name outside the grammar - not even a lookup.
    const askedOf = [...h.kubo.catCalls.map((call) => call.inner), ...h.kubo.statCalls.map((call) => call.name)];
    for (const name of askedOf) if (name !== undefined) expect(name).toMatch(/^[A-Za-z0-9][A-Za-z0-9._-]*$/);
  });

  it('cannot be steered into the credential-gated API', async () => {
    const token = tokenOf(preview);
    const response = await raw(h.origin, 'GET', `/gui/content/${token}/../../api/status`);
    // Dot segments normalise to /gui/api/status, which is gated.
    expect([401, 404]).toContain(response.status);
    expect(response.body.toString()).not.toContain('operatorToken');
  });

  it('turns a Kubo failure into a clean 502 instead of a 200 whose body stops', async () => {
    h.kubo.failCat = true;
    const response = await raw(h.origin, 'GET', preview);
    expect(response.status).toBe(502);
    expect(response.body.length).toBe(0);
  });

  it('counts what it delivers against the grant, without ever exposing the token', async () => {
    await raw(h.origin, 'GET', preview);
    await raw(h.origin, 'GET', preview, { Range: 'bytes=0-9' });
    const stats = h.capabilities.stats('scene-a').find((entry) => entry.role === 'spatial_preview')!;
    expect(stats.requests).toBe(2);
    expect(stats.bytesSent).toBe(PREVIEW_A.length + 10);
    expect(JSON.stringify(stats)).not.toContain(tokenOf(preview));
  });
});

describe('capability scoping', () => {
  it('lets a grant reach only the representation it was minted for, never another scene', async () => {
    const h = await harness();
    const a = (await ticket(h, 'scene-a')).json.data!.representations[0]!;
    const b = (await ticket(h, 'scene-b')).json.data!.representations[0]!;
    // Same file name in both scenes (preview.spz): each token still returns its own bytes.
    expect(a.url.endsWith('/preview.spz')).toBe(true);
    expect(b.url.endsWith('/preview.spz')).toBe(true);
    expect((await raw(h.origin, 'GET', a.url)).body.equals(PREVIEW_A)).toBe(true);
    expect((await raw(h.origin, 'GET', b.url)).body.equals(PREVIEW_B)).toBe(true);
    // Swapping the token never yields the other scene's bytes.
    const crossed = await raw(h.origin, 'GET', `/gui/content/${tokenOf(a.url)}/preview.spz`);
    expect(crossed.body.equals(PREVIEW_B)).toBe(false);
  });

  it('does not let a preview grant read the archive of the same scene', async () => {
    const h = await harness();
    const preview = (await ticket(h, 'scene-a')).json.data!.representations[0]!;
    const response = await raw(h.origin, 'GET', preview.url.replace('preview.spz', 'archive.ply'));
    expect(response.status).toBe(404);
    expect(h.kubo.catCalls.some((call) => call.cid === cid('archiveA'))).toBe(false);
  });

  it('expires an idle grant and an old one, however busy it is', async () => {
    const h = await harness({ idleTtlMs: 1000, maxLifetimeMs: 2500 });
    const reps = (await ticket(h, 'scene-a')).json.data!.representations;
    h.clock.now += 900;
    expect((await raw(h.origin, 'GET', reps[0]!.url)).status).toBe(200);
    h.clock.now += 900; // 900ms since last use: still alive, and use refreshes the idle clock
    expect((await raw(h.origin, 'GET', reps[0]!.url)).status).toBe(200);
    h.clock.now += 900; // 2700ms since issue: past the absolute lifetime although used 900ms ago
    expect((await raw(h.origin, 'GET', reps[0]!.url)).status).toBe(404);
    h.clock.now += 5000; // the bundle grant, never used, idled out long ago
    expect((await raw(h.origin, 'GET', reps[1]!.url)).status).toBe(404);
    expect(h.capabilities.size()).toBe(0);
  });

  it('evicts the least recently used grant when the cap is reached', async () => {
    const h = await harness({ maxActive: 2 });
    const first = (await ticket(h, 'scene-b')).json.data!.representations[0]!;
    h.clock.now += 10;
    const second = (await ticket(h, 'scene-a')).json.data!.representations; // two more: cap is 2
    expect(h.capabilities.size()).toBe(2);
    expect((await raw(h.origin, 'GET', first.url)).status).toBe(404);
    expect((await raw(h.origin, 'GET', second[0]!.url)).status).toBe(200);
  });

  it('forgets every grant on restart', async () => {
    const h = await harness();
    const url = (await ticket(h, 'scene-a')).json.data!.representations[0]!.url;
    const fresh = new ViewerCapabilities();
    expect(fresh.resolve(tokenOf(url))).toBeUndefined();
  });
});

describe('secrecy and boundaries', () => {
  it('never writes a capability token to a log or an error body', async () => {
    const h = await harness();
    const reps = (await ticket(h, 'scene-a')).json.data!.representations;
    const errors: Array<{ what: string; status: number; body: string }> = [];
    for (const rep of reps) {
      expect((await raw(h.origin, 'GET', rep.url)).status).toBe(200);
      for (const [what, response] of [
        ['wrong file', await raw(h.origin, 'GET', `${rep.url}x`)],
        ['wrong method', await raw(h.origin, 'POST', rep.url)],
        ['bad range', await raw(h.origin, 'GET', rep.url, { Range: 'bytes=99999-' })],
      ] as const) errors.push({ what, status: response.status, body: response.body.toString() });
    }
    h.kubo.failCat = true;
    const upstream = await raw(h.origin, 'GET', reps[0]!.url);
    errors.push({ what: 'kubo down', status: upstream.status, body: upstream.body.toString() });

    expect(errors.map((entry) => entry.status).sort()).toEqual([404, 404, 405, 405, 416, 416, 502].sort());
    for (const rep of reps) {
      const token = tokenOf(rep.url);
      expect(h.logged.join('\n')).not.toContain(token);
      for (const entry of errors) expect(entry.body, entry.what).not.toContain(token);
    }
    // No error body echoes any part of the request path.
    for (const entry of errors) expect(entry.body, entry.what).not.toContain('/gui/content');
  });

  it('scrubs a content URL from any text that quotes it', () => {
    const token = 'T'.repeat(43);
    for (const text of [`GET /gui/content/${token}/scene.rad failed`, `{"url":"/gui/content/${token}/preview.spz"}`, `/gui/content/${token.slice(0, 12)}`]) {
      const scrubbed = redactSecrets(text);
      expect(scrubbed).not.toContain('TTTTTTTT');
      expect(scrubbed).toContain('/gui/content/[redacted]');
    }
    expect(JSON.stringify(redactSecrets({ message: `/gui/content/${token}/x` }))).not.toContain(token);
  });

  it('leaves the credential gate on the rest of the GUI API untouched', async () => {
    const h = await harness();
    const reps = (await ticket(h, 'scene-a')).json.data!.representations;
    for (const apiPath of ['/gui/api/status', '/gui/api/spatial', '/gui/api/spatial/scene-a', '/gui/api/spatial/scene-a/manifest', '/gui/api/jobs']) {
      const response = await fetch(`${h.origin}${apiPath}`);
      expect(response.status, apiPath).toBe(401);
    }
    // A capability is not a GUI credential.
    const withCapability = await fetch(`${h.origin}/gui/api/spatial/scene-a`, { headers: { Authorization: `Bearer ${tokenOf(reps[0]!.url)}` } });
    expect(withCapability.status).toBe(401);
    // Nor does the GUI credential substitute for a capability.
    const guessed = await raw(h.origin, 'GET', `/gui/content/${GUI_TOKEN}/preview.spz`, auth);
    expect(guessed.status).toBe(404);
  });

  it('does not serve content when the GUI is disabled', async () => {
    const h = await harness({ guiEnabled: false });
    const url = `/gui/content/${'B'.repeat(43)}/preview.spz`;
    expect((await raw(h.origin, 'GET', url)).status).toBe(404);
  });

  it('does not let the whole-file download route expose a bundle', async () => {
    const h = await harness();
    const response = await fetch(`${h.origin}/gui/api/spatial/scene-a/content/spatial_mobile`, { headers: auth });
    expect(response.status).toBe(409);
  });
});
