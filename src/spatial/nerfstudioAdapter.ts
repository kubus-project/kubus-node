import { promises as fs } from 'node:fs';
import path from 'node:path';
import { arCorePoseToCameraToWorldMatrix, poseFromFramePayload, type ArCorePose } from './poseConversion.js';

/**
 * Adapts a `kubus.capture/1` directory (the canonical, engine-neutral mobile
 * capture format - RGB + tracked pose + intrinsics, produced by the phone)
 * into a Nerfstudio-compatible dataset (`transforms.json` + `images/`)
 * materialized under a job-private workspace.
 *
 * The phone must never know Nerfstudio exists: `frames.json` carries
 * `poseTranslation`/`poseRotation`/`intrinsics` in the phone's own native
 * (ARCore) convention, and this module is the one place that understands
 * both that format and the engine's. Ownership rationale: the kubus Node
 * agent already understands `kubus.capture/1` end to end (capture storage,
 * streaming upload); the worker only needs to understand Nerfstudio. Doing
 * the translation here, once, keeps the worker a thin `ns-train` wrapper and
 * keeps the capture format free to add other engines later without touching
 * the phone.
 *
 * Never mutates the source capture: everything lands under a separate
 * dataset directory so the raw capture stays byte-for-byte as uploaded.
 */

/** Same floor the phone enforces before it lets a capture finish (`minSamplesForFinish` in `spatial_capture_policy.dart`). */
export const MIN_VIEWS_FOR_RECONSTRUCTION = 24;

export type CaptureAdapterErrorCode =
  | 'capture_dataset_invalid'
  | 'capture_pose_missing'
  | 'capture_intrinsics_missing'
  | 'capture_insufficient_views';

export class CaptureAdapterError extends Error {
  readonly code: CaptureAdapterErrorCode;
  constructor(code: CaptureAdapterErrorCode, message: string) {
    super(message);
    this.code = code;
    this.name = 'CaptureAdapterError';
  }
}

interface RawIntrinsics {
  width?: unknown;
  height?: unknown;
  fx?: unknown;
  fy?: unknown;
  cx?: unknown;
  cy?: unknown;
}

interface ValidatedFrame {
  originalIndex: number;
  rgbAbsolutePath: string;
  pose: ArCorePose;
  intrinsics: { width: number; height: number; fx: number; fy: number; cx: number; cy: number };
}

export interface DatasetBuildResult {
  frameCount: number;
  droppedFrameCount: number;
  datasetDirectory: string;
  transformsPath: string;
  sharedIntrinsics: boolean;
}

function isPositiveFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

function isValidIntrinsics(raw: unknown): raw is Required<RawIntrinsics> & { width: number; height: number; fx: number; fy: number; cx: number; cy: number } {
  if (!raw || typeof raw !== 'object') return false;
  const candidate = raw as RawIntrinsics;
  return (
    isPositiveFiniteNumber(candidate.width) &&
    isPositiveFiniteNumber(candidate.height) &&
    isPositiveFiniteNumber(candidate.fx) &&
    isPositiveFiniteNumber(candidate.fy) &&
    typeof candidate.cx === 'number' && Number.isFinite(candidate.cx) &&
    typeof candidate.cy === 'number' && Number.isFinite(candidate.cy)
  );
}

async function readFramesDocument(captureDirectory: string): Promise<{ frames: Array<Record<string, unknown>> }> {
  const framesPath = path.join(captureDirectory, 'frames.json');
  let raw: string;
  try {
    raw = await fs.readFile(framesPath, 'utf8');
  } catch {
    throw new CaptureAdapterError('capture_dataset_invalid', `Capture is missing ${framesPath}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new CaptureAdapterError('capture_dataset_invalid', 'frames.json is not valid JSON');
  }
  const document = parsed as { schema?: unknown; frames?: unknown };
  if (document.schema !== 'kubus.capture.frames/1' || !Array.isArray(document.frames) || document.frames.length === 0) {
    throw new CaptureAdapterError('capture_dataset_invalid', 'frames.json does not match schema kubus.capture.frames/1');
  }
  return { frames: document.frames as Array<Record<string, unknown>> };
}

function sameIntrinsics(
  a: { width: number; height: number; fx: number; fy: number; cx: number; cy: number },
  b: { width: number; height: number; fx: number; fy: number; cx: number; cy: number },
): boolean {
  const epsilon = 1e-6;
  return (
    a.width === b.width &&
    a.height === b.height &&
    Math.abs(a.fx - b.fx) < epsilon &&
    Math.abs(a.fy - b.fy) < epsilon &&
    Math.abs(a.cx - b.cx) < epsilon &&
    Math.abs(a.cy - b.cy) < epsilon
  );
}

/**
 * Validates every frame, separating usable frames from ones a single
 * corrupt/partial upload dropped. A minority of unusable frames does not
 * fail the whole capture; unusable-across-the-board does, with the specific
 * missing field named so the operator (and eventually the phone user) sees
 * why, instead of a generic "processing failed".
 */
function validateFrames(captureDirectory: string, frames: Array<Record<string, unknown>>): {
  valid: ValidatedFrame[];
  droppedCount: number;
} {
  const valid: ValidatedFrame[] = [];
  let missingPoseCount = 0;
  let missingIntrinsicsCount = 0;
  let missingRgbCount = 0;

  frames.forEach((frame, index) => {
    const pose = poseFromFramePayload(frame);
    if (!pose) {
      missingPoseCount += 1;
      return;
    }
    const intrinsicsRaw = frame.intrinsics;
    if (!isValidIntrinsics(intrinsicsRaw)) {
      missingIntrinsicsCount += 1;
      return;
    }
    const rgbPath = frame.rgbPath;
    if (typeof rgbPath !== 'string' || rgbPath.length === 0) {
      missingRgbCount += 1;
      return;
    }
    const rgbAbsolutePath = path.resolve(captureDirectory, rgbPath);
    if (!rgbAbsolutePath.startsWith(`${path.resolve(captureDirectory)}${path.sep}`)) {
      missingRgbCount += 1;
      return;
    }
    valid.push({
      originalIndex: typeof frame.index === 'number' ? frame.index : index,
      rgbAbsolutePath,
      pose,
      intrinsics: {
        width: intrinsicsRaw.width,
        height: intrinsicsRaw.height,
        fx: intrinsicsRaw.fx,
        fy: intrinsicsRaw.fy,
        cx: intrinsicsRaw.cx,
        cy: intrinsicsRaw.cy,
      },
    });
  });

  const droppedCount = missingPoseCount + missingIntrinsicsCount + missingRgbCount;
  if (valid.length === 0) {
    if (missingPoseCount === frames.length) {
      throw new CaptureAdapterError('capture_pose_missing', 'No frame in this capture has a usable tracked pose');
    }
    if (missingIntrinsicsCount === frames.length) {
      throw new CaptureAdapterError('capture_intrinsics_missing', 'No frame in this capture has usable camera intrinsics');
    }
    throw new CaptureAdapterError('capture_dataset_invalid', 'No frame in this capture has a usable pose, intrinsics, and image');
  }
  return { valid, droppedCount };
}

/**
 * Reads a `kubus.capture/1` directory's `frames.json` and materializes a
 * Nerfstudio-ready dataset (`transforms.json` + copied `images/`) under
 * `datasetDirectory`. Never touches `captureDirectory`.
 */
export async function buildNerfstudioDataset(
  captureDirectory: string,
  datasetDirectory: string,
): Promise<DatasetBuildResult> {
  const { frames } = await readFramesDocument(captureDirectory);
  const { valid, droppedCount } = validateFrames(captureDirectory, frames);
  if (valid.length < MIN_VIEWS_FOR_RECONSTRUCTION) {
    throw new CaptureAdapterError(
      'capture_insufficient_views',
      `Capture has ${valid.length} usable view(s); at least ${MIN_VIEWS_FOR_RECONSTRUCTION} are required for reconstruction`,
    );
  }

  const imagesDirectory = path.join(datasetDirectory, 'images');
  await fs.mkdir(imagesDirectory, { recursive: true, mode: 0o700 });

  const firstFrame = valid[0];
  if (!firstFrame) throw new CaptureAdapterError('capture_dataset_invalid', 'No usable frames survived validation');
  const sharedIntrinsics = valid.every((frame) => sameIntrinsics(frame.intrinsics, firstFrame.intrinsics));

  const frameEntries: Array<Record<string, unknown>> = [];
  for (const frame of valid) {
    const fileName = `frame_${String(frame.originalIndex).padStart(5, '0')}.jpg`;
    const target = path.join(imagesDirectory, fileName);
    await fs.copyFile(frame.rgbAbsolutePath, target);
    const transformMatrix = arCorePoseToCameraToWorldMatrix(frame.pose);
    const entry: Record<string, unknown> = {
      file_path: `images/${fileName}`,
      transform_matrix: transformMatrix,
    };
    if (!sharedIntrinsics) {
      entry.w = frame.intrinsics.width;
      entry.h = frame.intrinsics.height;
      entry.fl_x = frame.intrinsics.fx;
      entry.fl_y = frame.intrinsics.fy;
      entry.cx = frame.intrinsics.cx;
      entry.cy = frame.intrinsics.cy;
    }
    frameEntries.push(entry);
  }

  const transforms: Record<string, unknown> = {
    camera_model: 'PINHOLE',
    ...(sharedIntrinsics
      ? {
          w: firstFrame.intrinsics.width,
          h: firstFrame.intrinsics.height,
          fl_x: firstFrame.intrinsics.fx,
          fl_y: firstFrame.intrinsics.fy,
          cx: firstFrame.intrinsics.cx,
          cy: firstFrame.intrinsics.cy,
        }
      : {}),
    frames: frameEntries,
  };

  const transformsPath = path.join(datasetDirectory, 'transforms.json');
  await fs.writeFile(transformsPath, `${JSON.stringify(transforms, null, 2)}\n`, { mode: 0o600 });

  return {
    frameCount: valid.length,
    droppedFrameCount: droppedCount,
    datasetDirectory,
    transformsPath,
    sharedIntrinsics,
  };
}
