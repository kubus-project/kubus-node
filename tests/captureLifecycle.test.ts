import { afterEach, describe, expect, it, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CaptureStore, type CaptureDraftPayload } from '../src/captures/captureStore.js';
import { LocalStore } from '../src/state/localStore.js';
import { getCaptureDiagnostics } from '../src/gui/spatialGuiApi.js';

/**
 * The lifecycle around the integrity boundary: when abandoned uploads are
 * reclaimed, when a damaged replica may be replaced, and what untrusted
 * `frames.json` input is allowed to do to the process.
 */

const dirs: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(dirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

async function newNode(): Promise<{ dir: string; local: LocalStore; store: CaptureStore }> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'kubus-capture-lifecycle-'));
  dirs.push(dir);
  const local = new LocalStore(path.join(dir, 'state.json'));
  await local.load();
  return { dir, local, store: new CaptureStore(dir, local) };
}

/** A second process on the same data directory: its own state, its own empty draft map. */
async function secondProcess(dir: string): Promise<CaptureStore> {
  const local = new LocalStore(path.join(dir, 'state.json'));
  await local.load();
  return new CaptureStore(dir, local);
}

const payload: CaptureDraftPayload = {
  schema: 'kubus.capture/1',
  artworkId: 'art-1',
  capturedAt: '2026-01-01T00:00:00.000Z',
  metadata: { source: 'art.kubus-mobile-tracking', private: true },
};

function framesDocument(frames: Array<Record<string, unknown>>): Buffer {
  return Buffer.from(`${JSON.stringify({ schema: 'kubus.capture.frames/1', frames })}\n`);
}

async function completeDraft(store: CaptureStore, override?: CaptureDraftPayload) {
  const draft = await store.beginDraft(override ?? payload);
  await store.writeDraftFile(draft.id, 'rgb/00000.jpg', Buffer.alloc(32, 1), 'image/jpeg');
  await store.writeDraftFile(draft.id, 'depth/00000.bin', Buffer.alloc(16, 2));
  await store.writeDraftFile(draft.id, 'confidence/00000.bin', Buffer.alloc(8, 3));
  await store.writeDraftFile(
    draft.id,
    'frames.json',
    framesDocument([
      { rgbPath: 'rgb/00000.jpg', depthPath: 'depth/00000.bin', depthConfidencePath: 'confidence/00000.bin' },
    ]),
    'application/json',
  );
  return draft;
}

/** Backdates a draft marker, as if its transfer went quiet `ageMs` ago. */
async function ageMarker(directory: string, ageMs: number): Promise<void> {
  const when = new Date(Date.now() - ageMs);
  await fs.utimes(path.join(directory, '.draft.json'), when, when);
}

async function exists(target: string): Promise<boolean> {
  return fs.access(target).then(() => true, () => false);
}

/** A byte stream that stops after its first chunk until released. */
function pausedStream() {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let firstChunkWritten!: () => void;
  const started = new Promise<void>((resolve) => { firstChunkWritten = resolve; });
  async function* chunks(): AsyncIterable<Buffer> {
    yield Buffer.alloc(16, 1);
    firstChunkWritten();
    await gate;
    yield Buffer.alloc(16, 2);
  }
  return { chunks: chunks(), started, release };
}

const PAST_GRACE_MS = 31 * 60 * 1000;

describe('orphan reclamation after a restart inside the grace period', () => {
  it('spares a fresh orphan at startup and reclaims it once the grace period has passed', async () => {
    const { store } = await newNode();
    const draft = await store.beginDraft(payload);
    await store.writeDraftFile(draft.id, 'rgb/00000.jpg', Buffer.alloc(8, 1), 'image/jpeg');
    // The node restarts moments after the upload was interrupted.
    await store.forgetDraftsForTesting();

    expect(await store.reclaimOrphanedDirectories()).toBe(0);
    expect(await exists(draft.directory)).toBe(true);

    // Nobody resumes it. The grace period passes while the new process keeps
    // running, and its scheduled sweep — not another restart — reclaims it.
    await ageMarker(draft.directory, PAST_GRACE_MS);
    const reclaimed: number[] = [];
    const sweeps = store.startOrphanSweeps({ intervalMs: 10, onReclaimed: (count) => reclaimed.push(count) });
    try {
      const deadline = Date.now() + 3000;
      while (await exists(draft.directory)) {
        if (Date.now() > deadline) throw new Error('the scheduled sweep never reclaimed the orphan');
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    } finally {
      sweeps.stop();
    }
    expect(reclaimed).toEqual([1]);
  });

  it('never reclaims a draft this process owns, however long it has been quiet', async () => {
    const { store } = await newNode();
    const draft = await store.beginDraft(payload);
    await store.writeDraftFile(draft.id, 'rgb/00000.jpg', Buffer.alloc(8, 1), 'image/jpeg');
    await ageMarker(draft.directory, PAST_GRACE_MS);

    for (let cycle = 0; cycle < 3; cycle += 1) {
      expect(await store.reclaimOrphanedDirectories()).toBe(0);
    }
    expect((await store.getDraft(draft.id)).files).toEqual(['rgb/00000.jpg']);
  });

  it('keeps a live upload through repeated sweeps while a file is still streaming', async () => {
    const { dir, store } = await newNode();
    const draft = await store.beginDraft(payload);
    const file = pausedStream();
    const streaming = store.writeDraftFileStream(draft.id, 'rgb/00000.jpg', file.chunks, 'image/jpeg');
    await file.started;

    // The serving process sweeps on its schedule, and a process that cannot
    // see its draft map — the healthcheck of an older build — sweeps too.
    const other = await secondProcess(dir);
    for (let cycle = 0; cycle < 3; cycle += 1) {
      expect(await store.reclaimOrphanedDirectories()).toBe(0);
      expect(await other.reclaimOrphanedDirectories()).toBe(0);
    }
    file.release();
    await streaming;
    await store.writeDraftFile(draft.id, 'frames.json', framesDocument([{ rgbPath: 'rgb/00000.jpg' }]), 'application/json');

    const record = await store.commitDraft(draft.id);
    expect(record.fileCount).toBe(2);
    expect(record.sizeBytes).toBeGreaterThan(32);
    expect((await store.inspect(record.id)).ok).toBe(true);
  });

  it('refreshes the marker while one long file is still arriving', async () => {
    const { dir, store } = await newNode();
    const draft = await store.beginDraft(payload);
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
    let releaseLast!: () => void;
    const lastGate = new Promise<void>((resolve) => { releaseLast = resolve; });
    let secondWritten!: () => void;
    const midStream = new Promise<void>((resolve) => { secondWritten = resolve; });
    async function* longFile(): AsyncIterable<Buffer> {
      yield Buffer.alloc(16, 1);
      await firstGate;
      yield Buffer.alloc(16, 2);
      // Resumed only once the store has finished with the second chunk.
      secondWritten();
      await lastGate;
      yield Buffer.alloc(16, 3);
    }
    const streaming = store.writeDraftFileStream(draft.id, 'rgb/00000.jpg', longFile(), 'image/jpeg');
    await new Promise((resolve) => setTimeout(resolve, 20));
    // One file has now been arriving for longer than the whole grace period.
    await ageMarker(draft.directory, PAST_GRACE_MS);
    const realNow = Date.now.bind(Date);
    vi.spyOn(Date, 'now').mockImplementation(() => realNow() + 2 * 60 * 1000);
    releaseFirst();
    await midStream;
    vi.restoreAllMocks();

    // Still mid-file. Another process, which cannot see this draft map, must
    // find the marker fresh and spare the transfer.
    const other = await secondProcess(dir);
    expect(await other.reclaimOrphanedDirectories()).toBe(0);
    expect(await exists(draft.directory)).toBe(true);
    releaseLast();
    await streaming;
    expect((await store.getDraft(draft.id)).sizeBytes).toBe(48);
  });
});

describe('a repair replaces a damaged capture only once it is proven whole', () => {
  const keyed: CaptureDraftPayload = { ...payload, metadata: { ...payload.metadata, localCaptureId: 'capture-local-repair' } };

  /** A committed capture that has since lost its image, exactly as in production. */
  async function damagedCapture(store: CaptureStore) {
    const committed = await store.commitDraft((await completeDraft(store, keyed)).id);
    await fs.rm(path.join(committed.directory, 'rgb/00000.jpg'));
    return committed;
  }

  async function expectUntouched(store: CaptureStore, damaged: { id: string; directory: string }) {
    expect(store.list().map((record) => record.id)).toEqual([damaged.id]);
    expect(store.get(damaged.id).directory).toBe(damaged.directory);
    // What survived the original damage is still there to recover from.
    expect(await exists(path.join(damaged.directory, 'frames.json'))).toBe(true);
    expect(await exists(path.join(damaged.directory, 'depth/00000.bin'))).toBe(true);
    expect((await store.inspect(damaged.id)).code).toBe('capture_package_incomplete');
  }

  it('leaves the damaged capture untouched when the repair is incomplete', async () => {
    const { store } = await newNode();
    const damaged = await damagedCapture(store);
    const repair = await store.beginDraft(keyed);
    await store.writeDraftFile(repair.id, 'frames.json', framesDocument([{ rgbPath: 'rgb/00000.jpg' }]), 'application/json');

    await expect(store.commitDraft(repair.id)).rejects.toMatchObject({ statusCode: 422, code: 'capture_frame_file_missing' });
    await expectUntouched(store, damaged);
    // And the repair stays resumable.
    expect((await store.getDraft(repair.id)).files).toEqual(['frames.json']);
  });

  it('leaves the damaged capture untouched when the repair is malformed', async () => {
    const { store } = await newNode();
    const damaged = await damagedCapture(store);
    const repair = await store.beginDraft(keyed);
    await store.writeDraftFile(repair.id, 'rgb/00000.jpg', Buffer.alloc(8, 1), 'image/jpeg');
    await store.writeDraftFile(repair.id, 'frames.json', Buffer.from('null'), 'application/json');

    await expect(store.commitDraft(repair.id)).rejects.toMatchObject({ statusCode: 422, code: 'capture_frames_invalid' });
    await expectUntouched(store, damaged);
  });

  it('replaces the logical capture exactly once, and a lost response converges on it', async () => {
    const { store } = await newNode();
    const damaged = await damagedCapture(store);

    const repaired = await store.commitDraft((await completeDraft(store, keyed)).id);
    expect(repaired.id).not.toBe(damaged.id);
    expect(store.list().map((record) => record.id)).toEqual([repaired.id]);
    expect((await store.inspect(repaired.id)).ok).toBe(true);
    expect(await exists(damaged.directory)).toBe(false);
    expect(await exists(path.join(repaired.directory, '.draft.json'))).toBe(false);

    // The phone never saw that response and sends the capture again.
    const retry = await completeDraft(store, keyed);
    const again = await store.commitDraft(retry.id);
    expect(again.id).toBe(repaired.id);
    expect(store.list()).toHaveLength(1);
    expect(await exists(retry.directory)).toBe(false);
    expect(await exists(repaired.directory)).toBe(true);
  });

  it('two repairs committed together still leave one replica', async () => {
    const { store } = await newNode();
    await damagedCapture(store);
    const first = await completeDraft(store, keyed);
    const second = await completeDraft(store, keyed);

    const [a, b] = await Promise.all([store.commitDraft(first.id), store.commitDraft(second.id)]);
    expect(b.id).toBe(a.id);
    expect(store.list()).toHaveLength(1);
    expect((await store.inspect(a.id)).ok).toBe(true);
  });

  it('a failure while promoting keeps the record pointing at a real directory', async () => {
    const { local, store } = await newNode();
    const damaged = await damagedCapture(store);
    const repair = await completeDraft(store, keyed);

    // The state write that would swap the records fails — a full disk, say.
    const update = vi.spyOn(local, 'update').mockRejectedValueOnce(new Error('ENOSPC'));
    await expect(store.commitDraft(repair.id)).rejects.toThrow('ENOSPC');
    update.mockRestore();

    await expectUntouched(store, damaged);
    // Nothing uploaded was thrown away: the same draft commits once the disk
    // has room again.
    expect((await store.getDraft(repair.id)).fileCount).toBe(4);
    const repaired = await store.commitDraft(repair.id);
    expect(store.list().map((record) => record.id)).toEqual([repaired.id]);
    expect((await store.inspect(repaired.id)).ok).toBe(true);
  });

  it('a restart between the record swap and the old directory removal leaves only a reclaimable orphan', async () => {
    const { dir, store } = await newNode();
    const damaged = await damagedCapture(store);
    const rm = fs.rm;
    // The process dies right after the swap: the old directory is never removed.
    vi.spyOn(fs, 'rm').mockImplementation(async (target, options) => {
      if (path.resolve(String(target)) === path.resolve(damaged.directory)) throw new Error('killed');
      return rm(target, options);
    });
    const repaired = await store.commitDraft((await completeDraft(store, keyed)).id);
    vi.restoreAllMocks();

    expect(store.list().map((record) => record.id)).toEqual([repaired.id]);
    const restarted = await secondProcess(dir);
    expect(await restarted.reclaimOrphanedDirectories()).toBe(1);
    expect(await exists(damaged.directory)).toBe(false);
    expect((await restarted.inspect(repaired.id)).ok).toBe(true);
  });

  it('refuses to swap out a capture a job is still reading', async () => {
    const { local, store } = await newNode();
    const damaged = await damagedCapture(store);
    await local.update((state) => {
      (state.jobs ??= {}).job1 = { id: 'job1', state: 'running', input: { captureId: damaged.id } };
    });
    const repair = await completeDraft(store, keyed);

    await expect(store.commitDraft(repair.id)).rejects.toMatchObject({ statusCode: 409, code: 'capture_in_use' });
    await expectUntouched(store, damaged);
    expect((await store.getDraft(repair.id)).fileCount).toBe(4);
  });
});

describe('frames.json is untrusted input', () => {
  const frames = (value: unknown) => JSON.stringify({ schema: 'kubus.capture.frames/1', frames: value });
  const cases: Array<[string, string]> = [
    ['a null document', 'null'],
    ['an array document', '[]'],
    ['a string document', '"kubus.capture.frames/1"'],
    ['a numeric document', '42'],
    ['a numeric schema', JSON.stringify({ schema: 1, frames: [{ rgbPath: 'rgb/00000.jpg' }] })],
    ['frames that are not an array', frames({ 0: { rgbPath: 'rgb/00000.jpg' } })],
    ['a null frame', frames([null])],
    ['a primitive frame', frames(['rgb/00000.jpg'])],
    ['an array frame', frames([['rgb/00000.jpg']])],
    ['a valid frame followed by a null one', frames([{ rgbPath: 'rgb/00000.jpg' }, null])],
    ['a frame without rgbPath', frames([{ depthPath: 'rgb/00000.jpg' }])],
    ['a numeric rgbPath', frames([{ rgbPath: 7 }])],
    ['an object rgbPath', frames([{ rgbPath: { path: 'rgb/00000.jpg' } }])],
    ['a traversal rgbPath', frames([{ rgbPath: '../../state.json' }])],
    ['a non-string depthPath', frames([{ rgbPath: 'rgb/00000.jpg', depthPath: 3 }])],
    ['an empty depthConfidencePath', frames([{ rgbPath: 'rgb/00000.jpg', depthConfidencePath: '' }])],
    ['a traversal depthConfidencePath', frames([{ rgbPath: 'rgb/00000.jpg', depthConfidencePath: 'a/../../x' }])],
  ];

  for (const [name, document] of cases) {
    it(`refuses ${name} with a typed 422, never an internal error`, async () => {
      const { store } = await newNode();
      const draft = await store.beginDraft(payload);
      await store.writeDraftFile(draft.id, 'rgb/00000.jpg', Buffer.alloc(8, 1), 'image/jpeg');
      await store.writeDraftFile(draft.id, 'frames.json', Buffer.from(document), 'application/json');

      await expect(store.commitDraft(draft.id)).rejects.toMatchObject({
        statusCode: 422,
        code: 'capture_frames_invalid',
      });
      expect(store.list()).toHaveLength(0);
    });
  }

  it('reports a stored capture whose documents became null without throwing', async () => {
    const { store } = await newNode();
    const record = await store.commitDraft((await completeDraft(store)).id);
    await fs.writeFile(path.join(record.directory, 'frames.json'), 'null');
    await fs.writeFile(path.join(record.directory, 'capture.json'), '{"files":[null,7,{"path":3}]}');

    await expect(store.inspect(record.id)).resolves.toMatchObject({ ok: false, code: 'capture_frames_invalid' });
    await expect(getCaptureDiagnostics(store, record.id)).resolves.toMatchObject({
      validation: { ok: false, code: 'capture_frames_invalid' },
    });
  });
});

describe('discarding a draft mid-write', () => {
  it('leaves no directory behind once the write in flight finishes', async () => {
    const { store } = await newNode();
    const draft = await store.beginDraft(payload);
    const file = pausedStream();
    const streaming = store.writeDraftFileStream(draft.id, 'rgb/00000.jpg', file.chunks, 'image/jpeg');
    await file.started;

    const discarding = store.discardDraft(draft.id);
    file.release();
    await streaming.catch(() => undefined);
    await discarding;

    expect(await exists(draft.directory)).toBe(false);
  });
});
