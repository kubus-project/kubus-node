import { afterEach, describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import { createReadStream } from 'node:fs';
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { CaptureStore, type CaptureDraftPayload } from '../src/captures/captureStore.js';
import { LocalStore } from '../src/state/localStore.js';

const dirs: string[] = [];
afterEach(async () =>
  Promise.all(dirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true }))),
);

async function newStore(): Promise<CaptureStore> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'kubus-capture-stream-'));
  dirs.push(dir);
  const local = new LocalStore(path.join(dir, 'state.json'));
  await local.load();
  return new CaptureStore(dir, local);
}

/**
 * Uploads the canonical frame document every `kubus.capture/1` package must
 * carry, referencing images already streamed into the draft. Returns its size
 * so a test can still assert exact byte accounting.
 */
async function addFrames(store: CaptureStore, draftId: string, rgbPaths: string[]): Promise<number> {
  const document = Buffer.from(
    `${JSON.stringify({ schema: 'kubus.capture.frames/1', frames: rgbPaths.map((rgbPath) => ({ rgbPath })) })}
`,
  );
  await store.writeDraftFile(draftId, 'frames.json', document, 'application/json');
  return document.byteLength;
}

/**
 * Backdates a draft's activity marker, standing in for a transfer whose owner
 * died rather than one that is merely between files.
 */
async function ageDraftMarker(directory: string, ms: number): Promise<void> {
  const marker = path.join(directory, '.draft.json');
  const when = new Date(Date.now() - ms);
  await fs.utimes(marker, when, when);
}

/** A second process over the same data root, as `kubus-node status` is. */
async function attachStore(dataRoot: string): Promise<CaptureStore> {
  const local = new LocalStore(path.join(dataRoot, 'state.json'));
  await local.load();
  return new CaptureStore(dataRoot, local);
}

const draftPayload: CaptureDraftPayload = {
  schema: 'kubus.capture/1',
  artworkId: 'art-1',
  capturedAt: '2026-01-01T00:00:00.000Z',
  metadata: { source: 'art.kubus-mobile-tracking', private: true },
};

describe('streaming capture upload', () => {
  it.each([10, 50, 95])('converges a 110 MiB streamed file after interruption at %i percent', async (percentage) => {
    const store = await newStore();
    const payload = { ...draftPayload, metadata: { ...draftPayload.metadata, localCaptureId: `large-${percentage}` } };
    const draft = await store.beginDraft(payload);
    const chunk = Buffer.alloc(256 * 1024, 0x6b);
    const chunkCount = 440;
    const interrupted = async function* () {
      for (let index = 0; index < Math.floor(chunkCount * percentage / 100); index++) yield chunk;
      throw new Error('simulated transport interruption');
    };
    await expect(store.writeDraftFileStream(draft.id, 'payload.bin', interrupted())).rejects.toThrow('simulated transport interruption');
    expect((await store.getDraft(draft.id)).files).toEqual([]);
    expect((await store.getDraft(draft.id)).sizeBytes).toBe(0);
    const expected = createHash('sha256');
    const complete = async function* () {
      for (let index = 0; index < chunkCount; index++) { expected.update(chunk); yield chunk; }
    };
    await store.writeDraftFileStream(draft.id, 'payload.bin', complete());
    await store.writeDraftFile(draft.id, 'rgb/00000.jpg', Buffer.alloc(16, 7), 'image/jpeg');
    const framesBytes = await addFrames(store, draft.id, ['rgb/00000.jpg']);
    const record = await store.commitDraft(draft.id);
    expect(record.sizeBytes).toBe(110 * 1024 * 1024 + 16 + framesBytes);
    const actual = createHash('sha256');
    for await (const bytes of createReadStream(path.join(record.directory, 'payload.bin'))) actual.update(bytes);
    expect(actual.digest('hex')).toBe(expected.digest('hex'));
    const retry = await store.beginDraft(payload);
    await store.writeDraftFile(retry.id, 'payload.bin', chunk);
    expect((await store.commitDraft(retry.id)).id).toBe(record.id);
    expect(store.list()).toHaveLength(1);
  }, 30000);

  it('stores files as raw bytes without base64 on the wire', async () => {
    const store = await newStore();
    const draft = await store.beginDraft(draftPayload);

    const payload = Buffer.from([0xff, 0xd8, 0xff, 0x00, 0x01]);
    await store.writeDraftFile(draft.id, 'rgb/00000.jpg', payload, 'image/jpeg');
    const framesBytes = await addFrames(store, draft.id, ['rgb/00000.jpg']);
    const record = await store.commitDraft(draft.id);

    const written = await fs.readFile(path.join(record.directory, 'rgb/00000.jpg'));
    expect(written.equals(payload)).toBe(true);
    expect(record.sizeBytes).toBe(payload.byteLength + framesBytes);
    expect(record.fileCount).toBe(2);
    expect(record.state).toBe('stored');
    expect(record.private).toBe(true);
  });

  it('writes a multi-chunk request without requiring one whole-file buffer', async () => {
    const store = await newStore();
    const draft = await store.beginDraft(draftPayload);
    const chunks = async function* () {
      yield Buffer.from('first-');
      yield Buffer.from('second-');
      yield Buffer.from('third');
    };

    const progress = await store.writeDraftFileStream(draft.id, 'rgb/00000.jpg', chunks(), 'image/jpeg');
    await addFrames(store, draft.id, ['rgb/00000.jpg']);
    const record = await store.commitDraft(draft.id);
    const written = await fs.readFile(path.join(record.directory, 'rgb/00000.jpg'), 'utf8');

    expect(written).toBe('first-second-third');
    expect(progress.sizeBytes).toBe(Buffer.byteLength(written));
  });

  it('accumulates size and file count across appends', async () => {
    const store = await newStore();
    const draft = await store.beginDraft(draftPayload);

    await store.writeDraftFile(draft.id, 'rgb/00000.jpg', Buffer.alloc(100));
    const progress = await store.writeDraftFile(draft.id, 'depth/00000.bin', Buffer.alloc(50));

    expect(progress.fileCount).toBe(2);
    expect(progress.sizeBytes).toBe(150);
  });

  it('re-uploading a path overwrites instead of duplicating', async () => {
    const store = await newStore();
    const draft = await store.beginDraft(draftPayload);

    await store.writeDraftFile(draft.id, 'rgb/00000.jpg', Buffer.alloc(100));
    const progress = await store.writeDraftFile(draft.id, 'rgb/00000.jpg', Buffer.alloc(40));

    // A client retrying an interrupted transfer must converge, not double up.
    expect(progress.fileCount).toBe(1);
    expect(progress.sizeBytes).toBe(40);
  });

  it('reports progress so an interrupted transfer can resume', async () => {
    const store = await newStore();
    const draft = await store.beginDraft(draftPayload);
    await store.writeDraftFile(draft.id, 'rgb/00000.jpg', Buffer.alloc(10));
    await store.writeDraftFile(draft.id, 'rgb/00001.jpg', Buffer.alloc(10));

    const progress = await store.getDraft(draft.id);

    expect(progress.files).toEqual(['rgb/00000.jpg', 'rgb/00001.jpg']);
    expect(progress.sizeBytes).toBe(20);
  });

  it('writes a manifest listing every uploaded file', async () => {
    const store = await newStore();
    const draft = await store.beginDraft(draftPayload);
    await store.writeDraftFile(draft.id, 'rgb/00000.jpg', Buffer.alloc(4), 'image/jpeg');
    await store.writeDraftFile(draft.id, 'transforms.json', Buffer.from('{}'), 'application/json');
    await addFrames(store, draft.id, ['rgb/00000.jpg']);

    const record = await store.commitDraft(draft.id);

    const manifest = JSON.parse(
      await fs.readFile(path.join(record.directory, 'capture.json'), 'utf8'),
    );
    expect(manifest.schema).toBe('kubus.capture/1');
    expect(manifest.artworkId).toBe('art-1');
    expect(manifest.files).toEqual([
      { path: 'rgb/00000.jpg', mimeType: 'image/jpeg' },
      { path: 'transforms.json', mimeType: 'application/json' },
      { path: 'frames.json', mimeType: 'application/json' },
    ]);
    // The manifest records paths only: bytes live on disk, never inline.
    expect(JSON.stringify(manifest)).not.toContain('contentBase64');
  });

  it('a committed capture is retrievable like any other', async () => {
    const store = await newStore();
    const draft = await store.beginDraft(draftPayload);
    await store.writeDraftFile(draft.id, 'rgb/00000.jpg', Buffer.alloc(8));
    await addFrames(store, draft.id, ['rgb/00000.jpg']);

    const record = await store.commitDraft(draft.id);

    expect(store.get(record.id).id).toBe(record.id);
    expect(store.list().map((r) => r.id)).toContain(record.id);
  });
});

describe('streaming capture validation', () => {
  it('rejects a path escaping the capture directory', async () => {
    const store = await newStore();
    const draft = await store.beginDraft(draftPayload);

    await expect(
      store.writeDraftFile(draft.id, '../escape.jpg', Buffer.alloc(4)),
    ).rejects.toMatchObject({ statusCode: 400, code: 'capture_file_path_invalid' });
  });

  it('contains an absolute-looking path inside the capture directory', async () => {
    const store = await newStore();
    const draft = await store.beginDraft(draftPayload);

    // Leading slashes are stripped rather than rejected, so the write lands
    // under the capture directory instead of escaping to a system path.
    await store.writeDraftFile(draft.id, '/etc/passwd', Buffer.alloc(4));
    await addFrames(store, draft.id, ['etc/passwd']);
    const record = await store.commitDraft(draft.id);

    const written = path.join(record.directory, 'etc/passwd');
    await expect(fs.access(written)).resolves.toBeUndefined();
    expect(written.startsWith(record.directory)).toBe(true);
  });

  it('rejects a Windows-style path escaping the capture directory', async () => {
    const store = await newStore();
    const draft = await store.beginDraft(draftPayload);

    await expect(
      store.writeDraftFile(draft.id, '..\\..\\escape.jpg', Buffer.alloc(4)),
    ).rejects.toMatchObject({ statusCode: 400, code: 'capture_file_path_invalid' });
  });

  it('rejects an invalid draft payload', async () => {
    const store = await newStore();

    await expect(
      store.beginDraft({ ...draftPayload, capturedAt: '' }),
    ).rejects.toMatchObject({ statusCode: 400, code: 'capture_package_invalid' });
  });

  it('rejects writes to an unknown draft', async () => {
    const store = await newStore();

    await expect(
      store.writeDraftFile('nope', 'rgb/0.jpg', Buffer.alloc(4)),
    ).rejects.toMatchObject({ statusCode: 404, code: 'capture_draft_not_found' });
  });

  it('refuses to commit an empty capture', async () => {
    const store = await newStore();
    const draft = await store.beginDraft(draftPayload);

    await expect(store.commitDraft(draft.id)).rejects.toMatchObject({ statusCode: 400, code: 'capture_package_empty' });
  });
});

describe('concurrent draft accounting', () => {
  it('parallel uploads to one draft do not lose size', async () => {
    const store = await newStore();
    const draft = await store.beginDraft(draftPayload);

    // Read-modify-write around filesystem awaits: without serialization both
    // requests compute their total from the same pre-write value and the last
    // writer clobbers the other, reporting 100 bytes for 200 written.
    await Promise.all([
      store.writeDraftFile(draft.id, 'rgb/00000.jpg', Buffer.alloc(100)),
      store.writeDraftFile(draft.id, 'rgb/00001.jpg', Buffer.alloc(100)),
    ]);

    const progress = await store.getDraft(draft.id);
    expect(progress.fileCount).toBe(2);
    expect(progress.sizeBytes).toBe(200);
  });

  it('many parallel uploads stay consistent', async () => {
    const store = await newStore();
    const draft = await store.beginDraft(draftPayload);

    await Promise.all(
      Array.from({ length: 25 }, (_, i) =>
        store.writeDraftFile(draft.id, `rgb/${String(i).padStart(5, '0')}.jpg`, Buffer.alloc(10)),
      ),
    );

    const progress = await store.getDraft(draft.id);
    expect(progress.fileCount).toBe(25);
    expect(progress.sizeBytes).toBe(250);
    expect(progress.files).toHaveLength(25);
  });

  it('parallel overwrites of one path settle on a single file', async () => {
    const store = await newStore();
    const draft = await store.beginDraft(draftPayload);

    await Promise.all([
      store.writeDraftFile(draft.id, 'rgb/00000.jpg', Buffer.alloc(30)),
      store.writeDraftFile(draft.id, 'rgb/00000.jpg', Buffer.alloc(30)),
    ]);

    const progress = await store.getDraft(draft.id);
    expect(progress.fileCount).toBe(1);
    expect(progress.sizeBytes).toBe(30);
  });

  it('a rejected upload does not poison later uploads on the same draft', async () => {
    const store = await newStore();
    const draft = await store.beginDraft(draftPayload);

    await expect(
      store.writeDraftFile(draft.id, '../escape.jpg', Buffer.alloc(4)),
    ).rejects.toBeTruthy();

    const progress = await store.writeDraftFile(draft.id, 'rgb/00000.jpg', Buffer.alloc(12));
    expect(progress.fileCount).toBe(1);
    expect(progress.sizeBytes).toBe(12);
  });
});

describe('orphaned draft reclamation', () => {
  it('removes a capture directory left by a restart mid-upload', async () => {
    const store = await newStore();
    const draft = await store.beginDraft(draftPayload);
    await store.writeDraftFile(draft.id, 'rgb/00000.jpg', Buffer.alloc(64));

    // Simulate a restart: the in-memory draft is gone, the directory is not,
    // and nothing has written to it since.
    await store.forgetDraftsForTesting();
    await ageDraftMarker(draft.directory, 60 * 60 * 1000);
    await expect(fs.access(draft.directory)).resolves.toBeUndefined();

    const reclaimed = await store.reclaimOrphanedDirectories();

    expect(reclaimed).toBe(1);
    await expect(fs.access(draft.directory)).rejects.toThrow();
  });

  it('never removes a committed capture', async () => {
    const store = await newStore();
    const draft = await store.beginDraft(draftPayload);
    await store.writeDraftFile(draft.id, 'rgb/00000.jpg', Buffer.alloc(8));
    await addFrames(store, draft.id, ['rgb/00000.jpg']);
    const record = await store.commitDraft(draft.id);

    const reclaimed = await store.reclaimOrphanedDirectories();

    expect(reclaimed).toBe(0);
    await expect(fs.access(record.directory)).resolves.toBeUndefined();
    expect(store.get(record.id).id).toBe(record.id);
  });

  it('never removes an upload still in progress', async () => {
    const store = await newStore();
    const draft = await store.beginDraft(draftPayload);
    await store.writeDraftFile(draft.id, 'rgb/00000.jpg', Buffer.alloc(8));

    const reclaimed = await store.reclaimOrphanedDirectories();

    expect(reclaimed).toBe(0);
    await expect(fs.access(draft.directory)).resolves.toBeUndefined();
  });

  it('is safe to run when no captures exist', async () => {
    const store = await newStore();

    await expect(store.reclaimOrphanedDirectories()).resolves.toBe(0);
  });
});

describe('commit idempotency', () => {
  const keyed: CaptureDraftPayload = {
    ...draftPayload,
    metadata: { ...draftPayload.metadata, localCaptureId: 'capture-local-1' },
  };

  it('a retry after a lost commit response returns the same capture', async () => {
    const store = await newStore();
    const first = await store.beginDraft(keyed);
    await store.writeDraftFile(first.id, 'rgb/00000.jpg', Buffer.alloc(8));
    await addFrames(store, first.id, ['rgb/00000.jpg']);
    const committed = await store.commitDraft(first.id);

    // The client never saw the response, so it uploads a fresh draft and
    // commits again with the same local capture id.
    const retry = await store.beginDraft(keyed);
    await store.writeDraftFile(retry.id, 'rgb/00000.jpg', Buffer.alloc(8));
    await addFrames(store, retry.id, ['rgb/00000.jpg']);
    const second = await store.commitDraft(retry.id);

    expect(second.id).toBe(committed.id);
    expect(store.list()).toHaveLength(1);
  });

  it('a redundant retry leaves no stranded directory', async () => {
    const store = await newStore();
    const first = await store.beginDraft(keyed);
    await store.writeDraftFile(first.id, 'rgb/00000.jpg', Buffer.alloc(8));
    await addFrames(store, first.id, ['rgb/00000.jpg']);
    await store.commitDraft(first.id);

    const retry = await store.beginDraft(keyed);
    await store.writeDraftFile(retry.id, 'rgb/00000.jpg', Buffer.alloc(8));
    await addFrames(store, retry.id, ['rgb/00000.jpg']);
    await store.commitDraft(retry.id);

    await expect(fs.access(retry.directory)).rejects.toThrow();
    expect(await store.reclaimOrphanedDirectories()).toBe(0);
  });

  it('distinct local capture ids still create distinct captures', async () => {
    const store = await newStore();
    for (const id of ['capture-local-1', 'capture-local-2']) {
      const draft = await store.beginDraft({
        ...draftPayload,
        metadata: { ...draftPayload.metadata, localCaptureId: id },
      });
      await store.writeDraftFile(draft.id, 'rgb/00000.jpg', Buffer.alloc(8));
      await addFrames(store, draft.id, ['rgb/00000.jpg']);
      await store.commitDraft(draft.id);
    }

    expect(store.list()).toHaveLength(2);
  });

  it('captures without an idempotency key keep the previous behaviour', async () => {
    const store = await newStore();
    for (let i = 0; i < 2; i++) {
      const draft = await store.beginDraft(draftPayload);
      await store.writeDraftFile(draft.id, 'rgb/00000.jpg', Buffer.alloc(8));
      await addFrames(store, draft.id, ['rgb/00000.jpg']);
      await store.commitDraft(draft.id);
    }

    expect(store.list()).toHaveLength(2);
  });
});

describe('streaming capture lifecycle', () => {
  it('discarding a draft deletes everything uploaded', async () => {
    const store = await newStore();
    const draft = await store.beginDraft(draftPayload);
    await store.writeDraftFile(draft.id, 'rgb/00000.jpg', Buffer.alloc(16));

    await store.discardDraft(draft.id);

    await expect(fs.access(draft.directory)).rejects.toThrow();
    await expect(store.getDraft(draft.id)).rejects.toThrow();
  });

  it('a committed draft can no longer be appended to', async () => {
    const store = await newStore();
    const draft = await store.beginDraft(draftPayload);
    await store.writeDraftFile(draft.id, 'rgb/00000.jpg', Buffer.alloc(4));
    await addFrames(store, draft.id, ['rgb/00000.jpg']);
    await store.commitDraft(draft.id);

    await expect(
      store.writeDraftFile(draft.id, 'rgb/00001.jpg', Buffer.alloc(4)),
    ).rejects.toMatchObject({ statusCode: 404, code: 'capture_draft_not_found' });
  });

  it('the existing JSON endpoint is unchanged', async () => {
    const store = await newStore();

    // Additive change: the base64 package path must keep working for clients
    // that have not migrated.
    const record = await store.create({
      schema: 'kubus.capture/1',
      capturedAt: '2026-01-01T00:00:00.000Z',
      metadata: { private: true },
      files: [{ path: 'rgb/00000.jpg', contentBase64: Buffer.alloc(6).toString('base64') }],
    });

    expect(record.fileCount).toBe(1);
    expect(record.sizeBytes).toBe(6);
  });
});

describe('reclamation against a concurrently serving process', () => {
  /**
   * Reproduces the transfer corruption seen on a real node.
   *
   * The container healthcheck runs `kubus-node status`, which is a second
   * process over the same data root. Its `CaptureStore` has an empty draft
   * map, so every in-flight upload directory looks orphaned to it. The
   * serving process keeps its accounting in memory and never notices, so the
   * commit reports a complete package over a directory that has been emptied.
   */
  it('a second process must not reclaim a draft the serving process is filling', async () => {
    const serving = await newStore();
    const draft = await serving.beginDraft(draftPayload);
    const rgbPaths = Array.from({ length: 10 }, (_, index) => `rgb/0000${index}.jpg`);
    for (let index = 0; index < 5; index++) {
      await serving.writeDraftFile(draft.id, rgbPaths[index]!, Buffer.alloc(64, index));
    }

    const healthcheck = await attachStore(path.resolve(draft.directory, '..', '..', '..'));
    await healthcheck.reclaimOrphanedDirectories();

    for (let index = 5; index < 10; index++) {
      await serving.writeDraftFile(draft.id, rgbPaths[index]!, Buffer.alloc(64, index));
    }
    await addFrames(serving, draft.id, rgbPaths);
    const record = await serving.commitDraft(draft.id);

    const manifest = JSON.parse(await fs.readFile(path.join(record.directory, 'capture.json'), 'utf8')) as {
      files: Array<{ path: string }>;
    };
    const missing: string[] = [];
    for (const file of manifest.files) {
      try {
        await fs.access(path.join(record.directory, file.path));
      } catch {
        missing.push(file.path);
      }
    }
    expect(missing).toEqual([]);
    expect(record.fileCount).toBe(11);
  });
});
