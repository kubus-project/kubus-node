import crypto from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CapabilityRegistry } from '../src/capabilities/registry.js';
import { CaptureStore } from '../src/captures/captureStore.js';
import { JobRuntime } from '../src/jobs/jobRuntime.js';
import { LocalStore } from '../src/state/localStore.js';
import { MIN_VIEWS_FOR_RECONSTRUCTION } from '../src/spatial/nerfstudioAdapter.js';
import { spatialOutputShape, validatePrivateOutput, type PrivateOutputCommitment } from '../src/compute/privateOutputTransport.js';
import { syntheticCid } from './fixtures/contentIds.js';

const dirs: string[] = [];
const remoteJobId = '3ef91af5-5335-4595-8e8a-0618d2c1c039';
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(dirs.splice(0).map(dir => fs.rm(dir, { recursive: true, force: true })));
});

function captureFiles() {
  const frames = Array.from({ length: MIN_VIEWS_FOR_RECONSTRUCTION }, (_, index) => ({
    index, rgbPath: `rgb/${String(index).padStart(5, '0')}.jpg`, poseTranslation: [index * 0.1, 0, 0], poseRotation: [0, 0, 0, 1],
    intrinsics: { width: 1920, height: 1080, fx: 1400.5, fy: 1400.5, cx: 960, cy: 540 }, timestampNanos: 1000 + index, depthAvailable: false,
  }));
  const jpg = Buffer.from([0xff, 0xd8, 0xff, 0xd9]).toString('base64');
  return [...frames.map(f => ({ path: f.rgbPath, contentBase64: jpg })),
    { path: 'frames.json', contentBase64: Buffer.from(JSON.stringify({ schema: 'kubus.capture.frames/1', frames })).toString('base64') }];
}

/** A provider-side job whose worker answers with `variants`, sealed to a requester key; returns the finished job. */
async function runRemoteJob(variants: Array<{ role: string; name: string }>) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'kubus-provider-output-')); dirs.push(dir);
  const store = new LocalStore(path.join(dir, 'state.json')); await store.load();
  const captures = new CaptureStore(dir, store);
  const capture = await captures.create({ schema: 'kubus.capture/1', artworkId: 'art-1', capturedAt: new Date().toISOString(), metadata: { intrinsics: true }, files: captureFiles() });
  const requester = crypto.generateKeyPairSync('x25519');
  const mime = 'application/octet-stream';
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (url.endsWith('/health')) return new Response(JSON.stringify({ status: 'ready', cleanupProtocol: 1, workerInstanceId: '44444444-4444-4444-8444-444444444444', gpu: { available: true, name: 'RTX' }, capabilities: ['spatial.reconstruct'], outputProtocol: 'kubus.spatial-output/2' }));
    if (url.endsWith('/v1/jobs/cancel')) return new Response(JSON.stringify({ ...JSON.parse(String(init?.body)), cleanupProtocol: 1, quiescent: true }));
    if (url.endsWith('/v1/process')) {
      const body = JSON.parse(String(init?.body ?? '{}'));
      await fs.mkdir(path.join(body.outputDirectory, 'render'), { recursive: true });
      for (const [index, variant] of variants.entries()) await fs.writeFile(path.join(body.outputDirectory, 'render', variant.name), Buffer.alloc(64, index + 1));
      return new Response(JSON.stringify({
        variants: variants.map(variant => ({ role: variant.role, path: `render/${variant.name}`, mimeType: mime, format: 'ply', storageClass: 'warm' })),
        processing: { protocol: 'kubus.spatial-job/1', workerVersion: 'kubus-spatial-worker/11', reconstruction: { engine: 'nerfstudio', method: 'splatfacto', iterations: 1000, outputFormat: 'ply' }, lightweight: null },
      }));
    }
    throw new Error(`unexpected fetch to ${url}`);
  });
  let added = 0;
  const jobs = new JobRuntime({
    store, captureStore: captures,
    kubo: { pinAdd: async () => undefined, pinLs: async () => ({ Keys: {} }), addFileStreamed: async () => ({ Hash: syntheticCid(`sealed-${added++}`) }), addBytes: async () => ({ Hash: syntheticCid('manifest') }) } as never,
    logger: { warn: () => undefined } as never, dataRoot: dir, concurrency: 1, workerUrl: 'http://kubus-spatial-worker:8790',
    participationGate: { assertUsefulOperation: async () => undefined } as never, workerAuth: { issue: async () => 'token' } as never,
    capabilities: new CapabilityRegistry({ id: async () => ({ ID: 'peer' }) } as never, 'http://kubus-spatial-worker:8790'),
  });
  await jobs.start();
  const job = await jobs.create('spatial.reconstruct', {
    captureId: capture.id, artworkId: 'art-1', remoteComputeJobId: remoteJobId,
    privateOutputRequesterPublicKey: requester.publicKey.export({ format: 'der', type: 'spki' }).toString('base64'),
  });
  for (let waited = 0; waited < 4000 && !['completed', 'failed'].includes(jobs.get(job.id).state); waited += 10) await new Promise(resolve => setTimeout(resolve, 10));
  await new Promise(resolve => setTimeout(resolve, 20));
  return { job: jobs.get(job.id), store };
}

describe('provider output of a managed reconstruction', () => {
  it('seals the full derivative and the lightweight as two blobs beside the manifest, pinned under the job owner', async () => {
    const { job, store } = await runRemoteJob([{ role: 'spatial_mobile', name: 'reconstruction.ply' }, { role: 'spatial_preview', name: 'reconstruction-light.ply' }]);
    expect(job.state).toBe('completed');
    const commitment = (job.output as { privateOutput: PrivateOutputCommitment }).privateOutput;
    expect(commitment.blobs.map(blob => blob.role).sort()).toEqual(['manifest', 'spatial_mobile', 'spatial_preview']);
    expect(validatePrivateOutput(commitment, remoteJobId, commitment.manifestCid, commitment.blobs.map(blob => blob.cid))).toBe(commitment);
    expect(spatialOutputShape(commitment).kind).toBe('v2');
    // Each sealed blob is held under one owner so it can be released once the job is terminal, never before.
    const owners = commitment.blobs.map(blob => store.snapshot().managedPins?.[blob.cid]?.owners);
    for (const held of owners) expect(Object.keys(held ?? {})).toEqual([`provider-output:${remoteJobId}`]);
    expect(Object.values(store.snapshot().privateComputeCids ?? {}).filter(item => item.role === 'private_output' && !item.releasedAt)).toHaveLength(3);
  });

  it('a full derivative alone is a valid result (no lightweight when it fits the budget)', async () => {
    const { job } = await runRemoteJob([{ role: 'spatial_mobile', name: 'reconstruction.ply' }]);
    expect(job.state).toBe('completed');
    const commitment = (job.output as { privateOutput: PrivateOutputCommitment }).privateOutput;
    expect(commitment.blobs.map(blob => blob.role).sort()).toEqual(['manifest', 'spatial_mobile']);
  });

  it('a worker that still returns the raw archive fails the job and seals nothing', async () => {
    const { job, store } = await runRemoteJob([{ role: 'spatial_archive', name: 'reconstruction.ply' }]);
    expect(job.state).toBe('failed');
    expect(job.error?.code).toBe('worker_output_roles_invalid');
    expect(Object.keys(store.snapshot().privateComputeCids ?? {})).toEqual([]);
  });
});
