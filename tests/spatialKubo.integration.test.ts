import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { KuboClient } from '../src/ipfs/kuboClient.js';
import { importWorkerVariant } from '../src/spatial/derivativeImport.js';
import { kuboBinary, kuboRaw, startDisposableKubo, type DisposableKubo } from './helpers/disposableKubo.js';

/**
 * Flat immutable bundles against a REAL Kubo (evidence class: CONTAINER-less
 * integration - a real daemon in a throwaway repository, no mocks).
 *
 * Skipped unless KUBUS_TEST_KUBO_BIN points at a Kubo binary. The unit suites
 * fake Kubo; these tests exist to check the facts those fakes assume - what
 * `files/stat` reports, how `cat` ranges inside a bundle behave, and which
 * blocks survive garbage collection once something is unpinned.
 */
const enabled = Boolean(kuboBinary());

const BLOCK = 262_144; // Kubo's default chunk size

const bytes = (length: number, seed: number) => Buffer.from(Array.from({ length }, (_, index) => (index * 31 + seed) % 253));

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

async function writeFiles(files: Record<string, Buffer>): Promise<{ dir: string; names: string[] }> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'kubus-bundle-'));
  dirs.push(dir);
  for (const [name, content] of Object.entries(files)) await fs.writeFile(path.join(dir, name), content);
  return { dir, names: Object.keys(files) };
}

async function gc(apiUrl: string): Promise<void> {
  await kuboRaw(apiUrl, 'repo/gc');
}

async function readAll(stream: ReadableStream<Uint8Array>): Promise<Buffer> {
  return Buffer.from(await new Response(stream).arrayBuffer());
}

describe.skipIf(!enabled)('flat bundles on a real Kubo', () => {
  let kubo: DisposableKubo;
  let client: KuboClient;

  beforeAll(async () => {
    kubo = await startDisposableKubo();
    client = new KuboClient(kubo.apiUrl, 60_000);
  }, 60_000);
  afterAll(async () => { await kubo?.stop(); });

  // A "paged runtime" shaped like RAD: a small entry and chunks, one of which
  // spans more than one Kubo block so ranges can cross a block boundary.
  const entry = Buffer.concat([Buffer.from('RAD0'), bytes(60, 1)]);
  const chunk0 = bytes(BLOCK + 40_000, 2);
  const chunk1 = bytes(1_000, 3);

  it('adds a flat bundle as one root whose listing, per-file CIDs and sizes are exactly the files', async () => {
    const { dir, names } = await writeFiles({ 'scene.rad': entry, 'scene-0.radc': chunk0, 'scene-1.radc': chunk1 });
    const added = await client.addDirectoryStreamed(dir, names);
    expect(added.rootCid).toMatch(/^(Qm|bafy)/);
    expect((await client.listBundle(added.rootCid)).sort()).toEqual([...names].sort());
    expect(added.files.map((file) => file.sizeBytes)).toEqual([entry.length, chunk0.length, chunk1.length]);

    for (const file of added.files) {
      const stat = await client.fileStat(added.rootCid, file.name);
      // `files/stat` reports the content size (not the DAG size) and the file's own CID,
      // which is what makes it usable as a Content-Length and a strong ETag.
      expect(stat).toEqual({ hash: file.cid, sizeBytes: file.sizeBytes, type: 'file' });
    }
    expect(await client.fileStat(added.rootCid, 'missing.radc')).toBeNull();
    // The directory itself is not a servable file.
    expect(added.files.length).toBe(3);
  });

  it('gives the same file the same CID whether it is added alone or inside a bundle', async () => {
    const { dir, names } = await writeFiles({ 'scene.rad': entry, 'scene-0.radc': chunk0 });
    const added = await client.addDirectoryStreamed(dir, names);
    const alone = await client.addFileStreamed(path.join(dir, 'scene-0.radc'), 'scene-0.radc');
    expect(alone.Hash).toBe(added.files.find((file) => file.name === 'scene-0.radc')!.cid);
  });

  it('streams a whole bundle file, and any byte range of it, exactly - including across a block boundary', async () => {
    const { dir, names } = await writeFiles({ 'scene.rad': entry, 'scene-0.radc': chunk0, 'scene-1.radc': chunk1 });
    const { rootCid } = await client.addDirectoryStreamed(dir, names);

    const whole = await client.catStream(rootCid, undefined, 'scene-0.radc');
    expect((await readAll(whole.body)).equals(chunk0)).toBe(true);

    for (const [offset, length] of [[0, 1], [10, 20], [BLOCK - 50, 100], [BLOCK, 10], [chunk0.length - 7, 7], [BLOCK - 1, 2]] as const) {
      const part = await client.catStream(rootCid, { offset, length }, 'scene-0.radc');
      const got = await readAll(part.body);
      expect(got.length, `${offset}+${length}`).toBe(length);
      expect(got.equals(chunk0.subarray(offset, offset + length)), `${offset}+${length}`).toBe(true);
    }
    const small = await client.catStream(rootCid, undefined, 'scene-1.radc');
    expect((await readAll(small.body)).equals(chunk1)).toBe(true);
  });

  it('refuses a name that is not a single plain file name before it reaches Kubo', async () => {
    const { dir, names } = await writeFiles({ 'scene.rad': entry });
    const { rootCid } = await client.addDirectoryStreamed(dir, names);
    for (const name of ['../scene.rad', 'a/b', '..', '.hidden', '', 'scene.rad/', 'a b']) {
      await expect(client.fileStat(rootCid, name), name).rejects.toThrow('kubo_bundle_name_invalid');
      await expect(client.catStream(rootCid, undefined, name), name).rejects.toThrow('kubo_bundle_name_invalid');
    }
    await expect(client.addDirectoryStreamed(dir, ['../escape'])).rejects.toThrow('kubo_add_directory_name_invalid');
    await expect(client.addDirectoryStreamed(dir, ['scene.rad', 'scene.rad'])).rejects.toThrow('kubo_add_directory_duplicate_name');
    await expect(client.addDirectoryStreamed(dir, [])).rejects.toThrow('kubo_add_directory_empty');
  });

  it('imports a worker bundle end to end and reports exactly what Kubo stored', async () => {
    const out = await fs.mkdtemp(path.join(os.tmpdir(), 'kubus-worker-out-'));
    dirs.push(out);
    await fs.mkdir(path.join(out, 'runtime'));
    await fs.writeFile(path.join(out, 'runtime', 'scene.rad'), entry);
    await fs.writeFile(path.join(out, 'runtime', 'scene-0.radc'), chunk0);
    await fs.writeFile(path.join(out, 'runtime', 'scene-1.radc'), chunk1);

    const variant = await importWorkerVariant(client, out, {
      role: 'spatial_mobile', mimeType: 'application/octet-stream', format: 'rad',
      bundle: { directory: 'runtime', entrypoint: 'scene.rad', files: ['scene.rad', 'scene-0.radc', 'scene-1.radc'] },
    }, 'spatial_mobile');

    expect(variant).toMatchObject({ role: 'spatial_mobile', entrypoint: 'scene.rad', fileCount: 3, storageClass: 'warm', format: 'rad' });
    expect(variant.sizeBytes).toBe(entry.length + chunk0.length + chunk1.length);
    expect(variant.cid).toBeUndefined();
    expect(await client.hasAllBlocksLocally(variant.rootCid!)).toBe(true);
    const stat = await client.fileStat(variant.rootCid!, 'scene.rad');
    expect(stat?.sizeBytes).toBe(entry.length);
  });

  it('imports a worker file the same way and brings a preserved master back to disk byte for byte', async () => {
    const out = await fs.mkdtemp(path.join(os.tmpdir(), 'kubus-worker-out-'));
    dirs.push(out);
    const master = bytes(BLOCK * 2 + 123, 4);
    await fs.writeFile(path.join(out, 'result.ply'), master);
    const variant = await importWorkerVariant(client, out, { role: 'spatial_archive', path: 'result.ply', mimeType: 'application/octet-stream', format: 'ply' }, 'spatial_archive');
    expect(variant).toMatchObject({ role: 'spatial_archive', storageClass: 'cold', sizeBytes: master.length });

    const back = path.join(out, 'master.ply');
    expect(await client.catToFile(variant.cid!, back)).toBe(master.length);
    expect((await fs.readFile(back)).equals(master)).toBe(true);
  });

  describe('pinning and garbage collection', () => {
    it('a recursive pin of the root keeps every file; unpinning it releases the bundle as a unit', async () => {
      const { dir, names } = await writeFiles({ 'scene.rad': bytes(500, 11), 'scene-0.radc': bytes(BLOCK + 5, 12) });
      const { rootCid } = await client.addDirectoryStreamed(dir, names);
      await gc(kubo.apiUrl);
      expect(await client.hasAllBlocksLocally(rootCid)).toBe(true);

      await client.pinRm(rootCid);
      await gc(kubo.apiUrl);
      expect(await client.hasAllBlocksLocally(rootCid)).toBe(false);
    });

    it('unpinning one bundle never removes a block another pinned bundle still needs', async () => {
      const shared = bytes(BLOCK + 900, 21);
      const a = await writeFiles({ 'scene.rad': bytes(300, 22), 'shared.radc': shared, 'only-a.radc': bytes(BLOCK + 17, 23) });
      const b = await writeFiles({ 'scene.rad': bytes(310, 24), 'shared.radc': shared });
      const bundleA = await client.addDirectoryStreamed(a.dir, a.names);
      const bundleB = await client.addDirectoryStreamed(b.dir, b.names);
      expect(bundleA.files.find((file) => file.name === 'shared.radc')!.cid).toBe(bundleB.files.find((file) => file.name === 'shared.radc')!.cid);

      await client.pinRm(bundleA.rootCid);
      await gc(kubo.apiUrl);

      expect(await client.hasAllBlocksLocally(bundleA.rootCid)).toBe(false);
      expect(await client.hasAllBlocksLocally(bundleB.rootCid)).toBe(true);
      const survivor = await client.catStream(bundleB.rootCid, undefined, 'shared.radc');
      expect((await readAll(survivor.body)).equals(shared)).toBe(true);
    });

    it('characterisation: a DIRECT pin of a bundle root does not protect its files - the pin policy must stay recursive', async () => {
      const { dir, names } = await writeFiles({ 'scene.rad': bytes(400, 31), 'scene-0.radc': bytes(BLOCK + 9, 32) });
      const { rootCid } = await client.addDirectoryStreamed(dir, names);
      await client.pinRm(rootCid);
      await kuboRaw(kubo.apiUrl, 'pin/add', { arg: rootCid, recursive: 'false' });
      await gc(kubo.apiUrl);
      // The root block is kept, the files it names are collected: a manifest that
      // pointed at this root would resolve to an empty shell.
      expect(await client.hasAllBlocksLocally(rootCid)).toBe(false);
      await kuboRaw(kubo.apiUrl, 'pin/rm', { arg: rootCid });
    });

    it('KuboClient.pinAdd pins recursively, so a re-pin after a partial loss restores the whole bundle', async () => {
      const { dir, names } = await writeFiles({ 'scene.rad': bytes(200, 41), 'scene-0.radc': bytes(BLOCK + 3, 42) });
      const { rootCid } = await client.addDirectoryStreamed(dir, names);
      await client.pinRm(rootCid);
      await client.pinAdd(rootCid);
      await gc(kubo.apiUrl);
      expect(await client.hasAllBlocksLocally(rootCid)).toBe(true);
      const pins = JSON.parse(await kuboRaw(kubo.apiUrl, 'pin/ls', { arg: rootCid, type: 'recursive' })) as { Keys: Record<string, { Type: string }> };
      expect(pins.Keys[rootCid]?.Type).toBe('recursive');
    });
  });
});
