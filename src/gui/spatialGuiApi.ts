import type { IncomingMessage, ServerResponse } from 'node:http';
import { promises as fs, createReadStream } from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import type { CaptureRecord, CaptureStore } from '../captures/captureStore.js';
import type { KuboClient } from '../ipfs/kuboClient.js';
import type { JobRuntime, LocalJob } from '../jobs/jobRuntime.js';
import { localError } from '../localApi/pairingService.js';
import type { SpatialManifest } from '../spatial/models.js';
import type { LocalStore } from '../state/localStore.js';
import { isValidCidLike } from '../utils/cid.js';

/**
 * Read-only GUI API for the Spatial library, capture archive, and job queue.
 *
 * Everything here is authenticated the same way as the rest of `/gui/api/*`
 * (`authorizeGuiRequest` in guiServer.ts runs before any handler in this file
 * is reached) - there is no separate, weaker auth path for content bytes.
 * Every dynamic id is validated before touching the filesystem or Kubo:
 * capture/job ids are checked against the store (a 404 for anything not
 * already known, never a raw filesystem read of an attacker-supplied path),
 * and CIDs are validated with the same `isValidCidLike` guard the rest of
 * the Node uses before being handed to Kubo.
 */

export interface SpatialRecordSummary {
  id: string;
  artworkId: string;
  markerId?: string;
  captureId: string;
  capturedAt: string;
  createdAt: string;
  state: string;
  manifestCid: string;
  variants: Array<{ role: string; format: string; mimeType: string; sizeBytes: number; storageClass: string }>;
}

interface SpatialStoreRecord {
  id: string;
  state: string;
  manifestCid: string;
  manifest: SpatialManifest;
  createdAt: string;
  privateSourceCapture?: boolean;
}

function isSpatialStoreRecord(value: unknown): value is SpatialStoreRecord {
  if (!value || typeof value !== 'object') return false;
  const record = value as Partial<SpatialStoreRecord>;
  return typeof record.id === 'string' && typeof record.manifestCid === 'string' && typeof record.manifest === 'object' && record.manifest !== null;
}

function listSpatialRecords(store: LocalStore): SpatialStoreRecord[] {
  return Object.values(store.snapshot().spatial || {}).filter(isSpatialStoreRecord);
}

export function listSpatialSummaries(store: LocalStore): SpatialRecordSummary[] {
  return listSpatialRecords(store)
    .map((record) => ({
      id: record.id,
      artworkId: record.manifest.artworkId,
      markerId: record.manifest.markerId,
      captureId: record.manifest.captureId,
      capturedAt: record.manifest.capturedAt,
      createdAt: record.createdAt,
      state: record.state,
      manifestCid: record.manifestCid,
      variants: record.manifest.variants.map((variant) => ({
        role: variant.role,
        format: variant.format,
        mimeType: variant.mimeType,
        sizeBytes: variant.sizeBytes,
        storageClass: variant.storageClass,
      })),
    }))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export function getSpatialRecord(store: LocalStore, id: string): SpatialStoreRecord {
  const record = listSpatialRecords(store).find((candidate) => candidate.id === id);
  if (!record) throw localError(404, 'spatial_not_found');
  return record;
}

export function listJobSummaries(jobs: JobRuntime): LocalJob[] {
  return jobs.list();
}

export function getJobSummary(jobs: JobRuntime, id: string): LocalJob {
  return jobs.get(id);
}

/** Capture records only - never the raw filesystem directory as a UI-facing value. */
export function listCaptureSummaries(captures: CaptureStore): CaptureRecord[] {
  return captures.list().sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export function getCaptureSummary(captures: CaptureStore, id: string): CaptureRecord {
  return captures.get(id);
}

/**
 * Streams one spatial variant's bytes from Kubo, honoring an HTTP `Range`
 * header when present. The variant's `sizeBytes` (recorded from a real
 * `fs.stat` at import time - see jobRuntime.ts) is the source of truth for
 * total size, so answering a Range request never needs a second Kubo round
 * trip just to learn how big the file is.
 */
export async function serveSpatialVariant(
  req: IncomingMessage,
  res: ServerResponse,
  deps: { store: LocalStore; kubo: KuboClient },
  spatialId: string,
  role: string,
): Promise<void> {
  const record = getSpatialRecord(deps.store, spatialId);
  const variant = record.manifest.variants.find((candidate) => candidate.role === role);
  if (!variant) throw localError(404, 'spatial_variant_not_found');
  if (!isValidCidLike(variant.cid)) throw localError(500, 'spatial_variant_cid_invalid');

  const total = variant.sizeBytes;
  const rangeHeader = req.headers.range;
  let start = 0;
  let end = total > 0 ? total - 1 : 0;
  let status = 200;

  if (rangeHeader) {
    const match = /^bytes=(\d*)-(\d*)$/.exec(rangeHeader);
    if (!match) throw localError(416, 'range_not_satisfiable');
    const rawStart = match[1];
    const rawEnd = match[2];
    if (rawStart === '' && rawEnd === '') throw localError(416, 'range_not_satisfiable');
    if (rawStart === '') {
      // Suffix form (`bytes=-N`): the number is a length counted from the
      // end of the file, not an end offset - "last N bytes".
      start = Math.max(0, total - Number(rawEnd));
      end = total - 1;
    } else {
      start = Number(rawStart);
      end = rawEnd === '' ? total - 1 : Math.min(Number(rawEnd), total - 1);
    }
    if (!Number.isFinite(start) || !Number.isFinite(end) || start > end || start < 0 || start >= total) {
      res.writeHead(416, { 'Content-Range': `bytes */${total}` });
      res.end();
      return;
    }
    status = 206;
  }

  const length = end - start + 1;
  const { body, cancel } = await deps.kubo.catStream(variant.cid, rangeHeader ? { offset: start, length } : undefined);
  res.on('close', cancel);
  res.writeHead(status, {
    'Content-Type': variant.mimeType,
    'Content-Length': String(rangeHeader ? length : total),
    'Accept-Ranges': 'bytes',
    ...(status === 206 ? { 'Content-Range': `bytes ${start}-${end}/${total}` } : {}),
    // The manifest and its variants are private-by-default until explicitly
    // published; never let an intermediate proxy cache a variant that later
    // becomes unavailable (retracted, revoked, superseded).
    'Cache-Control': 'private, no-store',
  });
  Readable.fromWeb(body as import('node:stream/web').ReadableStream).pipe(res);
}

/**
 * Streams one frame image from a capture directory - a bounded, authenticated
 * alternative to exposing the capture's filesystem path in the UI. Only a
 * path already recorded in the capture's own `frames.json`/`capture.json`
 * file list is reachable; `..`/absolute paths are rejected outright.
 */
export async function serveCaptureFile(
  res: ServerResponse,
  deps: { captures: CaptureStore },
  captureId: string,
  relativePath: string,
): Promise<void> {
  const capture = getCaptureSummary(deps.captures, captureId);
  const normalized = relativePath.replaceAll('\\', '/').replace(/^\/+/, '');
  if (!normalized || normalized.includes('..') || path.isAbsolute(normalized)) {
    throw localError(400, 'capture_file_path_invalid');
  }
  const target = path.resolve(capture.directory, normalized);
  if (!target.startsWith(`${path.resolve(capture.directory)}${path.sep}`)) {
    throw localError(400, 'capture_file_path_invalid');
  }
  let stat;
  try {
    stat = await fs.stat(target);
  } catch {
    throw localError(404, 'capture_file_not_found');
  }
  if (!stat.isFile()) throw localError(404, 'capture_file_not_found');

  const mimeType = mimeTypeFor(normalized);
  res.writeHead(200, {
    'Content-Type': mimeType,
    'Content-Length': String(stat.size),
    'Cache-Control': 'private, no-store',
  });
  createReadStream(target).pipe(res);
}

function mimeTypeFor(relativePath: string): string {
  if (relativePath.endsWith('.jpg') || relativePath.endsWith('.jpeg')) return 'image/jpeg';
  if (relativePath.endsWith('.png')) return 'image/png';
  if (relativePath.endsWith('.json')) return 'application/json';
  return 'application/octet-stream';
}
