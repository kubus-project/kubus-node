import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  CaptureAdapterError,
  MIN_VIEWS_FOR_RECONSTRUCTION,
  buildNerfstudioDataset,
} from '../src/spatial/nerfstudioAdapter.js';

const INTRINSICS = { width: 1920, height: 1080, fx: 1400.5, fy: 1400.5, cx: 960, cy: 540 };

function frame(index: number, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    index,
    rgbPath: `rgb/${String(index).padStart(5, '0')}.jpg`,
    poseTranslation: [index * 0.1, 0, 0],
    poseRotation: [0, 0, 0, 1],
    intrinsics: INTRINSICS,
    timestampNanos: 1000 + index,
    depthAvailable: false,
    ...overrides,
  };
}

async function writeCapture(
  captureDirectory: string,
  frames: Array<Record<string, unknown>>,
  opts: { skipRgbFor?: number[] } = {},
): Promise<void> {
  await fs.mkdir(path.join(captureDirectory, 'rgb'), { recursive: true });
  for (const f of frames) {
    const rgbPath = f.rgbPath as string | undefined;
    if (!rgbPath || opts.skipRgbFor?.includes(f.index as number)) continue;
    const target = path.join(captureDirectory, rgbPath);
    await fs.mkdir(path.dirname(target), { recursive: true });
    // Minimal content - the adapter copies bytes, it never decodes the image.
    await fs.writeFile(target, Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
  }
  await fs.writeFile(
    path.join(captureDirectory, 'frames.json'),
    JSON.stringify({ schema: 'kubus.capture.frames/1', frames }),
  );
}

function validFrameSet(count: number): Array<Record<string, unknown>> {
  return Array.from({ length: count }, (_, index) => frame(index));
}

describe('buildNerfstudioDataset', () => {
  let root: string;
  let captureDirectory: string;
  let datasetDirectory: string;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'kubus-nerfstudio-adapter-'));
    captureDirectory = path.join(root, 'capture');
    datasetDirectory = path.join(root, 'job', 'dataset');
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it('builds a valid transforms.json and copies every frame image', async () => {
    await writeCapture(captureDirectory, validFrameSet(MIN_VIEWS_FOR_RECONSTRUCTION));

    const result = await buildNerfstudioDataset(captureDirectory, datasetDirectory);

    expect(result.frameCount).toBe(MIN_VIEWS_FOR_RECONSTRUCTION);
    expect(result.droppedFrameCount).toBe(0);
    expect(result.sharedIntrinsics).toBe(true);

    const transforms = JSON.parse(await fs.readFile(result.transformsPath, 'utf8'));
    expect(transforms.camera_model).toBe('PINHOLE');
    expect(transforms.fl_x).toBeCloseTo(INTRINSICS.fx);
    expect(transforms.w).toBe(INTRINSICS.width);
    expect(transforms.frames).toHaveLength(MIN_VIEWS_FOR_RECONSTRUCTION);
    for (const entry of transforms.frames) {
      expect(entry.transform_matrix).toHaveLength(4);
      expect(entry.transform_matrix[3]).toEqual([0, 0, 0, 1]);
      const imagePath = path.join(datasetDirectory, entry.file_path);
      await expect(fs.access(imagePath)).resolves.toBeUndefined();
    }
  });

  it('never writes into the source capture directory', async () => {
    await writeCapture(captureDirectory, validFrameSet(MIN_VIEWS_FOR_RECONSTRUCTION));
    const before = await fs.readdir(captureDirectory);

    await buildNerfstudioDataset(captureDirectory, datasetDirectory);

    const after = await fs.readdir(captureDirectory);
    expect(after).toEqual(before);
  });

  it('emits per-frame intrinsics when they vary across frames', async () => {
    const frames = validFrameSet(MIN_VIEWS_FOR_RECONSTRUCTION);
    frames[0] = frame(0, { intrinsics: { ...INTRINSICS, fx: 1500 } });
    await writeCapture(captureDirectory, frames);

    const result = await buildNerfstudioDataset(captureDirectory, datasetDirectory);
    expect(result.sharedIntrinsics).toBe(false);

    const transforms = JSON.parse(await fs.readFile(result.transformsPath, 'utf8'));
    expect(transforms.fl_x).toBeUndefined();
    expect(transforms.frames[0].fl_x).toBe(1500);
    expect(transforms.frames[1].fl_x).toBeCloseTo(INTRINSICS.fx);
  });

  it('drops a minority of frames with missing pose and still succeeds', async () => {
    const frames = validFrameSet(MIN_VIEWS_FOR_RECONSTRUCTION + 2);
    frames[0] = frame(0, { poseTranslation: undefined, poseRotation: undefined });
    frames[1] = frame(1, { poseRotation: [0, 0, 0] }); // wrong length
    await writeCapture(captureDirectory, frames);

    const result = await buildNerfstudioDataset(captureDirectory, datasetDirectory);
    expect(result.frameCount).toBe(MIN_VIEWS_FOR_RECONSTRUCTION);
    expect(result.droppedFrameCount).toBe(2);
  });

  it('throws capture_pose_missing when every frame lacks a pose', async () => {
    const frames = validFrameSet(MIN_VIEWS_FOR_RECONSTRUCTION).map((f) => frame(f.index as number, { poseTranslation: undefined, poseRotation: undefined }));
    await writeCapture(captureDirectory, frames);

    let error: unknown;
    try {
      await buildNerfstudioDataset(captureDirectory, datasetDirectory);
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(CaptureAdapterError);
    expect((error as CaptureAdapterError).code).toBe('capture_pose_missing');
  });

  it('throws capture_intrinsics_missing when every frame lacks intrinsics', async () => {
    const frames = validFrameSet(MIN_VIEWS_FOR_RECONSTRUCTION).map((f) => frame(f.index as number, { intrinsics: { width: 0, height: 0 } }));
    await writeCapture(captureDirectory, frames);

    let error: unknown;
    try {
      await buildNerfstudioDataset(captureDirectory, datasetDirectory);
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(CaptureAdapterError);
    expect((error as CaptureAdapterError).code).toBe('capture_intrinsics_missing');
  });

  it('throws capture_insufficient_views when fewer than the minimum usable frames exist', async () => {
    await writeCapture(captureDirectory, validFrameSet(MIN_VIEWS_FOR_RECONSTRUCTION - 1));

    let error: unknown;
    try {
      await buildNerfstudioDataset(captureDirectory, datasetDirectory);
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(CaptureAdapterError);
    expect((error as CaptureAdapterError).code).toBe('capture_insufficient_views');
  });

  it('throws capture_dataset_invalid when frames.json is missing', async () => {
    await fs.mkdir(captureDirectory, { recursive: true });

    let error: unknown;
    try {
      await buildNerfstudioDataset(captureDirectory, datasetDirectory);
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(CaptureAdapterError);
    expect((error as CaptureAdapterError).code).toBe('capture_dataset_invalid');
  });

  it('throws capture_dataset_invalid for the wrong schema', async () => {
    await fs.mkdir(captureDirectory, { recursive: true });
    await fs.writeFile(
      path.join(captureDirectory, 'frames.json'),
      JSON.stringify({ schema: 'something.else/1', frames: [] }),
    );

    let error: unknown;
    try {
      await buildNerfstudioDataset(captureDirectory, datasetDirectory);
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(CaptureAdapterError);
    expect((error as CaptureAdapterError).code).toBe('capture_dataset_invalid');
  });

  it('rejects a frame whose rgbPath escapes the capture directory', async () => {
    const frames = validFrameSet(MIN_VIEWS_FOR_RECONSTRUCTION + 1);
    frames[0] = frame(0, { rgbPath: '../../etc/passwd' });
    await fs.mkdir(path.join(captureDirectory, 'rgb'), { recursive: true });
    for (const f of frames.slice(1)) {
      const target = path.join(captureDirectory, f.rgbPath as string);
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.writeFile(target, Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
    }
    await fs.writeFile(
      path.join(captureDirectory, 'frames.json'),
      JSON.stringify({ schema: 'kubus.capture.frames/1', frames }),
    );

    const result = await buildNerfstudioDataset(captureDirectory, datasetDirectory);
    // The escaping frame is dropped like any other malformed frame; the rest
    // still clear the minimum-views bar in this fixture size.
    expect(result.droppedFrameCount).toBe(1);
  });
});
