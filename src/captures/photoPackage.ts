import { promises as fs } from 'node:fs';
import type { FileHandle } from 'node:fs/promises';
import path from 'node:path';

/**
 * Integrity checks for the still photographs of a `photos` or `mixed` capture
 * package: images under `photos/`, with no camera poses.
 *
 * A photo set carries no ARCore pose and no intrinsics, so the worker solves
 * both with COLMAP. This module is the cheap boundary in front of that GPU
 * work: it proves each file is what its extension says (signature, a readable
 * size header, a complete tail so a truncated upload is caught), applies bounds
 * on count, bytes and pixels, and reports the EXIF orientation tags that the
 * worker will bake into the pixels. Names under `photos/` are untrusted: they
 * are only listed and tested against an extension allow-list here, the Node
 * never builds a path from them beyond `photos/<name>` inside the capture
 * directory, and the worker renames every image to a constant name.
 */

export const PHOTO_EXTENSIONS = ['jpg', 'jpeg', 'png'] as const;
export type PhotoExtension = typeof PHOTO_EXTENSIONS[number];

/** Fewer than this cannot be a reconstruction attempt at all. The worker's registered-view floor is the real gate. */
export const PHOTO_MIN_COUNT = 8;
export const PHOTO_MAX_COUNT = 400;
export const PHOTO_MIN_BYTES = 16 * 1024;
export const PHOTO_MAX_BYTES = 120 * 1024 * 1024;
/** Shortest side in pixels; smaller images carry too little detail to register. */
export const PHOTO_MIN_SIDE = 480;
export const PHOTO_MAX_SIDE = 20_000;
/** Decompression-bomb guard, mirrored by the worker's Pillow limit. */
export const PHOTO_MAX_PIXELS = 200_000_000;

export type PhotoProblem =
  | 'capture_photos_too_few'
  | 'capture_photos_too_many'
  | 'capture_photo_invalid'
  | 'capture_photo_size_invalid';

export interface PhotoFacts {
  count: number;
  totalBytes: number;
  formats: Record<string, number>;
  minLongSide: number;
  maxLongSide: number;
  /** Photos whose EXIF orientation is not "normal"; the worker rotates their pixels. */
  exifOrientedCount: number;
}

export interface PhotoInspection {
  ok: boolean;
  code?: PhotoProblem;
  message?: string;
  photos?: PhotoFacts;
  /** Capture-relative paths found, for diagnostics. */
  found: string[];
}

const PHOTO_PATTERN = new RegExp(`\\.(${PHOTO_EXTENSIONS.join('|')})$`, 'i');

/** Capture-relative `photos/<name>` entries that look like images, sorted. Symbolic links and sub-directories are not listed. */
export async function listPhotoSources(directory: string): Promise<string[]> {
  let entries: import('node:fs').Dirent[];
  try {
    entries = await fs.readdir(path.join(directory, 'photos'), { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((entry) => (entry.isFile() || entry.isSymbolicLink()) && PHOTO_PATTERN.test(entry.name))
    .map((entry) => `photos/${entry.name}`)
    .sort((a, b) => a.localeCompare(b, 'en', { numeric: true }));
}

async function readAt(handle: FileHandle, position: number, length: number): Promise<Buffer> {
  const buffer = Buffer.alloc(length);
  const { bytesRead } = await handle.read(buffer, 0, length, position);
  return bytesRead === length ? buffer : buffer.subarray(0, bytesRead);
}

export interface ImageHeader {
  format: 'jpg' | 'png';
  width: number;
  height: number;
  /** EXIF orientation 1-8 when the file states one. */
  orientation?: number;
}

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** Orientation tag (0x0112) from the TIFF block of an Exif APP1 segment. */
function exifOrientation(tiff: Buffer): number | undefined {
  if (tiff.length < 8) return undefined;
  const order = tiff.toString('latin1', 0, 2);
  const little = order === 'II';
  if (!little && order !== 'MM') return undefined;
  const u16 = (offset: number) => (little ? tiff.readUInt16LE(offset) : tiff.readUInt16BE(offset));
  const u32 = (offset: number) => (little ? tiff.readUInt32LE(offset) : tiff.readUInt32BE(offset));
  if (u16(2) !== 42) return undefined;
  const ifd = u32(4);
  if (ifd < 8 || ifd + 2 > tiff.length) return undefined;
  const entries = Math.min(u16(ifd), 256);
  for (let index = 0; index < entries; index += 1) {
    const at = ifd + 2 + index * 12;
    if (at + 12 > tiff.length) return undefined;
    if (u16(at) === 0x0112) {
      const value = u16(at + 8);
      return value >= 1 && value <= 8 ? value : undefined;
    }
  }
  return undefined;
}

/**
 * Reads the size (and for JPEG the EXIF orientation) from a file's header.
 * Returns `null` when the bytes are not a well-formed JPEG or PNG header.
 */
export async function readImageHeader(handle: FileHandle, size: number): Promise<ImageHeader | null> {
  const head = await readAt(handle, 0, 32);
  if (head.length >= 24 && head.subarray(0, 8).equals(PNG_SIGNATURE)) {
    if (head.toString('latin1', 12, 16) !== 'IHDR') return null;
    return { format: 'png', width: head.readUInt32BE(16), height: head.readUInt32BE(20) };
  }
  if (head.length < 4 || head[0] !== 0xff || head[1] !== 0xd8 || head[2] !== 0xff) return null;
  let position = 2;
  let orientation: number | undefined;
  for (let index = 0; index < 256 && position + 4 <= size; index += 1) {
    const marker = await readAt(handle, position, 4);
    if (marker.length < 4 || marker[0] !== 0xff) return null;
    const type = marker[1]!;
    if (type === 0xff) { position += 1; continue; } // fill byte
    if (type === 0xd8 || (type >= 0xd0 && type <= 0xd7) || type === 0x01) { position += 2; continue; }
    const length = marker.readUInt16BE(2);
    if (length < 2) return null;
    // Start-of-frame segments (not DHT 0xC4, JPG 0xC8, DAC 0xCC) state the size.
    if (type >= 0xc0 && type <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(type)) {
      const frame = await readAt(handle, position + 4, 5);
      if (frame.length < 5) return null;
      return { format: 'jpg', height: frame.readUInt16BE(1), width: frame.readUInt16BE(3), orientation };
    }
    if (type === 0xe1 && orientation === undefined && length > 14) {
      const body = await readAt(handle, position + 4, Math.min(length - 2, 64 * 1024));
      if (body.toString('latin1', 0, 6) === 'Exif\0\0') orientation = exifOrientation(body.subarray(6));
    }
    if (type === 0xda) return null; // start of scan before any frame header
    position += 2 + length;
  }
  return null;
}

/** True when the file ends the way a complete JPEG or PNG does (a cut-off upload does not). */
async function hasCompleteTail(handle: FileHandle, size: number, format: 'jpg' | 'png'): Promise<boolean> {
  const length = Math.min(size, 64);
  const tail = await readAt(handle, size - length, length);
  if (format === 'png') return tail.length >= 12 && tail.toString('latin1', tail.length - 8, tail.length - 4) === 'IEND';
  // JPEG: EOI, possibly followed by padding zeros.
  let end = tail.length;
  while (end > 0 && tail[end - 1] === 0) end -= 1;
  return end >= 2 && tail[end - 2] === 0xff && tail[end - 1] === 0xd9;
}

const invalid = (code: PhotoProblem, message: string, found: string[]): PhotoInspection => ({ ok: false, code, message, found });

/** Validates every photo of a capture directory. Reads headers only, never whole files. */
export async function inspectPhotoPackage(directory: string): Promise<PhotoInspection> {
  const found = await listPhotoSources(directory);
  if (found.length < PHOTO_MIN_COUNT) {
    return invalid('capture_photos_too_few', `A photo capture needs at least ${PHOTO_MIN_COUNT} photos; found ${found.length}`, found);
  }
  if (found.length > PHOTO_MAX_COUNT) {
    return invalid('capture_photos_too_many', `A photo capture holds at most ${PHOTO_MAX_COUNT} photos; found ${found.length}`, found);
  }
  const facts: PhotoFacts = { count: found.length, totalBytes: 0, formats: {}, minLongSide: Infinity, maxLongSide: 0, exifOrientedCount: 0 };
  for (const relative of found) {
    let handle: FileHandle | undefined;
    try {
      const absolute = path.join(directory, relative);
      // A link could point anywhere on the Node's disk; a capture only ever holds regular files.
      if ((await fs.lstat(absolute)).isSymbolicLink()) {
        return invalid('capture_photo_invalid', 'A photo is a symbolic link; only regular files are accepted', found);
      }
      handle = await fs.open(absolute, 'r');
      const { size } = await handle.stat();
      if (size < PHOTO_MIN_BYTES || size > PHOTO_MAX_BYTES) {
        return invalid('capture_photo_size_invalid', size < PHOTO_MIN_BYTES
          ? 'A photo file is too small to contain a usable image'
          : `A photo file exceeds the ${Math.round(PHOTO_MAX_BYTES / 2 ** 20)} MiB limit`, found);
      }
      const header = await readImageHeader(handle, size);
      const extension = path.extname(relative).slice(1).toLowerCase();
      const expected = extension === 'png' ? 'png' : 'jpg';
      if (!header || header.format !== expected) {
        return invalid('capture_photo_invalid', `A photo is not a valid .${extension} image`, found);
      }
      if (!(await hasCompleteTail(handle, size, header.format))) {
        return invalid('capture_photo_invalid', 'A photo file is truncated; the upload may be incomplete', found);
      }
      const short = Math.min(header.width, header.height);
      const long = Math.max(header.width, header.height);
      if (short < PHOTO_MIN_SIDE || long > PHOTO_MAX_SIDE || header.width * header.height > PHOTO_MAX_PIXELS) {
        return invalid('capture_photo_invalid', `A photo is ${header.width}x${header.height}; sides must be ${PHOTO_MIN_SIDE}-${PHOTO_MAX_SIDE} px and at most ${PHOTO_MAX_PIXELS / 1e6} MP`, found);
      }
      facts.totalBytes += size;
      facts.formats[header.format] = (facts.formats[header.format] ?? 0) + 1;
      facts.minLongSide = Math.min(facts.minLongSide, long);
      facts.maxLongSide = Math.max(facts.maxLongSide, long);
      if (header.orientation !== undefined && header.orientation !== 1) facts.exifOrientedCount += 1;
    } catch {
      return invalid('capture_photo_invalid', 'A photo file could not be read', found);
    } finally {
      await handle?.close().catch(() => undefined);
    }
  }
  return { ok: true, photos: facts, found };
}
