import crypto from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { create as createDigest } from 'multiformats/hashes/digest';
import { CID } from 'multiformats/cid';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import {
  assertSpatialOutputRoles, isOutputVerificationFailure, openOutputBlob, outputCommitmentDigest, PRIVATE_OUTPUT_PROTOCOL, sealOutputBlob, spatialOutputShape, validatePrivateOutput,
} from '../src/compute/privateOutputTransport.js';

const jobId = '3ef91af5-5335-4595-8e8a-0618d2c1c039';
let directory: string;
const blocks = new Map<string, Buffer>();
const kubo = {
  async addFileStreamed(file: string, name: string, _timeout?: number, options?: { pin?: boolean }) {
    expect(name).toBe('private-result.enc');
    expect(options?.pin).toBe(false);
    const data = await fs.readFile(file);
    const digest = createDigest(0x12, crypto.createHash('sha256').update(data).digest());
    const cid = CID.createV1(0x55, digest).toString();
    blocks.set(cid, data);
    return { Hash: cid };
  },
  async catStream(cid: string) {
    const data = blocks.get(cid);
    if (!data) throw new Error('test CID absent');
    return {
      body: new ReadableStream<Uint8Array>({
        start(controller) { controller.enqueue(data); controller.close(); },
      }),
      cancel() {},
    };
  },
};

beforeEach(async () => { directory = await fs.mkdtemp(path.join(os.tmpdir(), 'private-spatial-output-')); });
afterEach(async () => { blocks.clear(); await fs.rm(directory, { recursive: true, force: true }); });

async function artifact(role: string, plain: Buffer, requester: crypto.KeyObject) {
  const source = path.join(directory, role);
  await fs.writeFile(source, plain);
  return sealOutputBlob({ source, temporaryDirectory: directory, kubo, role, jobId,
    requesterPublicKey: requester.export({ format: 'der', type: 'spki' }).toString('base64') });
}

describe('private output transport', () => {
  test('stores only encrypted manifest and variant blobs externally and binds their exact plaintext to the job', async () => {
    const requester = crypto.generateKeyPairSync('x25519');
    const variantBytes = Buffer.from('synthetic-private-splat-variant');
    const variant = await artifact('spatial_preview', variantBytes, requester.publicKey);
    const rawManifest = Buffer.from(JSON.stringify({ variants: [variant.cid] }));
    const manifest = await artifact('manifest', rawManifest, requester.publicKey);
    const commitment = { schema: PRIVATE_OUTPUT_PROTOCOL, manifestCid: manifest.cid, blobs: [variant, manifest] } as const;
    const cids = [manifest.cid, variant.cid];
    const accepted = validatePrivateOutput(commitment, jobId, manifest.cid, cids);
    expect(outputCommitmentDigest(accepted)).toMatch(/^[0-9a-f]{64}$/);
    expect(blocks.get(manifest.cid)?.indexOf(rawManifest)).toBe(-1);
    expect(blocks.get(variant.cid)?.equals(variantBytes)).toBe(false);
    for (const [blob, expected] of [[variant, variantBytes], [manifest, rawManifest]] as const) {
      const destination = path.join(directory, blob.role + '.verified');
      await openOutputBlob({ blob, kubo, recipientPrivateKey: requester.privateKey, jobId, destination });
      expect(await fs.readFile(destination)).toEqual(expected);
    }
    expect(() => validatePrivateOutput(commitment, jobId, variant.cid, cids)).toThrow();
    expect(() => validatePrivateOutput(commitment, 'different-job', manifest.cid, cids)).toThrow();
  });

  test('wrong recipient and tampered ciphertext never leave a verified plaintext file', async () => {
    const requester = crypto.generateKeyPairSync('x25519');
    const nobody = crypto.generateKeyPairSync('x25519');
    const blob = await artifact('spatial_preview', Buffer.from('synthetic bytes'), requester.publicKey);
    const destination = path.join(directory, 'verified');
    await expect(openOutputBlob({ blob, kubo, recipientPrivateKey: nobody.privateKey, jobId, destination })).rejects.toThrow();
    const tampered = blocks.get(blob.cid)!;
    tampered[0] = tampered[0]! ^ 0x01;
    await expect(openOutputBlob({ blob, kubo, recipientPrivateKey: requester.privateKey, jobId, destination })).rejects.toThrow();
    expect(await fs.readdir(directory)).toEqual(['spatial_preview']);
  });

  test('a full derivative and a lightweight travel as two blobs beside the manifest, each opening to its exact bytes', async () => {
    const requester = crypto.generateKeyPairSync('x25519');
    const full = Buffer.from('synthetic full render derivative');
    const light = Buffer.from('synthetic lightweight');
    const mobile = await artifact('spatial_mobile', full, requester.publicKey);
    const preview = await artifact('spatial_preview', light, requester.publicKey);
    const manifest = await artifact('manifest', Buffer.from('{}'), requester.publicKey);
    const commitment = { schema: PRIVATE_OUTPUT_PROTOCOL, manifestCid: manifest.cid, blobs: [mobile, preview, manifest] } as const;
    const accepted = validatePrivateOutput(commitment, jobId, manifest.cid, [manifest.cid, mobile.cid, preview.cid]);
    expect(spatialOutputShape(accepted)).toEqual({ kind: 'v2', full: mobile, lightweight: preview });
    for (const [blob, expected] of [[mobile, full], [preview, light]] as const) {
      const destination = path.join(directory, blob.role);
      await fs.rm(destination, { force: true });
      await openOutputBlob({ blob, kubo, recipientPrivateKey: requester.privateKey, jobId, destination });
      expect(await fs.readFile(destination)).toEqual(expected);
    }
  });

  test('output shape: full only is v2, an archive without a mobile blob is legacy, anything else is invalid', () => {
    const blob = (role: string) => ({ role }) as never;
    expect(spatialOutputShape({ blobs: [blob('manifest'), blob('spatial_mobile')] })).toMatchObject({ kind: 'v2', lightweight: null });
    expect(spatialOutputShape({ blobs: [blob('manifest'), blob('spatial_archive')] })).toEqual({ kind: 'legacy' });
    // A lightweight alone, two fulls, a second lightweight or a stray model are not a valid two-artifact result.
    expect(spatialOutputShape({ blobs: [blob('manifest'), blob('spatial_preview')] })).toEqual({ kind: 'invalid' });
    expect(spatialOutputShape({ blobs: [blob('manifest'), blob('spatial_mobile'), blob('spatial_mobile')] })).toEqual({ kind: 'invalid' });
    expect(spatialOutputShape({ blobs: [blob('manifest'), blob('spatial_mobile'), blob('spatial_preview'), blob('spatial_preview')] })).toEqual({ kind: 'invalid' });
    expect(spatialOutputShape({ blobs: [blob('manifest'), blob('spatial_mobile'), blob('model3d')] })).toEqual({ kind: 'invalid' });
    // The archive next to a mobile blob is not the legacy shape, and is still not importable.
    expect(spatialOutputShape({ blobs: [blob('manifest'), blob('spatial_mobile'), blob('spatial_archive')] })).toEqual({ kind: 'invalid' });
  });

  test('a provider never seals the raw archive: only a full derivative and one optional lightweight are allowed', () => {
    expect(() => assertSpatialOutputRoles(['spatial_mobile'])).not.toThrow();
    expect(() => assertSpatialOutputRoles(['spatial_mobile', 'spatial_preview'])).not.toThrow();
    for (const roles of [['spatial_archive'], ['spatial_preview'], ['spatial_mobile', 'spatial_archive'], ['spatial_mobile', 'spatial_mobile'], []]) {
      expect(() => assertSpatialOutputRoles(roles)).toThrow('worker_output_roles_invalid');
    }
  });

  describe('fetching a sealed blob', () => {
    /** A Kubo whose stream hands out `parts` one at a time, `gapMs` apart; with `stall` it goes silent after the last part. */
    function slowKubo(data: Buffer, parts: number, gapMs: number, stall = false) {
      return {
        addFileStreamed: kubo.addFileStreamed,
        async catStream(_cid: string, _range?: unknown, signal?: AbortSignal) {
          const size = Math.ceil(data.length / parts);
          let sent = 0;
          return {
            body: new ReadableStream<Uint8Array>({
              async pull(controller) {
                if (sent >= data.length) { if (stall) await new Promise((_, reject) => signal?.addEventListener('abort', () => reject(signal.reason ?? new Error('aborted')))); else controller.close(); return; }
                await new Promise(resolve => setTimeout(resolve, gapMs));
                controller.enqueue(data.subarray(sent, sent + size));
                sent += size;
              },
            }),
            cancel() {},
          };
        },
      };
    }

    test('a download that keeps moving is never cut off by a fixed total time', async () => {
      const requester = crypto.generateKeyPairSync('x25519');
      const blob = await artifact('spatial_mobile', Buffer.alloc(4000, 7), requester.publicKey);
      const sealedBytes = blocks.get(blob.cid)!;
      const destination = path.join(directory, 'moving');
      // Eight parts 40 ms apart take about 320 ms in all, well over the 150 ms inactivity limit.
      await openOutputBlob({ blob, kubo: slowKubo(sealedBytes, 8, 40), recipientPrivateKey: requester.privateKey, jobId, destination, inactivityMs: 150 });
      expect(await fs.readFile(destination)).toEqual(Buffer.alloc(4000, 7));
    });

    test('a download that goes silent is stopped as a transient failure, not as a verification failure', async () => {
      const requester = crypto.generateKeyPairSync('x25519');
      const blob = await artifact('spatial_mobile', Buffer.alloc(4000, 7), requester.publicKey);
      const destination = path.join(directory, 'stalled');
      const failure = await openOutputBlob({ blob, kubo: slowKubo(blocks.get(blob.cid)!.subarray(0, 100), 1, 5, true), recipientPrivateKey: requester.privateKey, jobId, destination, inactivityMs: 80 })
        .then(() => null, (error: unknown) => error);
      expect(failure).not.toBeNull();
      expect(isOutputVerificationFailure(failure)).toBe(false);
      await expect(fs.stat(destination)).rejects.toMatchObject({ code: 'ENOENT' });
    });
  });

  test('only a result that is wrong counts as a verification failure; I/O and timeouts do not', async () => {
    const wrong = [
      Object.assign(new Error('private_output_signature_invalid'), { code: 'private_output_signature_invalid', statusCode: 422 }),
      Object.assign(new Error('private_output_signature_binding_invalid'), { code: 'private_output_signature_binding_invalid' }),
      new Error('private_output_digest_mismatch'), new Error('private_output_size_limit'), new Error('private_output_binding_invalid'),
      Object.assign(new Error('private_output_variant_binding_invalid'), { code: 'private_output_variant_binding_invalid' }),
      new Error('spatial_manifest_variant_invalid'), new SyntaxError('Unexpected token'), new Error('Unsupported state or unable to authenticate data'),
      new Error('compute_envelope_context_invalid'),
    ];
    for (const error of wrong) expect(isOutputVerificationFailure(error), String(error.message)).toBe(true);
    const transient = [
      Object.assign(new Error('ENOSPC: no space left on device'), { code: 'ENOSPC' }), Object.assign(new Error('boom'), { code: 'ECONNREFUSED' }),
      new Error('Kubo cat failed with HTTP 500'), new DOMException('The operation was aborted due to timeout', 'TimeoutError'),
      Object.assign(new Error('premature close'), { code: 'ERR_STREAM_PREMATURE_CLOSE' }), new Error('fetch failed'), 'string', undefined,
    ];
    for (const error of transient) expect(isOutputVerificationFailure(error), String((error as Error)?.message ?? error)).toBe(false);
  });
});
