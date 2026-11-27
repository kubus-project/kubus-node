import crypto from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import stableStringify from 'json-stable-stringify';
import { create as createDigest } from 'multiformats/hashes/digest';
import { CID } from 'multiformats/cid';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { RemoteComputeRuntime } from '../src/compute/remoteComputeRuntime.js';
import { isOutputVerificationFailure, PRIVATE_OUTPUT_PROTOCOL, sealOutputBlob } from '../src/compute/privateOutputTransport.js';

const jobId = '3ef91af5-5335-4595-8e8a-0618d2c1c039';
let directory: string;
const blocks = new Map<string, Buffer>();
const kubo = {
  async addFileStreamed(file: string) {
    const data = await fs.readFile(file);
    const cid = CID.createV1(0x55, createDigest(0x12, crypto.createHash('sha256').update(data).digest())).toString();
    blocks.set(cid, data);
    return { Hash: cid };
  },
  async catStream(cid: string) {
    const data = blocks.get(cid)!;
    return { body: new ReadableStream<Uint8Array>({ start(c) { c.enqueue(data); c.close(); } }), cancel() {} };
  },
};

beforeEach(async () => { directory = await fs.mkdtemp(path.join(os.tmpdir(), 'manifest-shape-')); });
afterEach(async () => { blocks.clear(); await fs.rm(directory, { recursive: true, force: true }); });

/** A job whose signed commitment is valid but whose manifest blob holds `manifest` (authored by the provider). */
async function jobWithManifest(manifest: unknown) {
  const requester = crypto.generateKeyPairSync('x25519');
  const signer = crypto.generateKeyPairSync('ed25519');
  const publicKey = requester.publicKey.export({ format: 'der', type: 'spki' }).toString('base64');
  const seal = async (role: string, plain: Buffer) => {
    const source = path.join(directory, role);
    await fs.writeFile(source, plain);
    return sealOutputBlob({ source, temporaryDirectory: directory, kubo: kubo as never, role, jobId, requesterPublicKey: publicKey });
  };
  const variant = await seal('spatial_preview', Buffer.from('variant bytes'));
  const manifestBlob = await seal('manifest', Buffer.from(JSON.stringify(manifest)));
  const outputCids = [manifestBlob.cid, variant.cid];
  const payload = { jobId, inputHash: 'a'.repeat(64), jobSpecHash: 'b'.repeat(64), protocolVersion: 'kubus.compute/1', outputCids,
    privateOutput: { schema: PRIVATE_OUTPUT_PROTOCOL, manifestCid: manifestBlob.cid, blobs: [variant, manifestBlob] } };
  const job = {
    id: jobId, inputHash: 'a'.repeat(64), jobSpecHash: 'b'.repeat(64), protocolVersion: 'kubus.compute/1', outputManifestCid: manifestBlob.cid, outputCids,
    canonicalJobSpec: { processing: { outputMode: PRIVATE_OUTPUT_PROTOCOL } },
    providerReceipt: { payload, signature: crypto.sign(null, Buffer.from(stableStringify(payload) ?? ''), signer.privateKey).toString('base64') },
    verification: { providerSigningPublicKey: signer.publicKey.export({ format: 'der', type: 'spki' }).toString('base64') },
  } as never;
  const runtime = new RemoteComputeRuntime({
    api: {} as never, kubo: kubo as never, store: {} as never, captures: {} as never, jobs: {} as never, gate: {} as never, transport: {} as never, logger: {} as never,
    identity: { encryptionPrivateKey: async () => requester.privateKey } as never,
    config: { localDataPath: directory } as never,
  });
  return { job, runtime };
}

describe('a provider manifest of the wrong shape', () => {
  const valid = {
    schema: 'kubus.spatial/1', type: 'gaussianSplat', id: 'sp1', artworkId: 'a1', captureId: 'c1', capturedAt: '2026-01-01T00:00:00Z',
    processing: { protocol: 'kubus.spatial-job/1', workerVersion: '1', reconstruction: { engine: 'nerfstudio', method: 'splatfacto', iterations: 10, outputFormat: 'ply' } },
  };
  test.each([
    ['a null variant', { ...valid, variants: [null] }],
    ['a null revision', { ...valid, variants: [{ cid: 'x', sizeBytes: 1, mimeType: 'a/b', format: 'f', role: 'spatial_preview' }], revision: null }],
  ])('%s is a verification failure the requester can reject, not a bare TypeError', async (_name, manifest) => {
    const { job, runtime } = await jobWithManifest(manifest);
    const failure = await runtime.stagePrivateOutput(job).then(() => null, (error: unknown) => error);
    expect(failure).toBeInstanceOf(Error);
    expect(isOutputVerificationFailure(failure)).toBe(true);
  });
});
