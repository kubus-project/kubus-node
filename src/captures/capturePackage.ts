import { promises as fs } from 'node:fs';
import path from 'node:path';
import { inspectPhotoPackage, listPhotoSources, type PhotoFacts, type PhotoProblem } from './photoPackage.js';
import { inspectVideoPackage, listVideoSources, type VideoFacts, type VideoProblem } from './videoPackage.js';

/**
 * Integrity contract for a `kubus.capture/1` package on disk.
 *
 * The Node is the boundary between a phone it does not control and GPU work
 * that costs real time. A transfer that lost files must be discovered here —
 * before a capture is promoted to `stored` and before a reconstruction job is
 * queued — not by the Nerfstudio adapter failing with `ENOENT` on the first
 * `copyFile`. The adapter stays defensive, but it must no longer normally be
 * the first component to learn that a transfer was incomplete.
 */

/** Machine-readable reasons a capture package is not usable. */
export type CapturePackageProblem =
  | 'capture_package_incomplete'
  | 'capture_frames_missing'
  | 'capture_frames_invalid'
  | 'capture_frame_file_missing'
  | VideoProblem
  | PhotoProblem;

/**
 * What a capture package carries: posed frames, one source video, still photos
 * (no poses; COLMAP solves them), or photos and one video together.
 */
export type CapturePackageKind = 'frames' | 'video' | 'photos' | 'mixed' | 'prepared';

export interface CapturePackageReport {
  ok: boolean;
  code?: CapturePackageProblem;
  /** Operator-facing summary. Never contains an absolute filesystem path. */
  message?: string;
  /**
   * Capture-relative paths the package references but the directory lacks,
   * truncated to [MISSING_PATH_LIMIT]. `missingCount` is the true total.
   */
  missingPaths: string[];
  missingCount: number;
  /** Frames declared by `frames.json`, or 0 when it could not be read. */
  frameCount: number;
  /** Which package shape was recognised, when one could be. */
  kind?: CapturePackageKind;
  /** Facts about the source video, for a `video` or `mixed` package. */
  video?: VideoFacts;
  /** Facts about the photo set, for a `photos` or `mixed` package. */
  photos?: PhotoFacts;
}

/** Enough for a phone to show and repair, bounded so an error stays small. */
const MISSING_PATH_LIMIT = 50;

/** Matches the store's per-capture file ceiling: one image per frame at least. */
const MAX_FRAMES = 5000;

/** A non-null, non-array object — the only shape any capture document may take. */
export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Normalizes a capture-relative path and refuses anything that would escape.
 *
 * Mirrors `safeRelativePath` in the store, but answers with `null` instead of
 * throwing: a traversal path inside `frames.json` is a validation finding
 * about untrusted client data, not an internal error.
 */
export function captureRelativePath(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const normalized = raw.replaceAll('\\', '/').replace(/^\/+/, '');
  if (!normalized || normalized.includes('..') || path.isAbsolute(normalized)) return null;
  return normalized;
}

/** True when `relative` names an existing, non-empty regular file. */
async function hasContent(directory: string, relative: string): Promise<boolean> {
  try {
    const stat = await fs.stat(path.join(directory, relative));
    return stat.isFile() && stat.size > 0;
  } catch {
    return false;
  }
}

function report(
  code: CapturePackageProblem,
  message: string,
  missing: string[] = [],
  frameCount = 0,
): CapturePackageReport {
  return {
    ok: false,
    code,
    message,
    missingPaths: missing.slice(0, MISSING_PATH_LIMIT),
    missingCount: missing.length,
    frameCount,
  };
}

export interface InspectCapturePackageOptions {
  /**
   * Paths the transfer accounted for. Checked against the directory so a
   * package whose files were removed after upload cannot pass on accounting
   * alone.
   */
  declaredPaths?: Iterable<string>;
  /** `metadata.frameCount`, when the client stated one. */
  expectedFrameCount?: number;
}

/**
 * Reads a capture directory and decides whether it is a complete package.
 *
 * Every referenced file is checked against the filesystem: accounting held in
 * memory by the process that received the upload proves only what arrived,
 * not what is still there.
 */
export async function inspectCapturePackage(
  directory: string,
  options: InspectCapturePackageOptions = {},
): Promise<CapturePackageReport> {
  const declared = [...(options.declaredPaths ?? [])];
  const missingDeclared: string[] = [];
  for (const relative of declared) {
    const safe = captureRelativePath(relative);
    if (!safe) return report('capture_frames_invalid', 'A declared file path escapes the capture directory');
    if (!(await hasContent(directory, safe))) missingDeclared.push(safe);
  }
  if (missingDeclared.length > 0) {
    return report(
      'capture_package_incomplete',
      `${missingDeclared.length} uploaded ${missingDeclared.length === 1 ? 'file is' : 'files are'} no longer present in the capture`,
      missingDeclared,
    );
  }

  let raw: string;
  try {
    raw = await fs.readFile(path.join(directory, 'frames.json'), 'utf8');
  } catch {
    // No frames.json: a capture that carries still photos and/or one source
    // video instead is a `photos`, `video` or `mixed` package. Anything else
    // keeps the original answer.
    const hasPhotos = (await listPhotoSources(directory)).length > 0;
    const hasVideo = (await listVideoSources(directory)).length > 0;
    if (hasPhotos || hasVideo) return inspectMedia(directory, hasPhotos, hasVideo);
    if (await hasContent(directory, 'dataset/prepared.json')) return inspectPrepared(directory);
    return report('capture_frames_missing', 'The capture has no frames.json', ['frames.json']);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return report('capture_frames_invalid', 'frames.json is not valid JSON');
  }

  // Everything below reads client data. `null`, an array or a bare string is
  // valid JSON and must be a finding, not a TypeError surfacing as a 500.
  if (!isPlainObject(parsed)) {
    return report('capture_frames_invalid', 'frames.json is not a JSON object');
  }
  if (typeof parsed.schema !== 'string' || parsed.schema !== 'kubus.capture.frames/1') {
    return report('capture_frames_invalid', 'frames.json does not declare schema kubus.capture.frames/1');
  }
  if (!Array.isArray(parsed.frames) || parsed.frames.length === 0) {
    return report('capture_frames_invalid', 'frames.json declares no frames');
  }
  // Every frame needs its own image file, so a document declaring more frames
  // than a capture may hold files is wrong without looking further — and is
  // refused before it can cost one filesystem stat per entry.
  if (parsed.frames.length > MAX_FRAMES) {
    return report('capture_frames_invalid', `frames.json declares more than ${MAX_FRAMES} frames`);
  }

  const frames: unknown[] = parsed.frames;
  const missingFrameFiles: string[] = [];
  for (const [index, frame] of frames.entries()) {
    if (!isPlainObject(frame)) {
      return report('capture_frames_invalid', `Frame ${index} is not a JSON object`, [], frames.length);
    }
    // The RGB image is the one file every frame must carry: a frame without
    // it cannot contribute to a reconstruction at all.
    const rgb = captureRelativePath(frame.rgbPath);
    if (!rgb) return report('capture_frames_invalid', 'A frame has no usable rgbPath', [], frames.length);
    if (!(await hasContent(directory, rgb))) missingFrameFiles.push(rgb);

    // Depth and confidence are optional, but a frame that *declares* one has
    // promised it: a silently absent file would degrade the reconstruction
    // with no record of why.
    for (const key of ['depthPath', 'depthConfidencePath'] as const) {
      if (frame[key] === undefined || frame[key] === null) continue;
      const optional = captureRelativePath(frame[key]);
      if (!optional) return report('capture_frames_invalid', `A frame has an unusable ${key}`, [], frames.length);
      if (!(await hasContent(directory, optional))) missingFrameFiles.push(optional);
    }
  }

  if (missingFrameFiles.length > 0) {
    return report(
      'capture_frame_file_missing',
      `frames.json references ${missingFrameFiles.length} ${missingFrameFiles.length === 1 ? 'file' : 'files'} the capture does not contain`,
      missingFrameFiles,
      frames.length,
    );
  }

  // Only assert a count the client actually stated. Inventing one would fail
  // captures that legitimately dropped untracked frames before upload.
  const expected = options.expectedFrameCount;
  if (typeof expected === 'number' && Number.isInteger(expected) && expected > 0 && expected !== frames.length) {
    return report(
      'capture_frames_invalid',
      `The capture declares ${expected} frames but frames.json contains ${frames.length}`,
      [],
      frames.length,
    );
  }

  return { ok: true, missingPaths: [], missingCount: 0, frameCount: frames.length, kind: 'frames' };
}

/**
 * A `prepared` package is a masked, posed Nerfstudio dataset that a managed requester's worker made from a browser
 * source set (`dataset/transforms.json`, `dataset/images/*`, `dataset/prepared.json`). It holds no raw photo or
 * video, so it is the only media-derived package a remote provider may receive. Every referenced image must be a
 * file inside `dataset/`.
 */
async function inspectPrepared(directory: string): Promise<CapturePackageReport> {
  const fail = (message: string, missing: string[] = []) => ({ ...report(missing.length ? 'capture_frame_file_missing' : 'capture_frames_invalid', message, missing), kind: 'prepared' as const });
  let record: unknown;
  let transforms: unknown;
  try {
    record = JSON.parse(await fs.readFile(path.join(directory, 'dataset', 'prepared.json'), 'utf8'));
    transforms = JSON.parse(await fs.readFile(path.join(directory, 'dataset', 'transforms.json'), 'utf8'));
  } catch {
    return fail('The prepared dataset has no readable prepared.json and transforms.json');
  }
  if (!isPlainObject(record) || record.schema !== 'kubus.prepared-dataset/1') return fail('prepared.json does not declare kubus.prepared-dataset/1');
  if (!isPlainObject(transforms) || !Array.isArray(transforms.frames) || transforms.frames.length === 0) return fail('transforms.json declares no frames');
  if (transforms.frames.length > MAX_FRAMES) return fail(`transforms.json declares more than ${MAX_FRAMES} frames`);
  const missing: string[] = [];
  for (const frame of transforms.frames) {
    const relative = isPlainObject(frame) ? captureRelativePath(String(frame.file_path ?? '').replace(/^\.\//, '')) : null;
    if (!relative || !relative.startsWith('images/')) return fail('A prepared frame path is not under images/');
    if (!(await hasContent(path.join(directory, 'dataset'), relative))) missing.push(`dataset/${relative}`);
  }
  if (missing.length) return fail(`${missing.length} prepared images are missing`, missing);
  return { ok: true, missingPaths: [], missingCount: 0, frameCount: transforms.frames.length, kind: 'prepared' };
}

async function inspectMedia(directory: string, hasPhotos: boolean, hasVideo: boolean): Promise<CapturePackageReport> {
  const kind: CapturePackageKind = hasPhotos && hasVideo ? 'mixed' : hasPhotos ? 'photos' : 'video';
  let photos: PhotoFacts | undefined;
  if (hasPhotos) {
    const result = await inspectPhotoPackage(directory);
    if (!result.ok) return { ...report(result.code!, result.message!, [], 0), kind };
    photos = result.photos;
  }
  let video: VideoFacts | undefined;
  if (hasVideo) {
    const result = await inspectVideoPackage(directory);
    if (!result.ok) return { ...report(result.code!, result.message!, [], 0), kind, video: result.video, ...(photos ? { photos } : {}) };
    video = result.video;
  }
  return { ok: true, missingPaths: [], missingCount: 0, frameCount: 0, kind, ...(video ? { video } : {}), ...(photos ? { photos } : {}) };
}

/** `metadata.frameCount`, when the client stated a usable one. */
export function declaredFrameCount(payload: { metadata?: Record<string, unknown> }): number | undefined {
  const raw = payload.metadata?.frameCount;
  return typeof raw === 'number' && Number.isInteger(raw) && raw > 0 ? raw : undefined;
}
