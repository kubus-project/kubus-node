import { afterEach, describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CaptureStore, type CaptureDraftPayload } from '../src/captures/captureStore.js';
import { LocalStore } from '../src/state/localStore.js';
import { reclaimsOrphanedCaptures } from '../src/cli/commands.js';
import { getCaptureDiagnostics } from '../src/gui/spatialGuiApi.js';

const dirs: string[] = [];
afterEach(async () =>
  Promise.all(dirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true }))),
);

async function newStore(): Promise<CaptureStore> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'kubus-capture-integrity-'));
  dirs.push(dir);
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

/** A draft holding one complete frame: image, depth, confidence, manifest. */
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

describe('capture package validation at commit', () => {
  it('commits a complete package', async () => {
    const store = await newStore();
    const draft = await completeDraft(store);

    const record = await store.commitDraft(draft.id);

    expect(record.state).toBe('stored');
    expect(record.fileCount).toBe(4);
  });

  it('refuses a package with no frames.json', async () => {
    const store = await newStore();
    const draft = await store.beginDraft(payload);
    await store.writeDraftFile(draft.id, 'rgb/00000.jpg', Buffer.alloc(8), 'image/jpeg');

    await expect(store.commitDraft(draft.id)).rejects.toMatchObject({
      statusCode: 422,
      code: 'capture_frames_missing',
    });
    expect(store.list()).toHaveLength(0);
  });

  it('refuses a package whose frames.json references an absent image', async () => {
    const store = await newStore();
    const draft = await store.beginDraft(payload);
    await store.writeDraftFile(draft.id, 'rgb/00000.jpg', Buffer.alloc(8), 'image/jpeg');
    await store.writeDraftFile(
      draft.id,
      'frames.json',
      framesDocument([{ rgbPath: 'rgb/00000.jpg' }, { rgbPath: 'rgb/00001.jpg' }]),
      'application/json',
    );

    await expect(store.commitDraft(draft.id)).rejects.toMatchObject({
      statusCode: 422,
      code: 'capture_frame_file_missing',
      details: { missingPaths: ['rgb/00001.jpg'], missingCount: 1 },
    });
  });

  it('refuses a package whose declared optional file is absent', async () => {
    const store = await newStore();
    const draft = await store.beginDraft(payload);
    await store.writeDraftFile(draft.id, 'rgb/00000.jpg', Buffer.alloc(8), 'image/jpeg');
    await store.writeDraftFile(
      draft.id,
      'frames.json',
      framesDocument([{ rgbPath: 'rgb/00000.jpg', depthPath: 'depth/00000.bin' }]),
      'application/json',
    );

    await expect(store.commitDraft(draft.id)).rejects.toMatchObject({
      statusCode: 422,
      code: 'capture_frame_file_missing',
      details: { missingPaths: ['depth/00000.bin'] },
    });
  });

  it('refuses a package whose uploaded file was emptied after upload', async () => {
    const store = await newStore();
    const draft = await completeDraft(store);
    await fs.writeFile(path.join(draft.directory, 'rgb/00000.jpg'), '');

    await expect(store.commitDraft(draft.id)).rejects.toMatchObject({
      statusCode: 422,
      code: 'capture_package_incomplete',
      details: { missingPaths: ['rgb/00000.jpg'] },
    });
  });

  it('refuses a package whose uploaded file vanished after upload', async () => {
    const store = await newStore();
    const draft = await completeDraft(store);
    await fs.rm(path.join(draft.directory, 'depth/00000.bin'));

    await expect(store.commitDraft(draft.id)).rejects.toMatchObject({
      statusCode: 422,
      code: 'capture_package_incomplete',
      details: { missingPaths: ['depth/00000.bin'] },
    });
  });

  it('refuses a frames.json that is not valid JSON', async () => {
    const store = await newStore();
    const draft = await store.beginDraft(payload);
    await store.writeDraftFile(draft.id, 'rgb/00000.jpg', Buffer.alloc(8), 'image/jpeg');
    await store.writeDraftFile(draft.id, 'frames.json', Buffer.from('{not json'), 'application/json');

    await expect(store.commitDraft(draft.id)).rejects.toMatchObject({
      statusCode: 422,
      code: 'capture_frames_invalid',
    });
  });

  it('refuses a frames.json declaring the wrong schema', async () => {
    const store = await newStore();
    const draft = await store.beginDraft(payload);
    await store.writeDraftFile(draft.id, 'rgb/00000.jpg', Buffer.alloc(8), 'image/jpeg');
    await store.writeDraftFile(
      draft.id,
      'frames.json',
      Buffer.from(JSON.stringify({ schema: 'something/else', frames: [{ rgbPath: 'rgb/00000.jpg' }] })),
      'application/json',
    );

    await expect(store.commitDraft(draft.id)).rejects.toMatchObject({
      statusCode: 422,
      code: 'capture_frames_invalid',
    });
  });

  it('refuses a frames.json with no frames', async () => {
    const store = await newStore();
    const draft = await store.beginDraft(payload);
    await store.writeDraftFile(draft.id, 'rgb/00000.jpg', Buffer.alloc(8), 'image/jpeg');
    await store.writeDraftFile(draft.id, 'frames.json', framesDocument([]), 'application/json');

    await expect(store.commitDraft(draft.id)).rejects.toMatchObject({
      statusCode: 422,
      code: 'capture_frames_invalid',
    });
  });

  it.each(['../../escape.jpg', '/etc/passwd/../../escape.jpg'])(
    'refuses a frames.json whose rgbPath escapes the capture directory (%s)',
    async (escape) => {
      const store = await newStore();
      const draft = await store.beginDraft(payload);
      await store.writeDraftFile(draft.id, 'rgb/00000.jpg', Buffer.alloc(8), 'image/jpeg');
      await store.writeDraftFile(draft.id, 'frames.json', framesDocument([{ rgbPath: escape }]), 'application/json');

      await expect(store.commitDraft(draft.id)).rejects.toMatchObject({
        statusCode: 422,
        code: 'capture_frames_invalid',
      });
    },
  );

  it('refuses a package whose frame count contradicts the stated metadata', async () => {
    const store = await newStore();
    const draft = await completeDraft(store, {
      ...payload,
      metadata: { ...payload.metadata, frameCount: 28 },
    });

    await expect(store.commitDraft(draft.id)).rejects.toMatchObject({
      statusCode: 422,
      code: 'capture_frames_invalid',
    });
  });

  it('never names an absolute filesystem path in the rejection', async () => {
    const store = await newStore();
    const draft = await store.beginDraft(payload);
    await store.writeDraftFile(draft.id, 'rgb/00000.jpg', Buffer.alloc(8), 'image/jpeg');

    const error = await store.commitDraft(draft.id).catch((raised: unknown) => raised) as {
      details?: { message?: string; missingPaths?: string[] };
    };

    // Paths in the rejection are capture-relative: an end-user surface must
    // never be handed a node filesystem layout.
    for (const reported of error.details?.missingPaths ?? []) {
      expect(path.isAbsolute(reported)).toBe(false);
    }
    expect(JSON.stringify(error.details)).not.toContain(os.tmpdir());
    expect(error.details?.missingPaths).toEqual(['frames.json']);
  });
});

describe('a rejected commit leaves a resumable draft', () => {
  it('keeps everything already uploaded and commits once the gap is filled', async () => {
    const store = await newStore();
    const draft = await store.beginDraft(payload);
    await store.writeDraftFile(draft.id, 'rgb/00000.jpg', Buffer.alloc(32, 1), 'image/jpeg');
    await store.writeDraftFile(
      draft.id,
      'frames.json',
      framesDocument([{ rgbPath: 'rgb/00000.jpg' }, { rgbPath: 'rgb/00001.jpg' }]),
      'application/json',
    );

    await expect(store.commitDraft(draft.id)).rejects.toMatchObject({ code: 'capture_frame_file_missing' });

    // Nothing was thrown away: the draft still holds the large files, so the
    // client sends only what was missing.
    const progress = await store.getDraft(draft.id);
    expect(progress.files).toEqual(['rgb/00000.jpg', 'frames.json']);
    await expect(fs.access(path.join(draft.directory, 'rgb/00000.jpg'))).resolves.toBeUndefined();

    await store.writeDraftFile(draft.id, 'rgb/00001.jpg', Buffer.alloc(32, 2), 'image/jpeg');
    const record = await store.commitDraft(draft.id);

    expect(record.state).toBe('stored');
    expect(record.fileCount).toBe(3);
    expect(store.list()).toHaveLength(1);
  });

  it('commits exactly once after a repair', async () => {
    const store = await newStore();
    const keyed = { ...payload, metadata: { ...payload.metadata, localCaptureId: 'capture-local-9' } };
    const draft = await store.beginDraft(keyed);
    await store.writeDraftFile(
      draft.id,
      'frames.json',
      framesDocument([{ rgbPath: 'rgb/00000.jpg' }]),
      'application/json',
    );
    await expect(store.commitDraft(draft.id)).rejects.toMatchObject({ code: 'capture_frame_file_missing' });

    await store.writeDraftFile(draft.id, 'rgb/00000.jpg', Buffer.alloc(8), 'image/jpeg');
    const first = await store.commitDraft(draft.id);

    const retry = await store.beginDraft(keyed);
    await store.writeDraftFile(retry.id, 'rgb/00000.jpg', Buffer.alloc(8), 'image/jpeg');
    expect((await store.commitDraft(retry.id)).id).toBe(first.id);
    expect(store.list()).toHaveLength(1);
  });
});

describe('draft progress reports the directory, not the accounting', () => {
  it('drops files that vanished so a resume sends them again', async () => {
    const store = await newStore();
    const draft = await store.beginDraft(payload);
    await store.writeDraftFile(draft.id, 'rgb/00000.jpg', Buffer.alloc(64, 1), 'image/jpeg');
    await store.writeDraftFile(draft.id, 'rgb/00001.jpg', Buffer.alloc(64, 2), 'image/jpeg');
    expect((await store.getDraft(draft.id)).fileCount).toBe(2);

    await fs.rm(path.join(draft.directory, 'rgb/00000.jpg'));

    const progress = await store.getDraft(draft.id);
    expect(progress.files).toEqual(['rgb/00001.jpg']);
    expect(progress.fileCount).toBe(1);
    expect(progress.sizeBytes).toBe(64);
  });
});

describe('orphan reclamation is bounded to serving commands', () => {
  it('only the commands that serve uploads may sweep', () => {
    expect(reclaimsOrphanedCaptures('start')).toBe(true);
    expect(reclaimsOrphanedCaptures('gui')).toBe(true);
    // `status` is the container healthcheck, every 30 seconds, in its own
    // process. Sweeping there destroyed live transfers.
    for (const command of ['status', 'doctor', 'register', 'sync', 'pin', 'heartbeat', 'rewards']) {
      expect(reclaimsOrphanedCaptures(command)).toBe(false);
    }
  });
});

describe('repairing a stored capture that lost files', () => {
  const keyed = { ...payload, metadata: { ...payload.metadata, localCaptureId: 'capture-local-damaged' } };

  it('replaces the damaged replica instead of answering with it', async () => {
    const store = await newStore();
    const first = await completeDraft(store, keyed);
    const damaged = await store.commitDraft(first.id);
    // Exactly the production state: the record says stored, the directory has
    // lost the frame the manifest names.
    await fs.rm(path.join(damaged.directory, 'rgb/00000.jpg'));
    expect((await store.inspect(damaged.id)).ok).toBe(false);

    const repair = await completeDraft(store, keyed);
    const record = await store.commitDraft(repair.id);

    expect((await store.inspect(record.id)).ok).toBe(true);
    // One local capture, one durable replica — not two.
    expect(store.list()).toHaveLength(1);
    expect(store.list()[0]!.localCaptureId).toBe('capture-local-damaged');
    await expect(fs.access(damaged.directory)).rejects.toThrow();
  });

  it('still answers a genuine lost-response retry with the existing capture', async () => {
    const store = await newStore();
    const first = await completeDraft(store, keyed);
    const committed = await store.commitDraft(first.id);

    const retry = await completeDraft(store, keyed);
    const second = await store.commitDraft(retry.id);

    expect(second.id).toBe(committed.id);
    expect(store.list()).toHaveLength(1);
  });
});

describe('operator diagnostics', () => {
  it('tells a broken transfer apart from a failed reconstruction', async () => {
    const store = await newStore();
    const healthy = await store.commitDraft((await completeDraft(store)).id);
    expect(await getCaptureDiagnostics(store, healthy.id)).toMatchObject({
      id: healthy.id,
      state: 'stored',
      validation: { ok: true, missingCount: 0, frameCount: 1 },
    });

    await fs.rm(path.join(healthy.directory, 'rgb/00000.jpg'));

    const broken = await getCaptureDiagnostics(store, healthy.id);
    expect(broken.validation.ok).toBe(false);
    expect(broken.validation.code).toBe('capture_package_incomplete');
    expect(broken.validation.missingCount).toBe(1);
    // The count is what the operator acts on; the filenames stay in the log.
    expect(JSON.stringify(broken.validation)).not.toContain('rgb/00000.jpg');
    expect(JSON.stringify(broken.validation)).not.toContain(os.tmpdir());
  });
});
