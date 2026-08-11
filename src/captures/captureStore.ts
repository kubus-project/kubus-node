import crypto from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { LocalStore } from '../state/localStore.js';
import { localError } from '../localApi/pairingService.js';

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
}

function safeRelativePath(raw: string): string {
  const normalized = raw.replaceAll('\\', '/').replace(/^\/+/, '');
  if (!normalized || normalized.includes('..') || path.isAbsolute(normalized)) throw localError(400, 'capture_file_path_invalid');
  return normalized;
}

export class CaptureStore {
  private readonly root: string;
  constructor(dataRoot: string, private readonly store: LocalStore) {
    this.root = path.join(dataRoot, 'private', 'captures');
  }

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

  get(id: string): CaptureRecord {
    const record = this.store.snapshot().captures?.[id] as CaptureRecord | undefined;
    if (!record) throw localError(404, 'capture_not_found');
    return structuredClone(record);
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
}
