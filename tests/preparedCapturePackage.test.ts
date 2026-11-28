import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { inspectCapturePackage } from '../src/captures/capturePackage.js';
import { faceMaskingProvenance } from '../src/jobs/jobRuntime.js';

let directory: string;

async function dataset(frames: unknown[], record: unknown = { schema: 'kubus.prepared-dataset/1' }) {
  await fs.mkdir(path.join(directory, 'dataset', 'images'), { recursive: true });
  await fs.writeFile(path.join(directory, 'dataset', 'prepared.json'), JSON.stringify(record));
  await fs.writeFile(path.join(directory, 'dataset', 'transforms.json'), JSON.stringify({ frames }));
}

beforeEach(async () => { directory = await fs.mkdtemp(path.join(os.tmpdir(), 'kubus-prepared-')); });
afterEach(async () => { await fs.rm(directory, { recursive: true, force: true }); });

describe('prepared capture packages', () => {
  test('a masked, posed dataset is recognised as prepared', async () => {
    await dataset([{ file_path: './images/photo_00000.jpg' }, { file_path: 'images/video_00000.jpg' }]);
    await fs.writeFile(path.join(directory, 'dataset', 'images', 'photo_00000.jpg'), 'x');
    await fs.writeFile(path.join(directory, 'dataset', 'images', 'video_00000.jpg'), 'x');
    expect(await inspectCapturePackage(directory)).toMatchObject({ ok: true, kind: 'prepared', frameCount: 2 });
  });

  test('missing images, paths outside images/ and unknown schemas are refused', async () => {
    await dataset([{ file_path: 'images/photo_00000.jpg' }]);
    expect(await inspectCapturePackage(directory)).toMatchObject({ ok: false, code: 'capture_frame_file_missing', missingPaths: ['dataset/images/photo_00000.jpg'] });
    await dataset([{ file_path: '../capture.json' }]);
    expect(await inspectCapturePackage(directory)).toMatchObject({ ok: false, code: 'capture_frames_invalid' });
    await dataset([{ file_path: 'colmap/database.db' }]);
    expect(await inspectCapturePackage(directory)).toMatchObject({ ok: false, code: 'capture_frames_invalid' });
    await dataset([{ file_path: 'images/a.jpg' }], { schema: 'other' });
    expect(await inspectCapturePackage(directory)).toMatchObject({ ok: false, kind: 'prepared' });
  });

  test('raw photos beside a dataset are still a photo capture, never a prepared one', async () => {
    await dataset([{ file_path: 'images/photo_00000.jpg' }]);
    await fs.mkdir(path.join(directory, 'photos'));
    await fs.writeFile(path.join(directory, 'photos', 'IMG_1.jpg'), Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
    expect((await inspectCapturePackage(directory)).kind).not.toBe('prepared');
  });

  test('masking provenance says the requester worker masked the dataset', () => {
    const worker = { preparedBy: { faceMasking: { photos: { images: 10, regions: 2, detector: 'yunet', weightsSha256: 'f'.repeat(64) } } } };
    expect(faceMaskingProvenance({ kind: 'prepared', artworkId: 'a' }, worker)).toMatchObject({
      ran: true, photos: { images: 10, regions: 2, source: 'worker', attestation: 'requester_worker', weightsPinned: false },
    });
    expect(faceMaskingProvenance({ kind: 'prepared', artworkId: 'a' }, {})).toEqual({ ran: false, reason: 'prepared_without_masking' });
  });
});
