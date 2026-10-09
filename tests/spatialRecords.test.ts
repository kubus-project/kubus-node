import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { LocalStore } from '../src/state/localStore.js';
import { SpatialRecords, summarizeDerivatives, type SpatialStoreRecord } from '../src/spatial/spatialRecords.js';
import type { SpatialManifest, SpatialVariant } from '../src/spatial/models.js';

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

/** Content-addressed like Kubo: the same bytes always get the same CID, different bytes never do. */
class FakeKubo {
  readonly added: Array<{ cid: string; name: string; text: string }> = [];
  failNext = 0;
  delays: number[] = [];

  async addBytes(bytes: Uint8Array, name: string) {
    if (this.failNext > 0) { this.failNext -= 1; throw new Error('kubo unavailable'); }
    const delay = this.delays.shift() ?? 0;
    if (delay) await new Promise((resolve) => setTimeout(resolve, delay));
    const cid = `Qm${createHash('sha256').update(bytes).digest('hex').slice(0, 44)}`;
    this.added.push({ cid, name, text: Buffer.from(bytes).toString('utf8') });
    return { Hash: cid };
  }
}

async function setup() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'kubus-records-'));
  dirs.push(dir);
  const store = new LocalStore(path.join(dir, 'state.json'));
  await store.load();
  const kubo = new FakeKubo();
  const records = new SpatialRecords({ store, kubo: kubo as never });
  return { store, kubo, records };
}

const archive: SpatialVariant = { role: 'spatial_archive', cid: 'QmArchive', sizeBytes: 5000, mimeType: 'application/octet-stream', format: 'ply', storageClass: 'cold' };
const preview = (cid = 'QmPreview'): SpatialVariant => ({ role: 'spatial_preview', cid, sizeBytes: 300, mimeType: 'application/octet-stream', format: 'spz', storageClass: 'hot' });
const runtime = (rootCid = 'QmRuntimeRoot'): SpatialVariant => ({ role: 'spatial_mobile', rootCid, entrypoint: 'scene.rad', fileCount: 3, sizeBytes: 900, mimeType: 'application/octet-stream', format: 'rad', storageClass: 'warm' });

const manifest = (id = 'scene-1', variants: SpatialVariant[] = [archive]): SpatialManifest => ({
  schema: 'kubus.spatial/1', type: 'gaussianSplat', id, artworkId: 'artwork-1', captureId: 'capture-1',
  captureProvenance: { source: 'localCapture', captureId: 'capture-1' }, capturedAt: '2026-08-01T00:00:00.000Z', variants,
  processing: { protocol: 'kubus.spatial-job/1', workerVersion: 'kubus-spatial-worker/2', reconstruction: { engine: 'nerfstudio', method: 'splatfacto', iterations: 15000, outputFormat: 'ply' } },
  createdAt: '2026-08-01T00:05:00.000Z',
});

const provenance = (tool: string) => ({ tool, toolVersion: '1.0.0', bytes: 1, splats: 10 });

describe('creating and reading records', () => {
  it('stores the manifest in Kubo and keeps the scene private and local', async () => {
    const { records, kubo, store } = await setup();
    const record = await records.create(manifest());
    expect(record).toMatchObject({ id: 'scene-1', state: 'local', privateSourceCapture: true, manifestCid: kubo.added[0]!.cid });
    expect(JSON.parse(kubo.added[0]!.text)).toEqual(manifest());
    expect(kubo.added[0]!.name).toBe('scene-1.spatial.json');
    expect(store.snapshot().spatial?.['scene-1']).toBeDefined();
  });

  it('refuses an invalid manifest before anything reaches Kubo or the store', async () => {
    const { records, kubo, store } = await setup();
    const invalid = { ...manifest(), variants: [{ ...archive, storageClass: 'hot' }] } as SpatialManifest;
    await expect(records.create(invalid)).rejects.toThrow('spatial_manifest_storage_class_invalid');
    expect(kubo.added).toEqual([]);
    expect(Object.keys(store.snapshot().spatial ?? {})).toEqual([]);
  });

  it('answers a missing scene with a 404 and find() with undefined', async () => {
    const { records } = await setup();
    expect(() => records.get('nope')).toThrow(expect.objectContaining({ statusCode: 404, code: 'spatial_not_found' }));
    expect(records.find('nope')).toBeUndefined();
    await expect(records.attachVariant('nope', preview(), 'preview', provenance('spz'))).rejects.toMatchObject({ statusCode: 404 });
  });

  it('hands out copies, so a caller cannot edit the stored record', async () => {
    const { records } = await setup();
    await records.create(manifest());
    const copy = records.get('scene-1');
    copy.manifest.variants.length = 0;
    copy.state = 'tampered';
    expect(records.get('scene-1').manifest.variants).toHaveLength(1);
    expect(records.get('scene-1').state).toBe('local');
  });
});

describe('attaching derivatives', () => {
  it('adds the variant in presentation order and records how it was made', async () => {
    const { records } = await setup();
    await records.create(manifest());
    const afterRuntime = await records.attachVariant('scene-1', runtime(), 'runtime', provenance('build-lod'));
    const afterPreview = await records.attachVariant('scene-1', preview(), 'preview', provenance('spz'));
    expect(afterRuntime.manifest.variants.map((variant) => variant.role)).toEqual(['spatial_mobile', 'spatial_archive']);
    expect(afterPreview.manifest.variants.map((variant) => variant.role)).toEqual(['spatial_preview', 'spatial_mobile', 'spatial_archive']);
    expect(afterPreview.manifest.processing.derivatives).toEqual({ runtime: provenance('build-lod'), preview: provenance('spz') });
  });

  it('keeps the reconstruction master untouched, byte for byte, through every attach', async () => {
    const { records } = await setup();
    await records.create(manifest());
    await records.attachVariant('scene-1', preview(), 'preview', provenance('spz'));
    await records.attachVariant('scene-1', runtime(), 'runtime', provenance('build-lod'));
    expect(records.get('scene-1').manifest.variants.find((variant) => variant.role === 'spatial_archive')).toEqual(archive);
  });

  it('moves the record to the new manifest CID and keeps the old ones, oldest first', async () => {
    const { records } = await setup();
    const created = await records.create(manifest());
    const first = await records.attachVariant('scene-1', preview(), 'preview', provenance('spz'));
    const second = await records.attachVariant('scene-1', runtime(), 'runtime', provenance('build-lod'));
    expect(new Set([created.manifestCid, first.manifestCid, second.manifestCid]).size).toBe(3);
    expect(second.manifestCid).not.toBe(first.manifestCid);
    expect(second.manifestHistory).toEqual([created.manifestCid, first.manifestCid]);
    expect(second.id).toBe('scene-1');
  });

  it('replaces the variant for a role rather than adding a second one', async () => {
    const { records } = await setup();
    await records.create(manifest());
    await records.attachVariant('scene-1', preview('QmOld'), 'preview', provenance('spz'));
    const replaced = await records.attachVariant('scene-1', preview('QmNew'), 'preview', provenance('spz'));
    const previews = replaced.manifest.variants.filter((variant) => variant.role === 'spatial_preview');
    expect(previews).toEqual([preview('QmNew')]);
  });

  it('does not add a history entry when the manifest did not change', async () => {
    const { records } = await setup();
    await records.create(manifest());
    const first = await records.attachVariant('scene-1', preview(), 'preview', provenance('spz'));
    const again = await records.attachVariant('scene-1', preview(), 'preview', provenance('spz'));
    expect(again.manifestCid).toBe(first.manifestCid);
    expect(again.manifestHistory).toEqual(first.manifestHistory);
  });

  it('bounds the history it keeps', async () => {
    const { records } = await setup();
    await records.create(manifest());
    for (let index = 0; index < 30; index += 1) await records.attachVariant('scene-1', preview(`QmPreview${index}`), 'preview', provenance('spz'));
    const history = records.get('scene-1').manifestHistory!;
    expect(history).toHaveLength(20);
    // The newest superseded manifests are the ones kept.
    expect(history.at(-1)).not.toBe(records.get('scene-1').manifestCid);
  });

  it('adds a derivative to a scene written by the previous release', async () => {
    const { records, store } = await setup();
    // A record exactly as 0.8.1 stored it: no derivatives block, no history, no notes.
    await store.update((state) => {
      (state.spatial ??= {})['legacy'] = { id: 'legacy', state: 'local', manifestCid: 'QmLegacyManifest', manifest: manifest('legacy'), createdAt: '2026-08-01T00:05:00.000Z', privateSourceCapture: true };
    });
    const upgraded = await records.attachVariant('legacy', preview(), 'preview', provenance('spz'));
    expect(upgraded.manifest.variants.map((variant) => variant.role)).toEqual(['spatial_preview', 'spatial_archive']);
    expect(upgraded.manifestHistory).toEqual(['QmLegacyManifest']);
  });

  it('refuses a derivative that would make the manifest invalid, and leaves the scene exactly as it was', async () => {
    const { records, kubo } = await setup();
    const before = await records.create(manifest());
    const addedBefore = kubo.added.length;
    await expect(records.attachVariant('scene-1', { ...preview(), storageClass: 'cold' }, 'preview', provenance('spz'))).rejects.toThrow('spatial_manifest_storage_class_invalid');
    expect(records.get('scene-1')).toEqual(before);
    expect(kubo.added.length).toBe(addedBefore);
  });

  it('does not move the record when Kubo cannot store the new manifest, and keeps working afterwards', async () => {
    const { records, kubo } = await setup();
    const before = await records.create(manifest());
    kubo.failNext = 1;
    await expect(records.attachVariant('scene-1', preview(), 'preview', provenance('spz'))).rejects.toThrow('kubo unavailable');
    expect(records.get('scene-1').manifestCid).toBe(before.manifestCid);
    expect(records.get('scene-1').manifest.variants).toHaveLength(1);
    // The failure must not wedge the per-scene lock.
    const recovered = await records.attachVariant('scene-1', preview(), 'preview', provenance('spz'));
    expect(recovered.manifest.variants).toHaveLength(2);
  });

  it('clears the "being made" note for the kind it attached, and only that kind', async () => {
    const { records } = await setup();
    await records.create(manifest());
    await records.markDerivative('scene-1', 'preview', { state: 'running', jobId: 'j1', at: 'now' });
    await records.markDerivative('scene-1', 'runtime', { state: 'failed', jobId: 'j1', at: 'now', error: { code: 'x', message: 'y' } });
    await records.attachVariant('scene-1', preview(), 'preview', provenance('spz'));
    const record = records.get('scene-1');
    expect(record.derivatives?.preview).toBeUndefined();
    expect(record.derivatives?.runtime?.state).toBe('failed');
  });

  it('serialises writers for one scene: two derivatives finishing together both survive', async () => {
    const { records, kubo } = await setup();
    await records.create(manifest());
    // The first writer is slow to store its manifest, the second fast: without a
    // lock the second would start from the old manifest and then be overwritten.
    kubo.delays = [60, 0];
    const slowPreview = records.attachVariant('scene-1', preview(), 'preview', provenance('spz'));
    const fastRuntime = records.attachVariant('scene-1', runtime(), 'runtime', provenance('build-lod'));
    await Promise.all([slowPreview, fastRuntime]);
    const final = records.get('scene-1');
    expect(final.manifest.variants.map((variant) => variant.role)).toEqual(['spatial_preview', 'spatial_mobile', 'spatial_archive']);
    expect(final.manifest.processing.derivatives).toEqual({ preview: provenance('spz'), runtime: provenance('build-lod') });
    expect(final.manifestHistory).toHaveLength(2);
  });

  it('does not make writers for different scenes wait for each other', async () => {
    const { records, kubo } = await setup();
    await records.create(manifest('a'));
    await records.create({ ...manifest('b'), captureId: 'capture-b' });
    kubo.delays = [200, 0];
    const started = Date.now();
    const slowA = records.attachVariant('a', preview(), 'preview', provenance('spz'));
    const fastB = records.attachVariant('b', preview(), 'preview', provenance('spz'));
    await fastB;
    expect(Date.now() - started).toBeLessThan(150);
    await slowA;
  });
});

describe('derivative status', () => {
  const base = (extra: Partial<SpatialStoreRecord> = {}): Pick<SpatialStoreRecord, 'manifest' | 'derivatives'> => ({ manifest: manifest(), ...extra });

  it('says "missing" for a derivative nobody has tried to make', () => {
    expect(summarizeDerivatives(base())).toEqual({ preview: { state: 'missing' }, runtime: { state: 'missing' } });
  });

  it('reads "ready" from the manifest itself, whatever a leftover note says', () => {
    const withPreview = { manifest: manifest('s', [preview(), archive]), derivatives: { preview: { state: 'failed' as const, jobId: 'j', at: 'x', error: { code: 'a', message: 'b' } } } };
    expect(summarizeDerivatives(withPreview).preview).toEqual({ state: 'ready' });
    expect(summarizeDerivatives(withPreview).runtime).toEqual({ state: 'missing' });
  });

  it('reports a running attempt and a failed one with its reason', () => {
    const summary = summarizeDerivatives(base({ derivatives: {
      preview: { state: 'running', jobId: 'j', at: 'x' },
      runtime: { state: 'failed', jobId: 'j', at: 'x', error: { code: 'worker_failed', message: 'out of memory' } },
    } }));
    expect(summary.preview).toEqual({ state: 'running' });
    expect(summary.runtime).toEqual({ state: 'failed', error: { code: 'worker_failed', message: 'out of memory' } });
  });

  it('records, replaces and clears an attempt', async () => {
    const { records } = await setup();
    await records.create(manifest());
    await records.markDerivative('scene-1', 'preview', { state: 'running', jobId: 'j1', at: 'a' });
    expect(summarizeDerivatives(records.get('scene-1')).preview.state).toBe('running');
    await records.markDerivative('scene-1', 'preview', { state: 'failed', jobId: 'j1', at: 'b', error: { code: 'c', message: 'd' } });
    expect(summarizeDerivatives(records.get('scene-1')).preview.state).toBe('failed');
    await records.markDerivative('scene-1', 'preview', null);
    expect(summarizeDerivatives(records.get('scene-1')).preview.state).toBe('missing');
    await expect(records.markDerivative('unknown', 'preview', { state: 'running', jobId: 'j', at: 'a' })).resolves.toBeUndefined();
  });

  it('forgets "running" notes after a restart but keeps the reasons for failures', async () => {
    const { records, store } = await setup();
    await records.create(manifest());
    await records.markDerivative('scene-1', 'preview', { state: 'running', jobId: 'j1', at: 'a' });
    await records.markDerivative('scene-1', 'runtime', { state: 'failed', jobId: 'j1', at: 'a', error: { code: 'c', message: 'd' } });
    await records.clearStaleRunning();
    expect(records.get('scene-1').derivatives).toEqual({ runtime: { state: 'failed', jobId: 'j1', at: 'a', error: { code: 'c', message: 'd' } } });
    expect(Object.keys(store.snapshot().spatial ?? {})).toEqual(['scene-1']);
  });
});
