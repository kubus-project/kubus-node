import { promises as fs } from 'node:fs';
import path from 'node:path';

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
  | 'capture_frame_file_missing';

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
}

/** Enough for a phone to show and repair, bounded so an error stays small. */
const MISSING_PATH_LIMIT = 50;

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
    return report('capture_frames_missing', 'The capture has no frames.json', ['frames.json']);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return report('capture_frames_invalid', 'frames.json is not valid JSON');
  }

  const document = parsed as { schema?: unknown; frames?: unknown };
  if (document.schema !== 'kubus.capture.frames/1') {
    return report('capture_frames_invalid', 'frames.json does not declare schema kubus.capture.frames/1');
  }
  if (!Array.isArray(document.frames) || document.frames.length === 0) {
    return report('capture_frames_invalid', 'frames.json declares no frames');
  }

  const frames = document.frames as Array<Record<string, unknown>>;
  const missingFrameFiles: string[] = [];
  for (const frame of frames) {
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

  return { ok: true, missingPaths: [], missingCount: 0, frameCount: frames.length };
}

/** `metadata.frameCount`, when the client stated a usable one. */
export function declaredFrameCount(payload: { metadata?: Record<string, unknown> }): number | undefined {
  const raw = payload.metadata?.frameCount;
  return typeof raw === 'number' && Number.isInteger(raw) && raw > 0 ? raw : undefined;
}
