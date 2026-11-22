import { afterEach, describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AppConfig } from '../src/config/schema.js';
import { ActionLock } from '../src/runtime/actionLock.js';
import { startGuiServer } from '../src/gui/guiServer.js';
import { listSpatialSummaries, serveFaceReviewImage } from '../src/gui/spatialGuiApi.js';
import { LocalStore } from '../src/state/localStore.js';
import {
  WORKER_REVIEW_FILE, acknowledgeFaceReview, faceReviewDirectory, faceReviewView, openFaceReviewImage, removeFaceReviewImages, storeFaceReview, withoutFaceReview,
} from '../src/spatial/faceReview.js';
import { supersedeSpatialRecord } from '../src/spatial/supersede.js';
import { syntheticCid } from './fixtures/contentIds.js';

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

const SPATIAL_ID = '11111111-1111-4111-8111-111111111111';
const OTHER_ID = '22222222-2222-4222-8222-222222222222';

async function setup(options: { images?: number; truncated?: boolean } = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'kubus-face-review-'));
  dirs.push(dir);
  const store = new LocalStore(path.join(dir, 'state.json'));
  await store.load();
  const work = path.join(dir, 'work');
  await fs.mkdir(path.join(work, 'dataset', 'images'), { recursive: true });
  await fs.mkdir(path.join(work, 'selected_frames'), { recursive: true });
  const count = options.images ?? 2;
  const sources = [];
  for (let index = 0; index < count; index += 1) {
    const name = `photo_${String(index).padStart(5, '0')}.jpg`;
    await fs.writeFile(path.join(work, 'dataset', 'images', name), Buffer.from(`masked ${index}`));
    sources.push({ part: 'photos' as const, image: index + 3, relative: `dataset/images/${name}`, root: work, largeBelowCertain: 1 });
  }
  await fs.writeFile(path.join(work, 'selected_frames', 'frame_00007.jpg'), Buffer.from('frame'));
  sources.push({ part: 'video' as const, image: 8, relative: 'selected_frames/frame_00007.jpg', root: work, weakExcluded: 2, seconds: 41.3 });
  const review = await storeFaceReview(dir, SPATIAL_ID, 'job-1', sources.length + (options.truncated ? 5 : 0), sources, Boolean(options.truncated));
  await store.update((state) => {
    (state.spatial ??= {})[SPATIAL_ID] = { id: SPATIAL_ID, state: 'local', manifestCid: syntheticCid('m1'), createdAt: '2026-11-22T10:00:00.000Z', manifest: { artworkId: 'art-1', captureId: 'c1', capturedAt: 'x', variants: [] }, faceReview: review } as never;
  });
  return { dir, store, review };
}

/** Opens one image the way the route does and closes the handle again (a test has no response to stream it into). */
async function look(dir: string, store: LocalStore, file: string, id = SPATIAL_ID) {
  const image = await openFaceReviewImage(dir, store, id, file);
  await image.handle.close();
  return image;
}

const recordOf = (store: LocalStore) => store.snapshot().spatial![SPATIAL_ID] as unknown as { state: string; faceReview?: { viewed: string[]; acknowledged?: { at: string; by: string } } };

describe('face review of a record', () => {
  it('copies only flagged, bounded, regular files named by the worker, and names the copies by part and number', async () => {
    const { dir, review } = await setup();
    expect(review.items.map((item) => item.file)).toEqual(['photos-00003.jpg', 'photos-00004.jpg', 'video-00008.jpg']);
    expect(review.items[2]).toMatchObject({ part: 'video', weakExcluded: 2, seconds: 41.3 });
    expect(review.viewed).toEqual([]);
    expect((await fs.readdir(faceReviewDirectory(dir, SPATIAL_ID))).sort()).toEqual(['photos-00003.jpg', 'photos-00004.jpg', 'video-00008.jpg']);
    for (const good of ['dataset/images/photo_00001.jpg', 'dataset/images/video_00012.jpg', 'selected_frames/frame_00003.jpg']) expect(WORKER_REVIEW_FILE.test(good)).toBe(true);
    for (const bad of ['../x.jpg', 'dataset/images/../../x.jpg', 'dataset/images/photo_1.jpg', '/etc/passwd', 'dataset\\images\\photo_00001.jpg', 'dataset/images/photo_00001.png', 'result.ply']) expect(WORKER_REVIEW_FILE.test(bad)).toBe(false);
  });

  it('refuses a source that is a link, missing or outside the shape, and leaves nothing behind', async () => {
    const { dir } = await setup();
    const work = path.join(dir, 'work2');
    await fs.mkdir(path.join(work, 'dataset', 'images'), { recursive: true });
    await fs.writeFile(path.join(dir, 'secret.jpg'), 'private');
    let linked = true;
    await fs.symlink(path.join(dir, 'secret.jpg'), path.join(work, 'dataset', 'images', 'photo_00000.jpg')).catch(() => { linked = false; });
    if (linked) {
      await expect(storeFaceReview(dir, OTHER_ID, 'job-2', 1, [{ part: 'photos', image: 1, relative: 'dataset/images/photo_00000.jpg', root: work }], false)).rejects.toMatchObject({ code: 'face_review_images_unavailable' });
      await expect(fs.stat(faceReviewDirectory(dir, OTHER_ID))).rejects.toThrow();
    }
    await expect(storeFaceReview(dir, OTHER_ID, 'job-2', 1, [{ part: 'photos', image: 1, relative: 'dataset/images/photo_00009.jpg', root: work }], false)).rejects.toMatchObject({ code: 'face_review_images_unavailable' });
    await expect(storeFaceReview(dir, OTHER_ID, 'job-2', 1, [{ part: 'photos', image: 1, relative: '../secret.jpg', root: work }], false)).rejects.toMatchObject({ code: 'face_review_images_unavailable' });
    await expect(fs.stat(faceReviewDirectory(dir, OTHER_ID))).rejects.toThrow();
    expect(() => faceReviewDirectory(dir, '../escape')).toThrow();
  });

  it('records that an image was shown only when it is served, refuses names the review does not list, and cannot be acknowledged before all were shown', async () => {
    const { dir, store } = await setup();
    await expect(acknowledgeFaceReview(dir, store, SPATIAL_ID, 'gui-operator')).rejects.toMatchObject({ statusCode: 409, code: 'face_review_images_unseen', details: { unseen: 3 } });
    expect(faceReviewView(store, SPATIAL_ID)).toMatchObject({ pending: 3, unseen: 3, itemsTruncated: false });
    for (const name of ['photos-00099.jpg', '../state.json', 'photos-00003.jpg/..', 'result.ply']) await expect(openFaceReviewImage(dir, store, SPATIAL_ID, name)).rejects.toMatchObject({ statusCode: 404 });
    expect(recordOf(store).faceReview!.viewed).toEqual([]);
    const opened = await look(dir, store, 'photos-00003.jpg');
    expect(opened).toMatchObject({ mimeType: 'image/jpeg', size: 'masked 0'.length });
    expect(recordOf(store).faceReview!.viewed).toEqual(['photos-00003.jpg']);
    await look(dir, store, 'photos-00003.jpg');
    expect(recordOf(store).faceReview!.viewed).toEqual(['photos-00003.jpg']);
    await expect(acknowledgeFaceReview(dir, store, SPATIAL_ID, 'gui-operator')).rejects.toMatchObject({ code: 'face_review_images_unseen', details: { unseen: 2 } });
    await look(dir, store, 'photos-00004.jpg');
    await look(dir, store, 'video-00008.jpg');
    const done = await acknowledgeFaceReview(dir, store, SPATIAL_ID, 'gui-operator');
    expect(done.acknowledged?.by).toBe('gui-operator');
    expect(Date.parse(done.acknowledged!.at)).not.toBeNaN();
    expect(recordOf(store).faceReview!.acknowledged).toEqual(done.acknowledged);
    // The copies are not kept longer than the review needs them, and a repeat changes nothing.
    await expect(fs.stat(faceReviewDirectory(dir, SPATIAL_ID))).rejects.toThrow();
    expect(await acknowledgeFaceReview(dir, store, SPATIAL_ID, 'someone-else')).toEqual(done);
  });

  it('opens the file before it records the look, so a copy removed in between is still read and never becomes a stream error', async () => {
    const { dir, store } = await setup();
    const realUpdate = store.update.bind(store);
    store.update = (async (mutator: Parameters<LocalStore['update']>[0]) => {
      // An acknowledge or a supersede in another request removes the copy between the check and the response.
      await removeFaceReviewImages(dir, SPATIAL_ID);
      return realUpdate(mutator);
    }) as LocalStore['update'];
    const image = await openFaceReviewImage(dir, store, SPATIAL_ID, 'photos-00003.jpg');
    try {
      expect((await image.handle.readFile()).toString()).toBe('masked 0');
    } finally {
      await image.handle.close();
    }
    store.update = realUpdate;
    await expect(fs.stat(faceReviewDirectory(dir, SPATIAL_ID))).rejects.toThrow();
    await expect(openFaceReviewImage(dir, store, SPATIAL_ID, 'photos-00003.jpg')).rejects.toMatchObject({ code: 'face_review_image_missing' });
  });

  it('serves the image through the route helper and ends the response quietly when the copy is gone', async () => {
    const { dir, store } = await setup();
    const sent: Buffer[] = [];
    const { Writable } = await import('node:stream');
    const response = Object.assign(new Writable({ write(chunk, _encoding, done) { sent.push(Buffer.from(chunk)); done(); } }), { writeHead: () => undefined });
    await serveFaceReviewImage(response as never, { store, dataRoot: dir }, SPATIAL_ID, 'photos-00003.jpg');
    await new Promise((resolve) => response.on('finish', resolve));
    expect(Buffer.concat(sent).toString()).toBe('masked 0');
    await fs.rm(path.join(faceReviewDirectory(dir, SPATIAL_ID), 'photos-00004.jpg'));
    await expect(serveFaceReviewImage(response as never, { store, dataRoot: dir }, SPATIAL_ID, 'photos-00004.jpg')).rejects.toMatchObject({ code: 'face_review_image_missing' });
  });

  it('tolerates a review of the older shape (no images, no looks): readable, listed, and never acknowledgeable', async () => {
    const { dir, store } = await setup();
    await store.update((state) => { (state.spatial![SPATIAL_ID] as { faceReview?: unknown }).faceReview = { pending: 2, jobId: 'job-0' }; });
    expect(faceReviewView(store, SPATIAL_ID)).toMatchObject({ pending: 2, items: [], unseen: 0 });
    expect(listSpatialSummaries(store)[0]!.faceReview).toEqual({ pending: 2, acknowledged: false, unseen: 0 });
    await expect(acknowledgeFaceReview(dir, store, SPATIAL_ID, 'gui-operator')).rejects.toMatchObject({ statusCode: 409, code: 'face_review_images_unavailable' });
    await expect(openFaceReviewImage(dir, store, SPATIAL_ID, 'photos-00003.jpg')).rejects.toMatchObject({ statusCode: 404 });
    expect(recordOf(store).faceReview).not.toHaveProperty('acknowledged');
  });

  it('checks the replacement and an earlier supersede again inside the update, not only on the snapshot it read', async () => {
    const { dir, store } = await setup();
    const newer = '33333333-3333-4333-8333-333333333333';
    const other = '44444444-4444-4444-8444-444444444444';
    for (const [id, cid, at] of [[newer, 'm2', '11:00'], [other, 'm3', '12:00']] as const) {
      await store.update((state) => {
        (state.spatial ??= {})[id] = { id, state: 'local', manifestCid: syntheticCid(cid), createdAt: `2026-11-22T${at}:00.000Z`, manifest: { artworkId: 'art-1', captureId: cid, capturedAt: 'x', variants: [] } } as never;
      });
    }
    const kubo = { pinLs: async () => ({ Keys: {} }), pinAdd: async () => undefined, pinRm: async () => undefined };
    const realUpdate = store.update.bind(store);
    let hook: (() => Promise<void>) | undefined;
    store.update = (async (mutator: Parameters<LocalStore['update']>[0]) => {
      const run = hook;
      hook = undefined;
      if (run) await run();
      return realUpdate(mutator);
    }) as LocalStore['update'];
    // Between the read and the update the replacement is itself retired.
    hook = async () => { await realUpdate((state) => { (state.spatial![newer] as { state: string }).state = 'superseded'; }); };
    await expect(supersedeSpatialRecord({ store, kubo: kubo as never, dataRoot: dir }, SPATIAL_ID, newer)).rejects.toMatchObject({ statusCode: 422, code: 'spatial_replacement_unavailable' });
    expect(recordOf(store).state).toBe('local');
    // Between the read and the update another supersede, with a different replacement, wins.
    hook = async () => { await realUpdate((state) => { Object.assign(state.spatial![SPATIAL_ID] as object, { state: 'superseded', supersededBy: newer }); }); };
    await expect(supersedeSpatialRecord({ store, kubo: kubo as never, dataRoot: dir }, SPATIAL_ID, other)).rejects.toMatchObject({ statusCode: 409, code: 'spatial_already_superseded' });
    expect((recordOf(store) as { supersededBy?: string }).supersededBy).toBe(newer);
    store.update = realUpdate;
  });

  it('refuses an acknowledgement of a cut list unless the operator says the rest was looked at', async () => {
    const { dir, store } = await setup({ truncated: true });
    for (const name of ['photos-00003.jpg', 'photos-00004.jpg', 'video-00008.jpg']) await look(dir, store, name);
    await expect(acknowledgeFaceReview(dir, store, SPATIAL_ID, 'gui-operator')).rejects.toMatchObject({ code: 'face_review_list_truncated' });
    expect((await acknowledgeFaceReview(dir, store, SPATIAL_ID, 'gui-operator', { allowTruncated: true })).acknowledged).toBeDefined();
  });

  it('does not serve or acknowledge for a record without a review or a retired one, and says the copy is gone when it is', async () => {
    const { dir, store } = await setup();
    await expect(openFaceReviewImage(dir, store, OTHER_ID, 'photos-00003.jpg')).rejects.toMatchObject({ code: 'spatial_not_found' });
    await fs.rm(path.join(faceReviewDirectory(dir, SPATIAL_ID), 'photos-00004.jpg'));
    await expect(openFaceReviewImage(dir, store, SPATIAL_ID, 'photos-00004.jpg')).rejects.toMatchObject({ code: 'face_review_image_missing' });
    await store.update((state) => { (state.spatial![SPATIAL_ID] as { state: string }).state = 'superseded'; });
    await expect(openFaceReviewImage(dir, store, SPATIAL_ID, 'photos-00003.jpg')).rejects.toMatchObject({ code: 'face_review_not_found' });
    await expect(acknowledgeFaceReview(dir, store, SPATIAL_ID, 'gui-operator')).rejects.toMatchObject({ code: 'spatial_not_publishable' });
    await store.update((state) => { delete (state.spatial![SPATIAL_ID] as { faceReview?: unknown }).faceReview; });
    expect(() => faceReviewView(store, SPATIAL_ID)).toThrow('face_review_not_required');
  });

  it('summarises the review for the list without paths, and leaves it out of what paired clients and the backend get', async () => {
    const { store } = await setup();
    const [summary] = listSpatialSummaries(store);
    expect(summary!.faceReview).toEqual({ pending: 3, acknowledged: false, unseen: 3 });
    expect(JSON.stringify(summary)).not.toMatch(/photos-0|\bwork\b|[A-Za-z]:\\/);
    const stripped = withoutFaceReview(store.snapshot().spatial![SPATIAL_ID] as object);
    expect(stripped).not.toHaveProperty('faceReview');
    expect(stripped).toHaveProperty('id', SPATIAL_ID);
  });

  it('removes the copies of a record when it is superseded, and refuses to retire one whose publication is in flight', async () => {
    const { dir, store } = await setup();
    const newer = '33333333-3333-4333-8333-333333333333';
    await store.update((state) => {
      (state.spatial ??= {})[newer] = { id: newer, state: 'local', manifestCid: syntheticCid('m2'), createdAt: '2026-11-22T11:00:00.000Z', manifest: { artworkId: 'art-1', captureId: 'c2', capturedAt: 'x', variants: [] } } as never;
    });
    const kubo = { pinLs: async () => ({ Keys: {} }), pinAdd: async () => undefined, pinRm: async () => undefined };
    // A publish request that began after the supersede read the record (the claim is set in an update of its own).
    await store.update((state) => { (state.spatial![SPATIAL_ID] as { publishInFlightAt?: string }).publishInFlightAt = new Date().toISOString(); });
    await expect(supersedeSpatialRecord({ store, kubo: kubo as never, dataRoot: dir }, SPATIAL_ID, newer)).rejects.toMatchObject({ statusCode: 409, code: 'spatial_publication_active' });
    expect(recordOf(store).state).toBe('local');
    await expect(fs.stat(faceReviewDirectory(dir, SPATIAL_ID))).resolves.toBeDefined();
    // The same request, but the claim happens between the read and the update.
    await store.update((state) => { delete (state.spatial![SPATIAL_ID] as { publishInFlightAt?: string }).publishInFlightAt; });
    let claimed = false;
    const racing = {
      ...kubo,
      pinLs: async () => ({ Keys: {} }),
    };
    const realUpdate = store.update.bind(store);
    store.update = (async (mutator: Parameters<LocalStore['update']>[0]) => {
      if (!claimed) {
        claimed = true;
        await realUpdate((state) => { (state.spatial![SPATIAL_ID] as { publishInFlightAt?: string }).publishInFlightAt = new Date().toISOString(); });
      }
      return realUpdate(mutator);
    }) as LocalStore['update'];
    await expect(supersedeSpatialRecord({ store, kubo: racing as never, dataRoot: dir }, SPATIAL_ID, newer)).rejects.toMatchObject({ code: 'spatial_publication_active' });
    expect(recordOf(store).state).toBe('local');
    store.update = realUpdate;
    // A claim left by a crashed request goes stale and no longer blocks.
    await store.update((state) => { (state.spatial![SPATIAL_ID] as { publishInFlightAt?: string }).publishInFlightAt = new Date(Date.now() - 11 * 60 * 1000).toISOString(); });
    await supersedeSpatialRecord({ store, kubo: kubo as never, dataRoot: dir }, SPATIAL_ID, newer);
    expect(recordOf(store).state).toBe('superseded');
    await expect(fs.stat(faceReviewDirectory(dir, SPATIAL_ID))).rejects.toThrow();
    await removeFaceReviewImages(dir, SPATIAL_ID);
  });
});

describe('face review in the GUI routes', () => {
  const headers = { Authorization: 'Bearer gui-secret' };

  async function start() {
    const fixture = await setup();
    const config = { guiHost: '127.0.0.1', guiAllowRemote: false, guiEnabled: true, guiPort: 0, guiToken: 'gui-secret', localDataPath: fixture.dir, apiBaseUrl: 'http://api.test', nodeLabel: 'n', guiDisplayUrl: 'http://127.0.0.1:8787/gui', guiFallbackUrl: 'http://127.0.0.1:8787/gui' } as unknown as AppConfig;
    const server = await startGuiServer({ api: {} as never, kubo: {} as never, store: fixture.store, config, logger: { info: () => undefined } as never, actionLock: new ActionLock() });
    const url = (suffix: string) => server.url.replace('/gui', `/gui/api/spatial/${SPATIAL_ID}${suffix}`);
    return { ...fixture, server, url };
  }

  it('needs the GUI token for every route', async () => {
    const { server, url } = await start();
    try {
      for (const [method, suffix] of [['GET', '/face-review'], ['GET', '/face-review/image/photos-00003.jpg'], ['POST', '/face-review/acknowledge']] as const) {
        expect((await fetch(url(suffix), { method })).status).toBe(401);
      }
    } finally {
      await server.close();
    }
  });

  it('lists, serves each image (which is what counts as looking), refuses early confirmation, then acknowledges', async () => {
    const { server, url, store } = await start();
    try {
      const listed = await (await fetch(url('/face-review'), { headers })).json();
      expect(listed.data).toMatchObject({ pending: 3, unseen: 3 });
      expect(JSON.stringify(listed)).not.toMatch(/\bwork\b|[A-Za-z]:\\/);
      const post = (body: unknown) => fetch(url('/face-review/acknowledge'), { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      expect((await post({})).status).toBe(400);
      expect((await post({ confirm: 'yes' })).status).toBe(400);
      const early = await post({ confirm: true });
      expect(early.status).toBe(409);
      expect((await early.json()).code ?? 'face_review_images_unseen').toBe('face_review_images_unseen');
      const image = await fetch(url('/face-review/image/photos-00003.jpg'), { headers });
      expect(image.status).toBe(200);
      expect(image.headers.get('content-type')).toBe('image/jpeg');
      expect(image.headers.get('cache-control')).toBe('private, no-store');
      expect(await image.text()).toBe('masked 0');
      expect((await fetch(url('/face-review/image/..%2Fstate.json'), { headers })).status).toBe(404);
      expect((await fetch(url('/face-review/image/photos-00099.jpg'), { headers })).status).toBe(404);
      for (const name of ['photos-00004.jpg', 'video-00008.jpg']) expect((await fetch(url(`/face-review/image/${name}`), { headers })).status).toBe(200);
      const ok = await post({ confirm: true });
      expect(ok.status).toBe(200);
      expect((await ok.json()).data.acknowledged.by).toBe('gui-operator');
      expect(recordOf(store).faceReview!.acknowledged).toBeDefined();
    } finally {
      await server.close();
    }
  });
});
