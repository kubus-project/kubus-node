import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CaptureStore, type CaptureRecord } from '../src/captures/captureStore.js';
import { normalizeRetention, parseRetentionInstant, RetentionSweeper, type RetentionMode } from '../src/captures/retention.js';
import { parseEnv } from '../src/config/env.js';
import type { SpatialManifest } from '../src/spatial/models.js';
import { LocalStore } from '../src/state/localStore.js';

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

const dirs: string[] = [];
afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(dirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe('retention dates', () => {
  it.each([
    ['2026-06-15', '2026-06-15T00:00:00.000Z'],
    ['2026-06-15T10:00:00Z', '2026-06-15T10:00:00.000Z'],
    ['2026-06-15T10:00Z', '2026-06-15T10:00:00.000Z'],
    ['2026-06-15T10:00:00.250Z', '2026-06-15T10:00:00.250Z'],
    ['2026-06-15T10:00:00+02:00', '2026-06-15T08:00:00.000Z'],
    ['2026-06-15T10:00:00-05:30', '2026-06-15T15:30:00.000Z'],
    ['2028-02-29', '2028-02-29T00:00:00.000Z'],
    [' 2026-06-15 ', '2026-06-15T00:00:00.000Z'],
  ])('reads %s as the instant written', (input, iso) => {
    expect(new Date(parseRetentionInstant(input)!).toISOString()).toBe(iso);
  });

  it.each([
    '1', '2026', '2026-06', '', ' ', 'tomorrow', 'never', '2026-06-15T10:00:00' /* no offset: local time */, '2026-06-15 10:00:00Z',
    '2026-02-30', '2026-02-29', '2026-04-31', '2026-13-01', '2026-00-10', '2026-06-00', '2026-06-15T24:00:00Z', '2026-06-15T10:60:00Z',
    '2026-06-15T10:00:60Z', '2026-06-15T10:00:00+25:00', '2026-06-15T10:00:00+01:60', '1969-12-31', '10000-01-01', `2026-06-15${' x'.repeat(30)}`,
    '0', '-1', 'Infinity', 'NaN',
  ])('refuses %j instead of guessing what was meant', (input) => {
    expect(parseRetentionInstant(input)).toBeUndefined();
  });

  it('refuses anything that is not a string', () => {
    for (const value of [undefined, null, 0, 1_700_000_000, true, {}, [], ['2026-06-15'], new Date()]) expect(parseRetentionInstant(value)).toBeUndefined();
  });
});

describe('normalizing what a client asked for', () => {
  it('keeps a valid deadline, in a canonical form, and an explicit publication request', () => {
    expect(normalizeRetention({ deleteAfter: '2026-06-15T10:00:00+02:00', deleteAfterPublication: true })).toEqual({ deleteAfter: '2026-06-15T08:00:00.000Z', deleteAfterPublication: true });
    expect(normalizeRetention({ deleteAfterPublication: true })).toEqual({ deleteAfterPublication: true });
  });

  it('turns anything it does not understand into "keep"', () => {
    for (const value of [undefined, null, 'delete', 7, [], {}, { deleteAfter: '1' }, { deleteAfter: 'soon' }, { deleteAfterPublication: 'true' }, { deleteAfterPublication: 1 }, { deleteAfterPublication: false }, { unknown: true }]) {
      expect(normalizeRetention(value), JSON.stringify(value)).toBeUndefined();
    }
  });

  it('drops keys it does not know and an unusable deadline next to a good request', () => {
    expect(normalizeRetention({ deleteAfter: 'whenever', deleteAfterPublication: true, wipeEverything: true })).toEqual({ deleteAfterPublication: true });
  });
});

interface World {
  dir: string;
  store: LocalStore;
  captures: CaptureStore;
  clock: { now: number };
  local: Set<string>;
  kuboCalls: string[];
  deleteSpy: ReturnType<typeof vi.fn>;
  sweeper: (mode: RetentionMode, extra?: Partial<ConstructorParameters<typeof RetentionSweeper>[0]>) => RetentionSweeper;
  capture: (retention: unknown, options?: { ageHours?: number }) => Promise<CaptureRecord>;
  scene: (captureId: string, options?: { id?: string; master?: boolean; masterCid?: string; published?: boolean; derivatives?: boolean }) => Promise<string>;
  job: (captureId: string, state: string) => Promise<void>;
  exists: (capture: CaptureRecord) => Promise<boolean>;
}

const FRAMES = [{ path: 'rgb/00000.jpg', contentBase64: Buffer.from([0xff, 0xd8, 0xff, 0xd9]).toString('base64') }];
let counter = 0;

async function world(): Promise<World> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'kubus-retention-'));
  dirs.push(dir);
  const store = new LocalStore(path.join(dir, 'state.json'));
  await store.load();
  const captures = new CaptureStore(dir, store);
  const clock = { now: Date.now() };
  const local = new Set<string>();
  const kuboCalls: string[] = [];
  const deleteSpy = vi.fn((id: string) => captures.delete(id));
  const w: World = {
    dir, store, captures, clock, local, kuboCalls, deleteSpy,
    sweeper: (mode, extra = {}) => new RetentionSweeper({
      mode, store, captures: { list: () => captures.list(), delete: deleteSpy as never }, now: () => clock.now,
      kubo: { hasAllBlocksLocally: async (cid: string) => { kuboCalls.push(cid); return local.has(cid); } },
      logger: { info: () => undefined, warn: () => undefined }, ...extra,
    }),
    capture: async (retention, options = {}) => {
      const record = await captures.create({ schema: 'kubus.capture/1', artworkId: 'art-1', capturedAt: new Date().toISOString(), metadata: {}, files: FRAMES, retention: retention as never });
      // Age the capture by rewriting its creation time: the record is the clock's reference.
      const createdAt = new Date(clock.now - (options.ageHours ?? 48) * HOUR).toISOString();
      await store.update((state) => { (state.captures![record.id] as CaptureRecord).createdAt = createdAt; });
      return captures.get(record.id);
    },
    scene: async (captureId, options = {}) => {
      counter += 1;
      const id = options.id ?? `scene-${counter}`;
      const masterCid = options.masterCid ?? `QmMaster${counter}`;
      if (options.master !== false) local.add(masterCid);
      const variants: SpatialManifest['variants'] = [];
      if (options.derivatives) variants.push({ role: 'spatial_preview', cid: `QmPreview${counter}`, sizeBytes: 1, mimeType: 'application/octet-stream', format: 'spz', storageClass: 'hot' });
      if (options.master !== false || options.masterCid) variants.push({ role: 'spatial_archive', cid: masterCid, sizeBytes: 1, mimeType: 'application/octet-stream', format: 'ply', storageClass: 'cold' });
      if (variants.length === 0) variants.push({ role: 'spatial_preview', cid: `QmPreview${counter}`, sizeBytes: 1, mimeType: 'application/octet-stream', format: 'spz', storageClass: 'hot' });
      await store.update((state) => {
        (state.spatial ??= {})[id] = {
          id, state: options.published ? 'publication_requested' : 'local', manifestCid: `QmManifest${counter}`, createdAt: new Date(clock.now).toISOString(),
          manifest: { schema: 'kubus.spatial/1', type: 'gaussianSplat', id, artworkId: 'art-1', captureId, captureProvenance: { source: 'localCapture', captureId }, capturedAt: 'x', variants, processing: { protocol: 'kubus.spatial-job/1', workerVersion: 'w', reconstruction: { engine: 'nerfstudio', method: 'splatfacto', iterations: 1, outputFormat: 'ply' } }, createdAt: 'x' },
          ...(options.published ? { publication: { accepted: true } } : {}),
        };
      });
      return id;
    },
    job: async (captureId, state) => {
      counter += 1;
      await store.update((s) => { (s.jobs ??= {})[`job-${counter}`] = { id: `job-${counter}`, type: 'spatial.reconstruct', state, input: { captureId } }; });
    },
    exists: async (record) => fs.access(record.directory).then(() => true, () => false),
  };
  return w;
}

const due = () => new Date(Date.now() - DAY).toISOString();
const later = () => new Date(Date.now() + 30 * DAY).toISOString();

describe('the default is to keep', () => {
  it('removes nothing when the sweeper is off, however authorized and ready the capture is', async () => {
    const w = await world();
    const capture = await w.capture({ deleteAfter: due() });
    await w.scene(capture.id);
    const report = await w.sweeper('off').sweep();
    expect(report).toMatchObject({ mode: 'off', examined: 0, deleted: [], wouldDelete: [] });
    expect(await w.exists(capture)).toBe(true);
    expect(w.deleteSpy).not.toHaveBeenCalled();
    expect(w.kuboCalls).toEqual([]);
  });

  it('removes nothing from a capture that carries no deletion request, even with a published scene and every derivative', async () => {
    const w = await world();
    const capture = await w.capture(undefined);
    await w.scene(capture.id, { published: true, derivatives: true });
    const report = await w.sweeper('on').sweep();
    expect(report.kept).toEqual({ no_request: 1 });
    expect(await w.exists(capture)).toBe(true);
  });

  it('does not treat having a preview or runtime as permission to delete the source', async () => {
    const w = await world();
    const capture = await w.capture({});
    await w.scene(capture.id, { derivatives: true });
    expect((await w.sweeper('on').sweep()).deleted).toEqual([]);
    expect(await w.exists(capture)).toBe(true);
  });

  it('keeps a capture whose stored request is garbage from an older build', async () => {
    const w = await world();
    const capture = await w.capture(undefined);
    await w.store.update((state) => { (state.captures![capture.id] as CaptureRecord).retention = { deleteAfter: '1' }; });
    await w.scene(capture.id);
    const report = await w.sweeper('on').sweep();
    expect(report.kept).toEqual({ invalid_deadline: 1 });
    expect(await w.exists(capture)).toBe(true);
  });
});

describe('deleting after a date', () => {
  it('removes the private capture, and only that, once the date has passed and its result is preserved', async () => {
    const w = await world();
    const capture = await w.capture({ deleteAfter: due() });
    const sceneId = await w.scene(capture.id);
    const sceneBefore = structuredClone(w.store.snapshot().spatial![sceneId]);

    const report = await w.sweeper('on').sweep();

    expect(report.deleted).toEqual([{ captureId: capture.id, reason: 'deadline', sizeBytes: capture.sizeBytes }]);
    expect(await w.exists(capture)).toBe(false);
    expect(w.store.snapshot().captures?.[capture.id]).toBeUndefined();
    // The scene, its manifest and everything in Kubo are untouched; the sweeper only ever asked whether the master was held.
    expect(w.store.snapshot().spatial![sceneId]).toEqual(sceneBefore);
    expect(w.kuboCalls).toEqual([(sceneBefore as unknown as { manifest: SpatialManifest }).manifest.variants[0]!.cid]);
  });

  it('reports instead of deleting in dry-run, and the next real sweep still finds it', async () => {
    const w = await world();
    const capture = await w.capture({ deleteAfter: due() });
    await w.scene(capture.id);
    const dry = await w.sweeper('dry-run').sweep();
    expect(dry.wouldDelete).toEqual([{ captureId: capture.id, reason: 'deadline', sizeBytes: capture.sizeBytes }]);
    expect(dry.deleted).toEqual([]);
    expect(await w.exists(capture)).toBe(true);
    expect(w.deleteSpy).not.toHaveBeenCalled();
    expect((await w.sweeper('on').sweep()).deleted).toHaveLength(1);
  });

  it('waits for the date', async () => {
    const w = await world();
    const capture = await w.capture({ deleteAfter: later() });
    await w.scene(capture.id);
    expect((await w.sweeper('on').sweep()).kept).toEqual({ deadline_not_reached: 1 });
    w.clock.now += 31 * DAY;
    expect((await w.sweeper('on').sweep()).deleted).toHaveLength(1);
  });

  it('never removes a capture younger than the grace period, whatever date it carries', async () => {
    const w = await world();
    const capture = await w.capture({ deleteAfter: '2026-01-01' }, { ageHours: 2 });
    await w.scene(capture.id);
    expect((await w.sweeper('on').sweep()).kept).toEqual({ within_grace_period: 1 });
    expect(await w.exists(capture)).toBe(true);
    // The operator can shorten the grace period, but only on purpose.
    expect((await w.sweeper('on', { graceMs: HOUR }).sweep()).deleted).toHaveLength(1);
  });
});

describe('never the only copy', () => {
  it('keeps an overdue capture that never produced a scene: it may be all that is left', async () => {
    const w = await world();
    const capture = await w.capture({ deleteAfter: due() });
    expect((await w.sweeper('on').sweep()).kept).toEqual({ no_scene: 1 });
    expect(await w.exists(capture)).toBe(true);
  });

  it('keeps it when the scene has no preserved reconstruction master', async () => {
    const w = await world();
    const capture = await w.capture({ deleteAfter: due() });
    await w.scene(capture.id, { master: false, derivatives: true });
    expect((await w.sweeper('on').sweep()).kept).toEqual({ master_missing: 1 });
    expect(await w.exists(capture)).toBe(true);
  });

  it('keeps it when the master is recorded but its blocks are no longer on this Node', async () => {
    const w = await world();
    const capture = await w.capture({ deleteAfter: due() });
    await w.scene(capture.id, { masterCid: 'QmGone', master: false });
    expect((await w.sweeper('on').sweep()).kept).toEqual({ master_not_local: 1 });
    expect(await w.exists(capture)).toBe(true);
  });

  it('needs every scene made from the capture to be preserved, not just one', async () => {
    const w = await world();
    const capture = await w.capture({ deleteAfter: due() });
    await w.scene(capture.id, { id: 'good' });
    await w.scene(capture.id, { id: 'lost', masterCid: 'QmLost', master: false });
    expect((await w.sweeper('on').sweep()).kept).toEqual({ master_not_local: 1 });
    expect(await w.exists(capture)).toBe(true);
    w.local.add('QmLost');
    expect((await w.sweeper('on').sweep()).deleted).toHaveLength(1);
  });

  it('is not fooled by another capture\'s scene', async () => {
    const w = await world();
    const mine = await w.capture({ deleteAfter: due() });
    const other = await w.capture(undefined);
    await w.scene(other.id);
    expect((await w.sweeper('on').sweep()).kept).toMatchObject({ no_scene: 1 });
    expect(await w.exists(mine)).toBe(true);
  });
});

describe('never while it is in use', () => {
  it.each(['queued', 'running'])('keeps a capture with a %s job', async (state) => {
    const w = await world();
    const capture = await w.capture({ deleteAfter: due() });
    await w.scene(capture.id);
    await w.job(capture.id, state);
    expect((await w.sweeper('on').sweep()).kept).toEqual({ job_active: 1 });
    expect(await w.exists(capture)).toBe(true);
  });

  it('does not predict the removal of a capture a dry run could not actually remove', async () => {
    // A real sweep is also stopped by CaptureStore.delete()'s own guard, so only
    // a dry run - which never calls delete - depends on the sweeper checking.
    const w = await world();
    const capture = await w.capture({ deleteAfter: due() });
    await w.scene(capture.id);
    await w.job(capture.id, 'running');
    const report = await w.sweeper('dry-run').sweep();
    expect(report.wouldDelete).toEqual([]);
    expect(report.kept).toEqual({ job_active: 1 });
  });

  it('is not held back by jobs that have finished or by another capture\'s job', async () => {
    const w = await world();
    const capture = await w.capture({ deleteAfter: due() });
    const other = await w.capture(undefined);
    await w.scene(capture.id);
    for (const state of ['completed', 'failed', 'cancelled']) await w.job(capture.id, state);
    await w.job(other.id, 'running');
    expect((await w.sweeper('on').sweep()).deleted).toHaveLength(1);
  });

  it('reports a job that started between the check and the removal as in use, not as a failure', async () => {
    const w = await world();
    const capture = await w.capture({ deleteAfter: due() });
    await w.scene(capture.id);
    w.deleteSpy.mockRejectedValueOnce(Object.assign(new Error('capture_in_use'), { code: 'capture_in_use', statusCode: 409 }));
    const report = await w.sweeper('on').sweep();
    expect(report.kept).toEqual({ job_active: 1 });
    expect(report.deleted).toEqual([]);
    expect(await w.exists(capture)).toBe(true);
  });

  it('keeps going when one removal fails, and says so', async () => {
    const w = await world();
    const first = await w.capture({ deleteAfter: due() }, { ageHours: 100 });
    const second = await w.capture({ deleteAfter: due() }, { ageHours: 50 });
    await w.scene(first.id);
    await w.scene(second.id);
    w.deleteSpy.mockRejectedValueOnce(new Error('EBUSY'));
    const report = await w.sweeper('on').sweep();
    expect(report.kept).toEqual({ delete_failed: 1 });
    expect(report.deleted.map((entry) => entry.captureId)).toEqual([second.id]);
    expect(await w.exists(first)).toBe(true);
  });
});

describe('deleting after publication', () => {
  it('waits until a scene made from the capture has been published', async () => {
    const w = await world();
    const capture = await w.capture({ deleteAfterPublication: true });
    const sceneId = await w.scene(capture.id);
    expect((await w.sweeper('on').sweep()).kept).toEqual({ not_published: 1 });
    expect(await w.exists(capture)).toBe(true);

    await w.store.update((state) => { (state.spatial![sceneId] as { publication?: unknown }).publication = { accepted: true }; });
    const report = await w.sweeper('on').sweep();
    expect(report.deleted).toEqual([{ captureId: capture.id, reason: 'published', sizeBytes: capture.sizeBytes }]);
    expect(await w.exists(capture)).toBe(false);
  });

  it('still requires the preserved master once it is published', async () => {
    const w = await world();
    const capture = await w.capture({ deleteAfterPublication: true });
    await w.scene(capture.id, { published: true, masterCid: 'QmNotHere', master: false });
    expect((await w.sweeper('on').sweep()).kept).toEqual({ master_not_local: 1 });
    expect(await w.exists(capture)).toBe(true);
  });

  it('does not delete on a date nobody asked for, and a date does not need publication', async () => {
    const w = await world();
    const a = await w.capture({ deleteAfterPublication: true });
    const b = await w.capture({ deleteAfter: due() });
    await w.scene(a.id);
    await w.scene(b.id);
    const report = await w.sweeper('on').sweep();
    expect(report.deleted.map((entry) => [entry.captureId, entry.reason])).toEqual([[b.id, 'deadline']]);
    expect(await w.exists(a)).toBe(true);
  });
});

describe('bounds', () => {
  it('removes at most a fixed number per sweep, oldest request first, and finishes the rest next time', async () => {
    const w = await world();
    const all: CaptureRecord[] = [];
    for (let index = 0; index < 7; index += 1) {
      const capture = await w.capture({ deleteAfter: due() }, { ageHours: 100 + index });
      await w.scene(capture.id);
      all.push(capture);
    }
    const first = await w.sweeper('on', { maxDeletionsPerSweep: 5 }).sweep();
    expect(first.deleted).toHaveLength(5);
    expect(first.kept).toEqual({ sweep_limit: 2 });
    // The oldest were taken first.
    expect(first.deleted.map((entry) => entry.captureId)).toEqual([...all].sort((a, b) => a.createdAt.localeCompare(b.createdAt)).slice(0, 5).map((capture) => capture.id));
    const second = await w.sweeper('on', { maxDeletionsPerSweep: 5 }).sweep();
    expect(second.deleted).toHaveLength(2);
  });

  it('counts a dry run against the same limit, so it predicts what a real sweep would do', async () => {
    const w = await world();
    for (let index = 0; index < 4; index += 1) {
      const capture = await w.capture({ deleteAfter: due() });
      await w.scene(capture.id);
    }
    const dry = await w.sweeper('dry-run', { maxDeletionsPerSweep: 3 }).sweep();
    expect(dry.wouldDelete).toHaveLength(3);
    expect(dry.kept).toEqual({ sweep_limit: 1 });
  });

  it('does not run two sweeps at once', async () => {
    const w = await world();
    const capture = await w.capture({ deleteAfter: due() });
    await w.scene(capture.id);
    const sweeper = w.sweeper('on');
    const [a, b] = await Promise.all([sweeper.sweep(), sweeper.sweep()]);
    expect(a.deleted.length + b.deleted.length).toBe(1);
    expect(w.deleteSpy).toHaveBeenCalledTimes(1);
  });

  it('leaves a record of the last sweep for diagnostics', async () => {
    const w = await world();
    const capture = await w.capture({ deleteAfter: due() });
    await w.scene(capture.id);
    await w.sweeper('dry-run').sweep();
    expect((w.store.snapshot() as unknown as { retentionSweep: Record<string, unknown> }).retentionSweep).toMatchObject({ mode: 'dry-run', examined: 1, deleted: 0, wouldDelete: 1 });
  });
});

describe('scheduling', () => {
  it('sweeps after the initial delay and then on the interval, and stops when told to', async () => {
    vi.useFakeTimers();
    const sweep = vi.fn(async () => ({}));
    const w = await world();
    const sweeper = w.sweeper('dry-run');
    sweeper.sweep = sweep as never;
    sweeper.start(HOUR, 5000);
    await vi.advanceTimersByTimeAsync(4999);
    expect(sweep).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(sweep).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(HOUR);
    expect(sweep).toHaveBeenCalledTimes(2);
    sweeper.stop();
    await vi.advanceTimersByTimeAsync(3 * HOUR);
    expect(sweep).toHaveBeenCalledTimes(2);
  });

  it('never schedules anything when it is off, and starting twice does not double the sweeps', async () => {
    vi.useFakeTimers();
    const w = await world();
    const off = w.sweeper('off');
    const spy = vi.spyOn(off, 'sweep');
    off.start(1000, 10);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(spy).not.toHaveBeenCalled();

    const on = w.sweeper('dry-run');
    const onSpy = vi.spyOn(on, 'sweep').mockResolvedValue({} as never);
    on.start(1000, 10);
    on.start(1000, 10);
    await vi.advanceTimersByTimeAsync(10);
    expect(onSpy).toHaveBeenCalledTimes(1);
    on.stop();
  });

  it('reports a failed sweep to the caller instead of throwing out of a timer', async () => {
    vi.useFakeTimers();
    const w = await world();
    const sweeper = w.sweeper('on');
    vi.spyOn(sweeper, 'sweep').mockRejectedValue(new Error('disk gone'));
    const onError = vi.fn();
    sweeper.start(1000, 10, onError);
    await vi.advanceTimersByTimeAsync(10);
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: 'disk gone' }));
    sweeper.stop();
  });
});

describe('what a capture stores when it is uploaded', () => {
  it('keeps only a valid request, so a client cannot store a deadline the sweeper would misread', async () => {
    const w = await world();
    const clean = await w.capture({ deleteAfter: '2026-06-15T10:00:00+02:00', deleteAfterPublication: true, extra: 'x' });
    expect(clean.retention).toEqual({ deleteAfter: '2026-06-15T08:00:00.000Z', deleteAfterPublication: true });
    expect((await w.capture({ deleteAfter: '1' })).retention).toBeUndefined();
    expect((await w.capture('delete everything')).retention).toBeUndefined();
    expect((await w.capture(undefined)).retention).toBeUndefined();
  });

  it('does the same for a streamed upload', async () => {
    const w = await world();
    const draft = await w.captures.beginDraft({ schema: 'kubus.capture/1', capturedAt: new Date().toISOString(), metadata: { intrinsics: true }, retention: { deleteAfter: 'someday', deleteAfterPublication: true } as never });
    await w.captures.writeDraftFile(draft.id, 'rgb/00000.jpg', Buffer.from([0xff, 0xd8, 0xff, 0xd9]), 'image/jpeg');
    await w.captures.writeDraftFile(draft.id, 'frames.json', Buffer.from(`${JSON.stringify({ schema: 'kubus.capture.frames/1', frames: [{ rgbPath: 'rgb/00000.jpg' }] })}\n`), 'application/json');
    const committed = await w.captures.commitDraft(draft.id);
    expect(committed.retention).toEqual({ deleteAfterPublication: true });
  });
});

describe('the operator switch', () => {
  const baseEnv = {
    KUBUS_API_BASE_URL: 'http://localhost:3000', KUBUS_OPERATOR_TOKEN: 'token', KUBUS_OPERATOR_WALLET: 'wallet', KUBUS_NODE_LABEL: 'node',
    KUBUS_NODE_ENDPOINT_URL: 'http://localhost:8080', IPFS_RPC_URL: 'http://localhost:5001', IPFS_GATEWAY_URL: 'http://localhost:8080',
    LOCAL_STATE_PATH: './data/state.json', LOG_LEVEL: 'info', HEARTBEAT_INTERVAL_MS: '5000', CID_SYNC_INTERVAL_MS: '30000',
    COMMITMENT_INTERVAL_MS: '30000', STATUS_INTERVAL_MS: '10000', MAX_PINNED_CIDS: '10', CID_CLASS_FILTERS: 'hot,warm', NODE_ENV: 'development',
  };

  it('is off unless set, with a day of grace and an hourly sweep', () => {
    expect(parseEnv(baseEnv)).toMatchObject({ retentionSweep: 'off', retentionGraceMs: DAY, retentionSweepIntervalMs: HOUR });
    expect(parseEnv({ ...baseEnv, KUBUS_RETENTION_SWEEP: '' }).retentionSweep).toBe('off');
  });

  it.each([['off', 'off'], ['dry-run', 'dry-run'], ['on', 'on'], [' ON ', 'on'], ['Dry-Run', 'dry-run']])('reads %j as %s', (value, expected) => {
    expect(parseEnv({ ...baseEnv, KUBUS_RETENTION_SWEEP: value }).retentionSweep).toBe(expected);
  });

  it.each(['true', '1', 'yes', 'enabled', 'dryrun', 'dry_run', 'onn', 'delete'])('refuses %j rather than guess that it means "delete"', (value) => {
    expect(() => parseEnv({ ...baseEnv, KUBUS_RETENTION_SWEEP: value })).toThrow('KUBUS_RETENTION_SWEEP must be off, dry-run or on');
  });

  it('lets the grace period and interval be tuned, within sane bounds', () => {
    expect(parseEnv({ ...baseEnv, KUBUS_RETENTION_GRACE_MS: '3600000', KUBUS_RETENTION_SWEEP_INTERVAL_MS: '120000' })).toMatchObject({ retentionGraceMs: HOUR, retentionSweepIntervalMs: 120_000 });
    expect(() => parseEnv({ ...baseEnv, KUBUS_RETENTION_SWEEP_INTERVAL_MS: '1000' })).toThrow();
  });
});
