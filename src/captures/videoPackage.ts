import { promises as fs } from 'node:fs';
import type { FileHandle } from 'node:fs/promises';
import path from 'node:path';

/**
 * Integrity checks for a `video` capture package: one video file at
 * `video/source.<ext>` and no `frames.json`.
 *
 * The Node image carries no ffmpeg, so this is the cheap, container-level
 * part of "is it a video": size bounds, the container signature, and for the
 * MP4 family a real read of the movie header (`moov`/`mvhd`), which both proves
 * the upload was not truncated (a cut-off phone recording has no `moov`) and
 * yields the duration. The worker re-checks everything with ffprobe/ffmpeg and
 * is authoritative for decodability.
 */

export const VIDEO_EXTENSIONS = ['mp4', 'mov', 'm4v', 'webm', 'mkv'] as const;
export type VideoExtension = typeof VIDEO_EXTENSIONS[number];

/** Smaller than this cannot hold seconds of orbit footage. */
export const VIDEO_MIN_BYTES = 64 * 1024;
/** One video must fit comfortably inside the 5 GiB per-capture ceiling. */
export const VIDEO_MAX_BYTES = 4 * 1024 * 1024 * 1024;
/** Mirrors `KUBUS_VIDEO_MIN_SECONDS` / `KUBUS_VIDEO_MAX_SECONDS` in the worker. */
export const VIDEO_MIN_SECONDS = 3;
export const VIDEO_MAX_SECONDS = 20 * 60;

export type VideoProblem =
  | 'capture_video_multiple'
  | 'capture_video_size_invalid'
  | 'capture_video_unreadable'
  | 'capture_video_too_short'
  | 'capture_video_too_long';

export interface VideoFacts {
  extension: VideoExtension;
  /** Capture-relative path of the video file. */
  path: string;
  sizeBytes: number;
  /** Seconds, when the container header states one (MP4 family only). */
  durationSeconds?: number;
}

export interface VideoInspection {
  ok: boolean;
  code?: VideoProblem;
  message?: string;
  video?: VideoFacts;
  /** Paths found, for diagnostics. */
  found: string[];
}

const SOURCE_PATTERN = new RegExp(`^source\\.(${VIDEO_EXTENSIONS.join('|')})$`, 'i');

/** Names under `video/` that look like the capture's source video. */
export async function listVideoSources(directory: string): Promise<string[]> {
  let entries: string[];
  try {
    entries = await fs.readdir(path.join(directory, 'video'));
  } catch {
    return [];
  }
  return entries.filter((name) => SOURCE_PATTERN.test(name)).sort().map((name) => `video/${name}`);
}

async function readAt(handle: FileHandle, position: number, length: number): Promise<Buffer> {
  const buffer = Buffer.alloc(length);
  const { bytesRead } = await handle.read(buffer, 0, length, position);
  return bytesRead === length ? buffer : buffer.subarray(0, bytesRead);
}

interface Box { type: string; start: number; size: number; header: number }

async function readBox(handle: FileHandle, position: number, limit: number): Promise<Box | null> {
  if (position + 8 > limit) return null;
  const header = await readAt(handle, position, 16);
  if (header.length < 8) return null;
  let size = header.readUInt32BE(0);
  const type = header.toString('latin1', 4, 8);
  let headerSize = 8;
  if (size === 1) {
    if (header.length < 16) return null;
    size = Number(header.readBigUInt64BE(8));
    headerSize = 16;
  } else if (size === 0) {
    size = limit - position;
  }
  if (size < headerSize || position + size > limit) return null;
  return { type, start: position, size, header: headerSize };
}

/**
 * Reads `moov/mvhd` and returns the duration in seconds, `0` when the header
 * states none (fragmented MP4 keeps it elsewhere), or `null` when no `moov` box
 * is present or readable - the signature of a truncated upload.
 */
export async function readMp4Duration(handle: FileHandle, fileSize: number): Promise<number | null> {
  let position = 0;
  for (let index = 0; index < 10_000 && position < fileSize; index += 1) {
    const box = await readBox(handle, position, fileSize);
    if (!box) return null;
    if (box.type === 'moov') return readMvhd(handle, box);
    position += box.size;
  }
  return null;
}

async function readMvhd(handle: FileHandle, moov: Box): Promise<number | null> {
  const end = moov.start + moov.size;
  let position = moov.start + moov.header;
  for (let index = 0; index < 1000 && position < end; index += 1) {
    const box = await readBox(handle, position, end);
    if (!box) return null;
    if (box.type === 'mvhd') {
      const body = await readAt(handle, box.start + box.header, 32);
      if (body.length < 20) return null;
      const version = body.readUInt8(0);
      let timescale: number;
      let duration: number;
      if (version === 1) {
        if (body.length < 32) return null;
        timescale = body.readUInt32BE(20);
        duration = Number(body.readBigUInt64BE(24));
      } else {
        timescale = body.readUInt32BE(12);
        duration = body.readUInt32BE(16);
      }
      if (!timescale) return null;
      return duration / timescale;
    }
    position += box.size;
  }
  return null;
}

function signatureMatches(extension: string, head: Buffer): boolean {
  if (['mp4', 'mov', 'm4v'].includes(extension)) {
    // `ftyp` normally leads; older QuickTime files may start with `moov`/`mdat`/`wide`/`free`.
    return ['ftyp', 'moov', 'mdat', 'wide', 'free', 'skip'].includes(head.toString('latin1', 4, 8));
  }
  // EBML header shared by WebM and Matroska.
  return head.length >= 4 && head.readUInt32BE(0) === 0x1a45dfa3;
}

export async function inspectVideoPackage(directory: string): Promise<VideoInspection> {
  const found = await listVideoSources(directory);
  if (found.length > 1) {
    return { ok: false, code: 'capture_video_multiple', message: 'A video capture holds exactly one video; found more than one', found };
  }
  if (found.length === 0) return { ok: false, code: 'capture_video_unreadable', message: 'The capture has no video/source file', found };
  const relative = found[0]!;
  const extension = path.extname(relative).slice(1).toLowerCase() as VideoExtension;
  let handle: FileHandle | undefined;
  try {
    handle = await fs.open(path.join(directory, relative), 'r');
    const { size } = await handle.stat();
    if (size < VIDEO_MIN_BYTES || size > VIDEO_MAX_BYTES) {
      return {
        ok: false,
        code: 'capture_video_size_invalid',
        message: size < VIDEO_MIN_BYTES
          ? 'The video file is too small to contain usable footage'
          : `The video file exceeds the ${Math.round(VIDEO_MAX_BYTES / 2 ** 30)} GiB limit`,
        found,
      };
    }
    const head = await readAt(handle, 0, 16);
    if (!signatureMatches(extension, head)) {
      return { ok: false, code: 'capture_video_unreadable', message: `The file is not a valid .${extension} container`, found };
    }
    const facts: VideoFacts = { extension, path: relative, sizeBytes: size };
    if (['mp4', 'mov', 'm4v'].includes(extension)) {
      const duration = await readMp4Duration(handle, size);
      if (duration === null) {
        return { ok: false, code: 'capture_video_unreadable', message: 'The video has no readable movie header; the upload may be incomplete', found };
      }
      if (duration > 0) {
        facts.durationSeconds = Math.round(duration * 1000) / 1000;
        if (duration < VIDEO_MIN_SECONDS) {
          return { ok: false, code: 'capture_video_too_short', message: `The video is ${duration.toFixed(1)} s; at least ${VIDEO_MIN_SECONDS} s is required`, video: facts, found };
        }
        if (duration > VIDEO_MAX_SECONDS) {
          return { ok: false, code: 'capture_video_too_long', message: `The video is ${Math.round(duration)} s; the limit is ${VIDEO_MAX_SECONDS} s`, video: facts, found };
        }
      }
    }
    return { ok: true, video: facts, found };
  } catch {
    return { ok: false, code: 'capture_video_unreadable', message: 'The video file could not be read', found };
  } finally {
    await handle?.close().catch(() => undefined);
  }
}
