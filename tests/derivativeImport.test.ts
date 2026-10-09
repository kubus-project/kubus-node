import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ImportError, importWorkerVariant, provenanceFrom, type WorkerVariant } from '../src/spatial/derivativeImport.js';

/**
 * Everything a worker returns is input to this process: it is a separate
 * container writing to a shared directory. These tests give the importer real
 * directories (including symlinks pointing out of them) and a Kubo fake that
 * records every call, so "rejected" also means "nothing was sent to Kubo".
 */

const ROOT_CID = 'QmRPWQYEcANkuhUjxcbr1tApnGSHrqw1vkWM29tF7eBb2d';

class RecordingKubo {
  readonly files: Array<{ path: string; name: string }> = [];
  readonly directories: Array<{ directory: string; names: string[] }> = [];
  fileHash: string | undefined = 'QmFileHash0000000000000000000000000000000000';
  listing: string[] | undefined;

  async addFileStreamed(filePath: string, name: string) {
    this.files.push({ path: filePath, name });
    return { Hash: this.fileHash };
  }

  async addDirectoryStreamed(directory: string, names: string[]) {
    this.directories.push({ directory, names });
    const files = await Promise.all(names.map(async (name) => ({ name, cid: `Qm${name}`, sizeBytes: (await fs.stat(path.join(directory, name))).size })));
    return { rootCid: ROOT_CID, files };
  }

  async listBundle() {
    return this.listing ?? this.directories.at(-1)!.names;
  }

  get calls(): number {
    return this.files.length + this.directories.length;
  }
}

let out: string;
let outside: string;
let kubo: RecordingKubo;
const dirs: string[] = [];

beforeEach(async () => {
  out = await fs.mkdtemp(path.join(os.tmpdir(), 'kubus-import-out-'));
  outside = await fs.mkdtemp(path.join(os.tmpdir(), 'kubus-import-outside-'));
  dirs.push(out, outside);
  kubo = new RecordingKubo();
});
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

const file = (extra: Partial<WorkerVariant> = {}): WorkerVariant => ({ role: 'spatial_archive', path: 'result.ply', mimeType: 'application/octet-stream', format: 'ply', ...extra });
const bundle = (files: string[], extra: Partial<WorkerVariant> = {}, entrypoint = files[0]!): WorkerVariant => ({
  role: 'spatial_mobile', mimeType: 'application/octet-stream', format: 'rad', bundle: { directory: 'runtime', entrypoint, files }, ...extra,
});

async function importIt(variant: WorkerVariant, role: Parameters<typeof importWorkerVariant>[3] = variant.role) {
  return importWorkerVariant(kubo as never, out, variant, role);
}

async function expectRejected(variant: WorkerVariant, code: string, role: Parameters<typeof importWorkerVariant>[3] = variant.role) {
  const failure = await importIt(variant, role).then(() => undefined, (error: unknown) => error);
  expect(failure).toBeInstanceOf(ImportError);
  expect((failure as ImportError).code).toBe(code);
  expect(kubo.calls).toBe(0);
}

async function makeBundle(files: Record<string, number>) {
  await fs.mkdir(path.join(out, 'runtime'), { recursive: true });
  for (const [name, size] of Object.entries(files)) await fs.writeFile(path.join(out, 'runtime', name), Buffer.alloc(size, 1));
}

describe('importing a single file', () => {
  it('streams the file from disk and describes it with the role policy, not the worker\'s word', async () => {
    await fs.writeFile(path.join(out, 'result.ply'), Buffer.alloc(1234, 1));
    const variant = await importIt(file({ storageClass: 'hot' }));
    expect(variant).toEqual({ role: 'spatial_archive', cid: kubo.fileHash, sizeBytes: 1234, mimeType: 'application/octet-stream', format: 'ply', storageClass: 'cold' });
    expect(kubo.files).toEqual([{ path: await fs.realpath(path.join(out, 'result.ply')), name: 'result.ply' }]);
  });

  it('applies the role policy to every role it stores', async () => {
    await fs.writeFile(path.join(out, 'result.ply'), 'x');
    expect((await importIt(file({ role: 'spatial_preview' }))).storageClass).toBe('hot');
    expect((await importIt(file({ role: 'spatial_mobile' }))).storageClass).toBe('warm');
    expect((await importIt(file({ role: 'spatial_archive' }))).storageClass).toBe('cold');
  });

  it('rejects a representation other than the one that was asked for', async () => {
    await fs.writeFile(path.join(out, 'result.ply'), 'x');
    await expectRejected(file({ role: 'spatial_archive' }), 'worker_output_invalid', 'spatial_preview');
  });

  it('refuses a role this Node does not store', async () => {
    await fs.writeFile(path.join(out, 'result.ply'), 'x');
    await expectRejected(file({ role: 'model3d' }), 'worker_output_invalid');
  });

  it('refuses a MIME type or format that is not plain', async () => {
    await fs.writeFile(path.join(out, 'result.ply'), 'x');
    for (const mimeType of ['', 'text/html; charset=utf-8', 'application/octet-stream\r\nX: y', 'nonsense', '../../etc', 'a/'.repeat(40)]) {
      await expectRejected(file({ mimeType }), 'worker_output_invalid');
    }
    for (const format of ['', 'ply!', 'PLY/../x', 'x'.repeat(17), 'p l']) {
      await expectRejected(file({ format }), 'worker_output_invalid');
    }
  });

  it('reports a file the worker named but did not write', async () => {
    await expectRejected(file(), 'worker_output_missing');
  });

  it('refuses a path that leaves the job directory, however it is spelled', async () => {
    await fs.writeFile(path.join(outside, 'secret.txt'), 'private');
    await expectRejected(file({ path: `../${path.basename(outside)}/secret.txt` }), 'worker_output_path_invalid');
    await expectRejected(file({ path: path.join(outside, 'secret.txt') }), 'worker_output_path_invalid');
  });

  it('refuses a symlink that points out of the job directory', async () => {
    await fs.writeFile(path.join(outside, 'secret.txt'), 'private');
    await fs.symlink(path.join(outside, 'secret.txt'), path.join(out, 'result.ply'));
    await expectRejected(file(), 'worker_output_path_invalid');
  });

  it('follows a symlink that stays inside, to the real file', async () => {
    await fs.writeFile(path.join(out, 'real.ply'), Buffer.alloc(9, 1));
    await fs.symlink('real.ply', path.join(out, 'result.ply'));
    const variant = await importIt(file());
    expect(variant.sizeBytes).toBe(9);
  });

  it('refuses a directory where a file was promised, and a variant with no file at all', async () => {
    await fs.mkdir(path.join(out, 'result.ply'));
    await expectRejected(file(), 'worker_output_invalid');
    await expectRejected(file({ path: undefined }), 'worker_output_invalid');
    await expectRejected(file({ path: '' }), 'worker_output_invalid');
  });

  it('fails when Kubo gives no CID back', async () => {
    await fs.writeFile(path.join(out, 'result.ply'), 'x');
    kubo.fileHash = undefined;
    await expect(importIt(file())).rejects.toMatchObject({ code: 'kubo_add_missing_cid' });
  });
});

describe('importing a bundle', () => {
  const NAMES = ['scene.rad', 'scene-0.radc', 'scene-1.radc'];

  it('adds the directory as one unit and reports exactly what Kubo stored', async () => {
    await makeBundle({ 'scene.rad': 64, 'scene-0.radc': 1000, 'scene-1.radc': 200 });
    const variant = await importIt(bundle(NAMES));
    expect(variant).toEqual({
      role: 'spatial_mobile', rootCid: ROOT_CID, entrypoint: 'scene.rad', fileCount: 3, sizeBytes: 64 + 1000 + 200,
      mimeType: 'application/octet-stream', format: 'rad', storageClass: 'warm',
    });
    expect(variant.cid).toBeUndefined();
    // Sorted, so the same bundle always produces the same directory, whatever order the worker listed it in.
    expect(kubo.directories).toHaveLength(1);
    expect(kubo.directories[0]!.names).toEqual([...NAMES].sort());
    expect(kubo.files).toHaveLength(0);
  });

  it('does not depend on the order the worker listed the files', async () => {
    await makeBundle({ 'scene.rad': 1, 'scene-0.radc': 1, 'scene-1.radc': 1 });
    const variant = await importIt(bundle(['scene-1.radc', 'scene.rad', 'scene-0.radc'], {}, 'scene.rad'));
    expect(variant.entrypoint).toBe('scene.rad');
    expect(variant.fileCount).toBe(3);
  });

  it('takes the storage class from the role', async () => {
    await makeBundle({ 'scene.rad': 1 });
    const variant = await importIt(bundle(['scene.rad'], { storageClass: 'cold' }));
    expect(variant.storageClass).toBe('warm');
  });

  it('refuses a listing that omits a file that was written, or names one that was not', async () => {
    await makeBundle({ 'scene.rad': 1, 'scene-0.radc': 1, 'scene-1.radc': 1 });
    await expectRejected(bundle(['scene.rad', 'scene-0.radc']), 'worker_output_invalid');
    await expectRejected(bundle(['scene.rad', 'scene-0.radc', 'scene-1.radc', 'scene-2.radc']), 'worker_output_invalid');
  });

  it('refuses anything in the bundle directory that is not a plain file', async () => {
    await makeBundle({ 'scene.rad': 1 });
    await fs.mkdir(path.join(out, 'runtime', 'nested'));
    await expectRejected(bundle(['scene.rad', 'nested']), 'worker_output_invalid');
  });

  it('refuses a symlinked file inside the bundle, which would publish whatever it points at', async () => {
    await makeBundle({ 'scene.rad': 1 });
    await fs.writeFile(path.join(outside, 'secret.txt'), 'private');
    await fs.symlink(path.join(outside, 'secret.txt'), path.join(out, 'runtime', 'chunk.radc'));
    await expectRejected(bundle(['scene.rad', 'chunk.radc']), 'worker_output_invalid');
  });

  it('refuses a bundle directory that is a symlink out of the job directory', async () => {
    await fs.writeFile(path.join(outside, 'scene.rad'), 'x');
    await fs.symlink(outside, path.join(out, 'runtime'));
    await expectRejected(bundle(['scene.rad']), 'worker_output_path_invalid');
  });

  it('reports a bundle directory the worker named but did not write', async () => {
    await expectRejected(bundle(['scene.rad']), 'worker_output_missing');
  });

  it('refuses unsafe, duplicate, empty or oversized listings', async () => {
    await makeBundle({ 'scene.rad': 1 });
    await expectRejected(bundle(['scene.rad', '../escape']), 'worker_output_invalid');
    await expectRejected(bundle(['scene.rad', 'sub/chunk.radc']), 'worker_output_invalid');
    await expectRejected(bundle(['scene.rad', '.hidden']), 'worker_output_invalid');
    await expectRejected(bundle(['scene.rad', 'scene.rad']), 'worker_output_invalid');
    await expectRejected(bundle([]), 'worker_output_invalid');
    await expectRejected(bundle(Array.from({ length: 20_001 }, (_, index) => `c${index}.radc`)), 'worker_output_invalid');
  });

  it('refuses an entrypoint that is unsafe or not in the bundle', async () => {
    await makeBundle({ 'scene.rad': 1, 'scene-0.radc': 1 });
    await expectRejected(bundle(['scene.rad', 'scene-0.radc'], {}, 'other.rad'), 'worker_output_invalid');
    await expectRejected(bundle(['scene.rad', 'scene-0.radc'], {}, '../scene.rad'), 'worker_output_invalid');
  });

  it('notices when Kubo stored fewer files than were sent', async () => {
    await makeBundle({ 'scene.rad': 1, 'scene-0.radc': 1, 'scene-1.radc': 1 });
    kubo.listing = ['scene.rad', 'scene-0.radc'];
    await expect(importIt(bundle(NAMES))).rejects.toMatchObject({ code: 'bundle_import_incomplete' });
    kubo.listing = ['scene.rad', 'scene-0.radc', 'scene-1.radc', 'extra.radc'];
    await expect(importIt(bundle(NAMES))).rejects.toMatchObject({ code: 'bundle_import_incomplete' });
  });
});

describe('derivative provenance', () => {
  const measured = { tool: 'spz', toolVersion: '3.0.0', sourceSplats: 200_000, splats: 100_000, sourceBytes: 49_600_000, bytes: 1, durationMs: 4200, settings: { version: 3, ratio: 0.5, mode: 'fast', strict: true } };

  it('records what the worker measured, with the imported size as the size', () => {
    expect(provenanceFrom(measured, 1_500_000)).toEqual({ ...measured, bytes: 1_500_000 });
  });

  it('drops a measurement that is not a whole, non-negative number instead of inventing one', () => {
    const result = provenanceFrom({ ...measured, sourceSplats: -1, splats: 1.5, sourceBytes: Number.NaN, durationMs: '9' as never }, 5);
    expect(result.sourceSplats).toBeUndefined();
    expect(result.splats).toBeUndefined();
    expect(result.sourceBytes).toBeUndefined();
    expect(result.durationMs).toBeUndefined();
    expect(provenanceFrom({ ...measured, splats: null }, 5).splats).toBeUndefined();
  });

  it('bounds and cleans what the worker says about itself', () => {
    const noisy = provenanceFrom({
      ...measured, tool: 'x'.repeat(200), toolVersion: 'y'.repeat(200),
      settings: { ok: 'z'.repeat(200), 'bad key': 1, '1leading': 2, nested: { a: 1 } as never, list: [1] as never, nul: null as never },
    }, 5);
    expect(noisy.tool).toHaveLength(64);
    expect(noisy.toolVersion).toHaveLength(64);
    expect(noisy.settings).toEqual({ ok: 'z'.repeat(64) });
  });

  it('keeps at most sixteen settings', () => {
    const settings = Object.fromEntries(Array.from({ length: 40 }, (_, index) => [`k${index}`, index]));
    expect(Object.keys(provenanceFrom({ ...measured, settings }, 5).settings!)).toHaveLength(16);
  });

  it('says "unknown" rather than leaving the tool blank', () => {
    const result = provenanceFrom({ tool: '', toolVersion: '', bytes: 1 }, 5);
    expect(result.tool).toBe('unknown');
    expect(result.toolVersion).toBe('unknown');
    expect(result.settings).toEqual({});
  });
});
