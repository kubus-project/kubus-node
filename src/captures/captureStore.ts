import crypto from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { LocalStore } from '../state/localStore.js';
import { localError } from '../localApi/pairingService.js';
import { declaredFrameCount, inspectCapturePackage, type CapturePackageReport } from './capturePackage.js';

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
 * `reclaimOrphanedDirectories` runs in whichever process happens to start,
 * and a second process — the container healthcheck runs `kubus-node status` —
 * has an empty draft map, so every live transfer looks orphaned to it. The
 * serving process keeps its accounting in memory and never learns that its
 * directory was emptied underneath it, so the commit reports a complete
 * package over a directory holding only whatever arrived since. The marker is
 * the cross-process signal that the in-memory map cannot be.
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
    await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    let sizeBytes = 0;
    try {
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
    await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    await touchDraftMarker(directory, id);
    const draft: CaptureDraft = {
      id,
      state: 'draft',
      createdAt: new Date().toISOString(),
      directory,
      fileCount: 0,
      sizeBytes: 0,
    };
    this.drafts.set(id, {
      draft,
      payload,
      files: new Map(),
      lock: Promise.resolve(),
    });
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
    const result = entry.lock.then(
      () => this.writeDraftFileStreamExclusive(entry, rawPath, chunks, mimeType, maxBytes),
    );
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
    const entry = this.drafts.get(id);
    if (!entry) throw localError(404, 'capture_draft_not_found');
    if (entry.files.size === 0) throw localError(400, 'capture_package_empty');

    const localCaptureId = localCaptureIdOf(entry.payload);
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
          await fs.rm(entry.draft.directory, { recursive: true, force: true });
          return structuredClone(existing);
        }
        // Replace it, so one local capture still maps to one durable replica
        // rather than accumulating a second.
        await this.delete(existing.id).catch(() => undefined);
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

    try {
      // The marker is transfer bookkeeping, not capture content.
      await fs.rm(path.join(draft.directory, DRAFT_MARKER), { force: true }).catch(() => undefined);
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
      await this.store.update((state) => { (state.captures ??= {})[draft.id] = record; });
      this.drafts.delete(id);
      return record;
    } catch (error) {
      await fs.rm(draft.directory, { recursive: true, force: true });
      this.drafts.delete(id);
      throw error;
    }
  }

  /** Abandons a draft and deletes anything already uploaded. */
  async discardDraft(id: string): Promise<void> {
    const entry = this.drafts.get(id);
    if (!entry) throw localError(404, 'capture_draft_not_found');
    this.drafts.delete(id);
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
    let entries: string[];
    try {
      entries = await fs.readdir(this.root);
    } catch {
      // No capture root yet: nothing to reclaim.
      return 0;
    }

    const known = new Set(Object.keys(this.store.snapshot().captures || {}));
    let removed = 0;
    for (const name of entries) {
      if (known.has(name) || this.drafts.has(name)) continue;
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
    await entry.lock.catch(() => undefined);
    await this.reconcile(entry);
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
      const manifest = JSON.parse(
        await fs.readFile(path.join(record.directory, 'capture.json'), 'utf8'),
      ) as { files?: Array<{ path?: unknown }> };
      declaredPaths = (manifest.files ?? [])
        .map((file) => file.path)
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
    const jobs = Object.values(this.store.snapshot().jobs || {}) as Array<{ input?: { captureId?: string }; state?: string }>;
    if (jobs.some((job) => job.input?.captureId === id && ['queued', 'running'].includes(job.state || ''))) throw localError(409, 'capture_in_use');
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
