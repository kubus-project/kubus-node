import crypto from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { LocalStore } from '../state/localStore.js';
import { localError } from '../localApi/pairingService.js';
import { declaredFrameCount, inspectCapturePackage, isPlainObject, type CapturePackageReport } from './capturePackage.js';

export interface CaptureFilePayload { path: string; contentBase64: string; mimeType?: string }
export interface CapturePackagePayload {
  schema: 'kubus.capture/1';
  artworkId?: string;
  markerId?: string;
  capturedAt: string;
  metadata: Record<string, unknown>;
  files: CaptureFilePayload[];
  retention?: { deleteAfter?: string };
}
/** Metadata that opens a streaming capture upload. Files arrive separately. */
export interface CaptureDraftPayload {
  schema: 'kubus.capture/1';
  artworkId?: string;
  markerId?: string;
  capturedAt: string;
  metadata: Record<string, unknown>;
  retention?: { deleteAfter?: string };
}

/** Progress of an in-flight streaming upload. */
export interface CaptureDraft {
  id: string;
  state: 'draft';
  createdAt: string;
  directory: string;
  fileCount: number;
  sizeBytes: number;
}

export interface CaptureRecord {
  id: string;
  schema: 'kubus.capture/1';
  state: 'stored';
  private: true;
  artworkId?: string;
  markerId?: string;
  capturedAt: string;
  createdAt: string;
  sizeBytes: number;
  fileCount: number;
  directory: string;
  retention?: { deleteAfter?: string };

  /**
   * Client-supplied idempotency key from `metadata.localCaptureId`.
   *
   * Lets a retry after a lost commit response converge on the same capture
   * instead of creating a duplicate.
   */
  localCaptureId?: string;
}

/**
 * Client-supplied idempotency key, if present.
 *
 * Optional: clients that do not send one keep the previous behaviour, where
 * every commit creates a new capture.
 */
function localCaptureIdOf(payload: { metadata?: Record<string, unknown> }): string | undefined {
  const raw = payload.metadata?.localCaptureId;
  if (typeof raw !== 'string') return undefined;
  const trimmed = raw.trim();
  return trimmed.length > 0 && trimmed.length <= 200 ? trimmed : undefined;
}

function safeRelativePath(raw: string): string {
  const normalized = raw.replaceAll('\\', '/').replace(/^\/+/, '');
  if (!normalized || normalized.includes('..') || path.isAbsolute(normalized)) throw localError(400, 'capture_file_path_invalid');
  return normalized;
}

/** Records that a transfer into `directory` is live, for other processes. */
async function touchDraftMarker(directory: string, id: string): Promise<void> {
  try {
    await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    await fs.writeFile(
      path.join(directory, DRAFT_MARKER),
      `${JSON.stringify({ id, touchedAt: new Date().toISOString() })}
`,
      { mode: 0o600 },
    );
  } catch {
    // Best effort. A marker that cannot be written costs the directory its
    // cross-process protection, but must never fail the upload itself.
  }
}

/** Milliseconds since a directory's draft marker was last written, or null. */
async function draftMarkerAgeMs(directory: string): Promise<number | null> {
  try {
    const stat = await fs.stat(path.join(directory, DRAFT_MARKER));
    return Date.now() - stat.mtimeMs;
  } catch {
    return null;
  }
}

const MAX_CAPTURE_BYTES = 5 * 1024 * 1024 * 1024;
const MAX_CAPTURE_FILES = 5000;

/**
 * Marks a directory as an upload in progress, for processes that cannot see
 * this one's in-memory draft map.
 *
 * Any process other than the serving one — the container healthcheck runs
 * `kubus-node status` every 30 seconds — has an empty draft map, so every live
 * transfer looks orphaned to it. Builds up to 0.8.0-alpha.10 swept from every
 * command, and the serving process, keeping its accounting in memory, never
 * learned that its directory was emptied underneath it: the commit reported a
 * complete package over a directory holding only whatever arrived since. Only
 * serving commands sweep now, but the marker remains the cross-process signal
 * that the in-memory map cannot be.
 */
const DRAFT_MARKER = '.draft.json';

/**
 * How long a draft directory is protected after its last write.
 *
 * Long enough to cover a stalled-but-live transfer (the client's per-file
 * timeout is minutes, so a healthy upload refreshes this far more often),
 * short enough that a directory stranded by a crash is reclaimed on a later
 * sweep rather than held forever.
 */
const DRAFT_IDLE_GRACE_MS = 30 * 60 * 1000;

/**
 * How often the serving process re-sweeps for orphans.
 *
 * The startup sweep alone cannot finish the job: a restart shortly after an
 * interrupted upload finds that directory's marker still fresh and must spare
 * it, and nothing would ever look again. Half the grace period bounds how long
 * an abandoned directory can outlive it, without polling the disk.
 */
export const ORPHAN_SWEEP_INTERVAL_MS = DRAFT_IDLE_GRACE_MS / 2;

/**
 * How often a single long file refreshes its draft's marker mid-stream.
 *
 * The marker is otherwise rewritten only when a file completes, and one large
 * file over a slow relay can take longer than the grace period.
 */
const MARKER_REFRESH_MS = 60 * 1000;

/** True when a queued or running job in `jobs` reads `captureId`. */
function activeJobOn(jobs: Record<string, unknown> | undefined, captureId: string): boolean {
  return (Object.values(jobs || {}) as Array<{ input?: { captureId?: string }; state?: string }>)
    .some((job) => job.input?.captureId === captureId && ['queued', 'running'].includes(job.state || ''));
}

async function* oneChunk(bytes: Buffer): AsyncIterable<Buffer> {
  yield bytes;
}

interface DraftEntry {
  draft: CaptureDraft;
  payload: CaptureDraftPayload;
  files: Map<string, { bytes: number; mimeType?: string }>;

  /**
   * Serializes mutations of this draft.
   *
   * Accounting is a read-modify-write around filesystem awaits, so concurrent
   * uploads to the same draft would otherwise each compute a total from the
   * same pre-write value and the last writer would clobber the rest. That both
   * under-reports size and lets the file and byte ceilings be exceeded.
   */
  lock: Promise<unknown>;

  /** When this draft's marker was last written, in epoch milliseconds. */
  markerTouchedAt: number;

  /** File writes queued or running against this draft. */
  writesInFlight: number;
}

export class CaptureStore {
  private readonly root: string;

  /**
   * In-flight streaming uploads, keyed by draft id.
   *
   * Intentionally in-memory: a draft is a transfer in progress, not durable
   * state. A node restart mid-upload abandons the draft, and the client
   * retries — the same outcome as any other interrupted transfer.
   */
  private readonly drafts = new Map<string, DraftEntry>();

  /**
   * Serializes commits across drafts.
   *
   * A commit that replaces a damaged replica reads the record it retires,
   * validates, then swaps. Two commits for the same local capture interleaving
   * across those awaits would both retire the same record and both install a
   * replacement, leaving two durable replicas of one capture.
   */
  private commitLock: Promise<unknown> = Promise.resolve();

  /**
   * Whole-package uploads (`create`) still being written.
   *
   * They have no draft entry and no marker, and are only recorded in state
   * once every file has landed, so without this a sweep running while one is
   * written would see an unowned directory.
   */
  private readonly creating = new Set<string>();

  /** The sweep in progress, so a slow one is never overlapped by the next. */
  private sweeping: Promise<number> | null = null;

  constructor(dataRoot: string, private readonly store: LocalStore) {
    this.root = path.join(dataRoot, 'private', 'captures');
  }

  /**
   * The legacy whole-package route, kept for clients that have not migrated.
   *
   * Not an integrity boundary in the way `commitDraft` is: a package arrives
   * here in one request, so it cannot be half-transferred, and the failure
   * this file exists to prevent — a streamed upload losing files — cannot
   * happen on this path. A package declared here that is nevertheless
   * unusable is caught where it would cost something, in `JobRuntime.create`,
   * which refuses to reserve a GPU for a capture that fails `inspect`.
   */
  async create(payload: CapturePackagePayload): Promise<CaptureRecord> {
    if (payload.schema !== 'kubus.capture/1' || !payload.capturedAt || !payload.metadata || !Array.isArray(payload.files)) {
      throw localError(400, 'capture_package_invalid');
    }
    if (payload.files.length > 5000) throw localError(413, 'capture_file_count_exceeded');
    const id = crypto.randomUUID();
    const directory = path.join(this.root, id);
    this.creating.add(id);
    let sizeBytes = 0;
    try {
      await fs.mkdir(directory, { recursive: true, mode: 0o700 });
      for (const file of payload.files) {
        const relative = safeRelativePath(file.path);
        const bytes = Buffer.from(file.contentBase64, 'base64');
        sizeBytes += bytes.byteLength;
        if (sizeBytes > 5 * 1024 * 1024 * 1024) throw localError(413, 'capture_size_exceeded');
        const target = path.join(directory, relative);
        if (!target.startsWith(`${directory}${path.sep}`)) throw localError(400, 'capture_file_path_invalid');
        await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
        await fs.writeFile(target, bytes, { mode: 0o600 });
      }
      const record: CaptureRecord = {
        id,
        schema: 'kubus.capture/1',
        state: 'stored',
        private: true,
        artworkId: payload.artworkId,
        markerId: payload.markerId,
        capturedAt: payload.capturedAt,
        createdAt: new Date().toISOString(),
        sizeBytes,
        fileCount: payload.files.length,
        directory,
        retention: payload.retention,
      };
      await fs.writeFile(path.join(directory, 'capture.json'), `${JSON.stringify({ ...payload, files: payload.files.map(({ path: filePath, mimeType }) => ({ path: safeRelativePath(filePath), mimeType })) }, null, 2)}\n`, { mode: 0o600 });
      await this.store.update((state) => { (state.captures ??= {})[id] = record; });
      return record;
    } catch (error) {
      await fs.rm(directory, { recursive: true, force: true });
      throw error;
    } finally {
      // Released only after the record is in state, so the directory is
      // never unclaimed in between.
      this.creating.delete(id);
    }
  }

  /**
   * Opens a draft capture that files are streamed into one at a time.
   *
   * The JSON endpoint requires the whole capture in memory as base64 on both
   * ends, which inflates a package by ~33% on the wire and forces the client
   * to hold every frame at once. A draft lets a mobile capture upload
   * incrementally and resume a failed transfer without resending what already
   * landed.
   */
  async beginDraft(payload: CaptureDraftPayload): Promise<CaptureDraft> {
    if (payload.schema !== 'kubus.capture/1' || !payload.capturedAt || !payload.metadata) {
      throw localError(400, 'capture_package_invalid');
    }
    const id = crypto.randomUUID();
    const directory = path.join(this.root, id);
    const draft: CaptureDraft = {
      id,
      state: 'draft',
      createdAt: new Date().toISOString(),
      directory,
      fileCount: 0,
      sizeBytes: 0,
    };
    // Registered before the directory exists, so a sweep in this process can
    // never observe the directory without its owner.
    this.drafts.set(id, {
      draft,
      payload,
      files: new Map(),
      lock: Promise.resolve(),
      markerTouchedAt: Date.now(),
      writesInFlight: 0,
    });
    try {
      await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    } catch (error) {
      this.drafts.delete(id);
      throw error;
    }
    await touchDraftMarker(directory, id);
    return structuredClone(draft);
  }

  /**
   * Appends one file to a draft from a raw byte buffer.
   *
   * Re-uploading the same path overwrites it, so a client retrying an
   * interrupted transfer converges instead of duplicating.
   */
  async writeDraftFile(
    id: string,
    rawPath: string,
    bytes: Buffer,
    mimeType?: string,
  ): Promise<CaptureDraft> {
    return this.writeDraftFileStream(id, rawPath, oneChunk(bytes), mimeType);
  }

  /** Streams a file directly to a temporary file and promotes it atomically. */
  async writeDraftFileStream(
    id: string,
    rawPath: string,
    chunks: AsyncIterable<Buffer>,
    mimeType?: string,
    maxBytes = MAX_CAPTURE_BYTES,
  ): Promise<CaptureDraft> {
    const entry = this.drafts.get(id);
    if (!entry) throw localError(404, 'capture_draft_not_found');

    // Queue behind any in-flight mutation of this draft. Chained on the entry
    // so uploads to different drafts still proceed in parallel.
    entry.writesInFlight += 1;
    const result = entry.lock.then(
      () => this.writeDraftFileStreamExclusive(entry, rawPath, chunks, mimeType, maxBytes),
    ).finally(() => { entry.writesInFlight -= 1; });
    // Keep the chain alive even if this write rejects, so one failed upload
    // does not poison every later one.
    entry.lock = result.catch(() => undefined);
    return result;
  }

  private async writeDraftFileStreamExclusive(
    entry: DraftEntry,
    rawPath: string,
    chunks: AsyncIterable<Buffer>,
    mimeType?: string,
    maxBytes = MAX_CAPTURE_BYTES,
  ): Promise<CaptureDraft> {
    const relative = safeRelativePath(rawPath);
    const target = path.join(entry.draft.directory, relative);
    if (!target.startsWith(`${entry.draft.directory}${path.sep}`)) {
      throw localError(400, 'capture_file_path_invalid');
    }

    const existing = entry.files.get(relative);
    if (!existing && entry.files.size >= MAX_CAPTURE_FILES) {
      throw localError(413, 'capture_file_count_exceeded');
    }

    await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
    const temporary = `${target}.partial-${crypto.randomUUID()}`;
    let handle: Awaited<ReturnType<typeof fs.open>> | undefined;
    let written = 0;
    try {
      handle = await fs.open(temporary, 'w', 0o600);
      for await (const chunk of chunks) {
        const bytes = Buffer.from(chunk);
        written += bytes.byteLength;
        if (written > maxBytes) throw localError(413, 'request_too_large');
        const nextSize = entry.draft.sizeBytes - (existing?.bytes ?? 0) + written;
        if (nextSize > MAX_CAPTURE_BYTES) throw localError(413, 'capture_size_exceeded');
        for (let offset = 0; offset < bytes.byteLength;) {
          const result = await handle.write(bytes, offset, bytes.byteLength - offset);
          offset += result.bytesWritten;
        }
        if (Date.now() - entry.markerTouchedAt >= MARKER_REFRESH_MS) {
          entry.markerTouchedAt = Date.now();
          await touchDraftMarker(entry.draft.directory, entry.draft.id);
        }
      }
      if (written === 0) throw localError(400, 'capture_file_empty');
      await handle.close();
      handle = undefined;
      await fs.rename(temporary, target);
    } catch (error) {
      await handle?.close().catch(() => undefined);
      await fs.rm(temporary, { force: true }).catch(() => undefined);
      throw error;
    }
    entry.files.set(relative, { bytes: written, mimeType });
    entry.draft.sizeBytes = entry.draft.sizeBytes - (existing?.bytes ?? 0) + written;
    entry.draft.fileCount = entry.files.size;
    // Rewritten rather than touched so a marker lost to an outside sweep
    // comes back, and so the next sweep sees a live transfer.
    entry.markerTouchedAt = Date.now();
    await touchDraftMarker(entry.draft.directory, entry.draft.id);
    return structuredClone(entry.draft);
  }

  /**
   * Finalizes a draft into a stored capture.
   *
   * Idempotent on `metadata.localCaptureId` when the client supplies one. If
   * the commit response is lost the client cannot tell success from failure,
   * and its retry would otherwise upload a fresh draft and produce a second
   * durable capture plus duplicate processing work. Returning the existing
   * record instead makes the retry converge.
   */
  async commitDraft(id: string): Promise<CaptureRecord> {
    const result = this.commitLock.then(() => {
      const entry = this.drafts.get(id);
      if (!entry) throw localError(404, 'capture_draft_not_found');
      // Behind this draft's own writes too, so the package is inspected only
      // once every file already sent has either landed or failed.
      const committed = entry.lock.catch(() => undefined).then(() => this.commitDraftExclusive(id, entry));
      entry.lock = committed.catch(() => undefined);
      return committed;
    });
    this.commitLock = result.catch(() => undefined);
    return result;
  }

  private async commitDraftExclusive(id: string, entry: DraftEntry): Promise<CaptureRecord> {
    // Rechecked now the queue has drained: a commit queued behind another
    // commit of this same draft finds it already gone.
    if (this.drafts.get(id) !== entry) throw localError(404, 'capture_draft_not_found');
    if (entry.files.size === 0) throw localError(400, 'capture_package_empty');

    const localCaptureId = localCaptureIdOf(entry.payload);
    let replaces: CaptureRecord | undefined;
    if (localCaptureId) {
      const existing = (Object.values(this.store.snapshot().captures || {}) as CaptureRecord[])
        .find((record) => record.localCaptureId === localCaptureId);
      if (existing) {
        // Idempotency must not resurrect a replica that cannot be processed.
        // A client re-uploading a capture it already sent is usually a lost
        // response, but it is also how it repairs a stored capture that lost
        // files — and answering that with the broken record would make the
        // damage permanent.
        const health = await this.inspect(existing.id).catch(() => undefined);
        if (health?.ok !== false) {
          // A retry of an already-committed capture. Drop the redundant
          // upload rather than leaving its directory stranded on disk.
          this.drafts.delete(id);
          if (path.resolve(entry.draft.directory) !== path.resolve(existing.directory)) {
            await fs.rm(entry.draft.directory, { recursive: true, force: true });
          }
          return structuredClone(existing);
        }
        // Replaced only once the upload proves to be a complete package. A
        // damaged replica still holds whatever survived, and a repair that
        // turns out to be broken too must not cost the user that as well.
        replaces = existing;
      }
    }

    const { draft, payload } = entry;

    // The integrity boundary. Everything above this point is the client's
    // account of the transfer; below it the capture becomes durable state
    // that a reconstruction job will be built from. A package that cannot be
    // processed must be refused here, while the phone still holds the source.
    const inspection = await inspectCapturePackage(draft.directory, {
      // The set as received, before reconciliation: a file the transfer
      // delivered and the directory has since lost is `capture_package_
      // incomplete` — a transfer-integrity failure, distinct from a manifest
      // referencing something that was never sent.
      declaredPaths: entry.files.keys(),
      expectedFrameCount: declaredFrameCount(payload),
    });
    if (!inspection.ok) {
      // Bring the draft's accounting back in line with the directory, so the
      // client's next resume asks for exactly what is gone.
      await this.reconcile(entry);
      // Deliberately leaves the draft intact. Everything already uploaded
      // stays usable, so the client sends only what is missing instead of
      // restarting a transfer that may be hundreds of megabytes.
      throw localError(422, inspection.code!, {
        message: inspection.message,
        missingPaths: inspection.missingPaths,
        missingCount: inspection.missingCount,
        uploadedFiles: entry.files.size,
        uploadedBytes: draft.sizeBytes,
      });
    }

    if (replaces && this.hasActiveJob(replaces.id)) {
      // A job is reading the old replica. Swapping it out mid-run would fail
      // that job for a reason unrelated to its own work; the draft stays, so
      // the commit can simply be repeated once the job has finished.
      throw localError(409, 'capture_in_use');
    }

    try {
      const files = [...entry.files.entries()].map(([filePath, meta]) => ({
        path: filePath,
        mimeType: meta.mimeType,
      }));
      const record: CaptureRecord = {
        id: draft.id,
        schema: 'kubus.capture/1',
        state: 'stored',
        private: true,
        artworkId: payload.artworkId,
        markerId: payload.markerId,
        capturedAt: payload.capturedAt,
        createdAt: draft.createdAt,
        sizeBytes: draft.sizeBytes,
        fileCount: entry.files.size,
        directory: draft.directory,
        retention: payload.retention,
        localCaptureId,
      };
      await fs.writeFile(
        path.join(draft.directory, 'capture.json'),
        `${JSON.stringify({ ...payload, files }, null, 2)}\n`,
        { mode: 0o600 },
      );
      // One state write both installs the replacement and retires what it
      // replaces, so at no point does the local capture map to zero replicas
      // or to two. The old directory is removed only after that write: a
      // crash in between leaves it unreferenced, and the orphan sweep takes it.
      await this.store.update((state) => {
        // Asked again inside the mutation, which nothing interleaves with: a
        // job queued on the old replica since the check above must not lose
        // its capture while it waits to run. Thrown before anything changes.
        if (replaces && activeJobOn(state.jobs, replaces.id)) throw localError(409, 'capture_in_use');
        const captures = (state.captures ??= {});
        if (replaces && (captures[replaces.id] as CaptureRecord | undefined)?.directory === replaces.directory) {
          delete captures[replaces.id];
        }
        captures[draft.id] = record;
      });
      this.drafts.delete(id);
      // The marker is transfer bookkeeping, not capture content. Removed only
      // now, so the directory is never unowned and unmarked at the same time.
      await fs.rm(path.join(draft.directory, DRAFT_MARKER), { force: true }).catch(() => undefined);
      if (replaces && path.resolve(replaces.directory) !== path.resolve(draft.directory)) {
        await fs.rm(replaces.directory, { recursive: true, force: true }).catch(() => undefined);
      }
      return record;
    } catch (error) {
      if (this.store.snapshot().captures?.[draft.id]) {
        // The record landed and something after it failed. The directory now
        // belongs to that record; removing it would leave it pointing at
        // nothing.
        this.drafts.delete(id);
      }
      // Otherwise the draft stays exactly as it was: every uploaded file is
      // still there, the replaced record is untouched, and the commit can be
      // repeated. An abandoned draft is reclaimed by the orphan sweep.
      throw error;
    }
  }

  /** True while a queued or running job reads this capture. */
  private hasActiveJob(captureId: string): boolean {
    return activeJobOn(this.store.snapshot().jobs, captureId);
  }

  /** Abandons a draft and deletes anything already uploaded. */
  async discardDraft(id: string): Promise<void> {
    const entry = this.drafts.get(id);
    if (!entry) throw localError(404, 'capture_draft_not_found');
    // Forgotten first so nothing new can start; then removed only once the
    // write already in flight has finished, which would otherwise recreate
    // the directory it was writing into.
    this.drafts.delete(id);
    await entry.lock.catch(() => undefined);
    if (this.store.snapshot().captures?.[id]) {
      // A commit already under way when the discard arrived won. Its record
      // owns this directory now; removing it would leave that record
      // pointing at nothing.
      throw localError(409, 'capture_draft_committed');
    }
    await fs.rm(entry.draft.directory, { recursive: true, force: true });
  }

  /**
   * Deletes capture directories that no longer belong to anything.
   *
   * Drafts are in-memory, so a node restart between the first upload and the
   * commit leaves a directory on disk with no state entry and no way for the
   * client to reach it. Without this sweep every interrupted transfer would
   * strand up to the per-capture ceiling and eventually exhaust the disk.
   *
   * Only directories unknown to both `state.captures` and the live draft map
   * are removed, so a committed capture and an upload in progress are never
   * touched. Returns the number reclaimed.
   */
  async reclaimOrphanedDirectories(): Promise<number> {
    // Joined rather than overlapped: two sweeps racing over one directory
    // gain nothing and double the disk work.
    if (this.sweeping) return this.sweeping;
    this.sweeping = this.sweepOnce().finally(() => { this.sweeping = null; });
    return this.sweeping;
  }

  /**
   * Re-sweeps on a schedule for as long as this process serves uploads.
   *
   * Owned by the serving process, because only it knows which drafts are
   * live: a sweep anywhere else is exactly the healthcheck bug. The timer is
   * unref'd, so it never keeps a stopping process alive.
   */
  startOrphanSweeps(options: {
    intervalMs?: number;
    onReclaimed?: (count: number) => void;
    onError?: (error: unknown) => void;
  } = {}): { stop(): void } {
    const timer = setInterval(() => {
      this.reclaimOrphanedDirectories().then(
        (count) => { if (count > 0) options.onReclaimed?.(count); },
        (error: unknown) => options.onError?.(error),
      );
    }, options.intervalMs ?? ORPHAN_SWEEP_INTERVAL_MS);
    timer.unref();
    return { stop: () => clearInterval(timer) };
  }

  private async sweepOnce(): Promise<number> {
    let entries: string[];
    try {
      entries = await fs.readdir(this.root);
    } catch {
      // No capture root yet: nothing to reclaim.
      return 0;
    }

    let removed = 0;
    for (const name of entries) {
      if (this.ownsDirectory(name)) continue;
      const directory = path.join(this.root, name);
      try {
        const stat = await fs.stat(directory);
        if (!stat.isDirectory()) continue;
        // The draft map only describes this process. A transfer being served
        // by another one is invisible here, and deleting it would destroy a
        // live upload while its owner carries on accounting for files that no
        // longer exist.
        const markerAge = await draftMarkerAgeMs(directory);
        if (markerAge !== null && markerAge < DRAFT_IDLE_GRACE_MS) continue;
        // Asked again after the last await and immediately before removal:
        // a draft opened or committed while this sweep was reading the disk
        // has an owner now, and the answer from the top of the loop is stale.
        if (this.ownsDirectory(name)) continue;
        await fs.rm(directory, { recursive: true, force: true });
        removed += 1;
      } catch {
        // A directory that cannot be removed is left for the next sweep
        // rather than failing startup.
      }
    }
    return removed;
  }

  /**
   * True when a stored capture or a live draft of this process claims `name`.
   *
   * Synchronous on purpose. A commit records its capture before it forgets its
   * draft, so with no await between the two questions there is no moment at
   * which a committing upload is claimed by neither.
   */
  private ownsDirectory(name: string): boolean {
    return this.drafts.has(name)
      || this.creating.has(name)
      || Boolean(this.store.snapshot().captures?.[name]);
  }

  /**
   * Drops in-memory drafts without touching disk, reproducing what a node
   * restart leaves behind.
   */
  async forgetDraftsForTesting(): Promise<void> {
    this.drafts.clear();
  }

  /**
   * Drops accounting for files the directory no longer holds.
   *
   * In-memory accounting records what arrived, not what survived. Anything
   * that removed a file after upload — an outside sweep, an operator, a disk
   * error — must not leave the draft claiming it, or a resume skips the file
   * and the commit certifies a package that cannot be processed.
   */
  private async reconcile(entry: DraftEntry): Promise<string[]> {
    const lost: string[] = [];
    for (const [relative, meta] of [...entry.files.entries()]) {
      let present = false;
      try {
        const stat = await fs.stat(path.join(entry.draft.directory, relative));
        present = stat.isFile() && stat.size > 0;
      } catch {
        present = false;
      }
      if (present) continue;
      entry.files.delete(relative);
      entry.draft.sizeBytes -= meta.bytes;
      lost.push(relative);
    }
    if (lost.length > 0) {
      entry.draft.fileCount = entry.files.size;
      if (entry.draft.sizeBytes < 0) entry.draft.sizeBytes = 0;
    }
    return lost;
  }

  /**
   * Draft progress, so a client can resume without re-uploading.
   *
   * Reports what the directory actually holds: a client that resumes against
   * stale accounting would skip exactly the files it needs to resend.
   */
  async getDraft(id: string): Promise<CaptureDraft & { files: string[] }> {
    const entry = this.drafts.get(id);
    if (!entry) throw localError(404, 'capture_draft_not_found');
    // Answered at once, never behind a write. The write still in flight may
    // belong to a connection that died without the server noticing yet, and
    // this is the very request a client makes to find out what to resend.
    // Accounting only ever lists completed files, so the file in flight is
    // simply not reported yet. Reconciling waits until nothing is writing, so
    // it never interleaves with a write's own accounting; the commit
    // reconciles regardless.
    if (entry.writesInFlight === 0) await this.reconcile(entry);
    return { ...structuredClone(entry.draft), files: [...entry.files.keys()] };
  }

  get(id: string): CaptureRecord {
    const record = this.store.snapshot().captures?.[id] as CaptureRecord | undefined;
    if (!record) throw localError(404, 'capture_not_found');
    return structuredClone(record);
  }

  /**
   * Re-checks a stored capture against its own manifest.
   *
   * `state: 'stored'` records what was true at commit. Anything that removed
   * files afterwards leaves a record that still looks processable, and the
   * first component to notice would otherwise be the reconstruction adapter
   * failing on a `copyFile`. Callers use this as a precondition rather than
   * discovering it after a GPU has been reserved.
   */
  async inspect(id: string): Promise<CapturePackageReport> {
    const record = this.get(id);
    let declaredPaths: string[] = [];
    try {
      const manifest: unknown = JSON.parse(
        await fs.readFile(path.join(record.directory, 'capture.json'), 'utf8'),
      );
      const files = isPlainObject(manifest) && Array.isArray(manifest.files) ? manifest.files : [];
      declaredPaths = files
        .map((file: unknown) => (isPlainObject(file) ? file.path : undefined))
        .filter((filePath): filePath is string => typeof filePath === 'string');
    } catch {
      // A capture without a readable manifest still has to answer for its
      // frames; `inspectCapturePackage` reports whatever is actually wrong.
    }
    return inspectCapturePackage(record.directory, { declaredPaths });
  }

  list(): CaptureRecord[] {
    return Object.values(this.store.snapshot().captures || {}) as CaptureRecord[];
  }

  async delete(id: string): Promise<void> {
    const record = this.get(id);
    if (this.hasActiveJob(id)) throw localError(409, 'capture_in_use');
    await fs.rm(record.directory, { recursive: true, force: true });
    await this.store.update((state) => { if (state.captures) delete state.captures[id]; });
  }

  async registerRemote(record: CaptureRecord): Promise<CaptureRecord> {
    if (!record.private || record.schema !== 'kubus.capture/1' || !path.isAbsolute(record.directory)) throw localError(400, 'remote_capture_invalid');
    await fs.access(record.directory);
    await this.store.update((state) => { (state.captures ??= {})[record.id] = record; });
    return structuredClone(record);
  }

  async removeRemote(id: string): Promise<void> {
    const record = this.get(id);
    await fs.rm(record.directory, { recursive: true, force: true });
    await this.store.update((state) => { if (state.captures) delete state.captures[id]; });
  }
}
