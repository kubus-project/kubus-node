import crypto from 'node:crypto';
import { createReadStream, createWriteStream, promises as fs } from 'node:fs';
import path from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import stableStringify from 'json-stable-stringify';
import type { KuboClient } from '../ipfs/kuboClient.js';
import { canonicalPinCid } from '../utils/cid.js';
import { encryptionPublicKey, unwrapComputeKey, wrapComputeKey, type ComputeKeyEnvelope } from './computeKeyEnvelope.js';

export const PRIVATE_OUTPUT_PROTOCOL = 'kubus.private-output/1';
export const MAX_OUTPUT_BYTES = 512 * 1024 * 1024;
const MAX_MANIFEST_BYTES = 256 * 1024;
const MAX_RESULT_BYTES = 2 * MAX_OUTPUT_BYTES;
const SHA256 = /^[a-f0-9]{64}$/;
const ROLES = new Set(['manifest', 'spatial_preview', 'spatial_mobile', 'spatial_archive', 'model3d']);

export interface PrivateOutputBlob {
  role: string;
  cid: string;
  bytes: number;
  sha256: string;
  plaintextBytes: number;
  plaintextSha256: string;
  iv: string;
  authTag: string;
  keyEnvelope: ComputeKeyEnvelope;
}

export interface PrivateOutputCommitment {
  schema: typeof PRIVATE_OUTPUT_PROTOCOL;
  manifestCid: string;
  blobs: PrivateOutputBlob[];
}

type KuboTransport = Pick<KuboClient, 'addFileStreamed' | 'catStream'>;

const associatedData = (jobId: string, role: string) => `${PRIVATE_OUTPUT_PROTOCOL}:${jobId}:${role}`;
const maxFor = (role: string) => role === 'manifest' ? MAX_MANIFEST_BYTES : MAX_OUTPUT_BYTES;
const encode = (bytes: Buffer) => bytes.toString('base64');

class DigestStream extends Transform {
  public size = 0;
  private readonly hash = crypto.createHash('sha256');

  constructor(private readonly limit: number) { super(); }

  override _transform(chunk: Buffer, _encoding: BufferEncoding, finish: (error?: Error | null, data?: Buffer) => void): void {
    this.size += chunk.length;
    if (this.size > this.limit) { finish(new Error('private_output_size_limit')); return; }
    this.hash.update(chunk);
    finish(null, chunk);
  }

  digest(): string { return this.hash.digest('hex'); }
}

export async function sealOutputBlob({
  source, temporaryDirectory, kubo, requesterPublicKey, jobId, role,
}: {
  source: string; temporaryDirectory: string; kubo: KuboTransport;
  requesterPublicKey: string; jobId: string; role: string;
}): Promise<PrivateOutputBlob> {
  if (!ROLES.has(role)) throw new Error('private_output_role_invalid');
  const recipient = encryptionPublicKey(requesterPublicKey);
  const dataKey = crypto.randomBytes(32);
  const iv = crypto.randomBytes(12);
  const aad = associatedData(jobId, role);
  const cipher = crypto.createCipheriv('aes-256-gcm', dataKey, iv);
  cipher.setAAD(Buffer.from(aad));
  const encryptedFile = path.join(temporaryDirectory, `${crypto.randomUUID()}.enc`);
  const plain = new DigestStream(maxFor(role));
  const sealed = new DigestStream(maxFor(role));
  try {
    await pipeline(createReadStream(source), plain, cipher, sealed,
      createWriteStream(encryptedFile, { mode: 0o600, flags: 'wx' }));
    if (plain.size === 0) throw new Error('private_output_empty');
    const uploaded = await kubo.addFileStreamed(encryptedFile, 'private-result.enc', undefined, { pin: false });
    if (!uploaded.Hash) throw new Error('private_output_cid_missing');
    const cid = canonicalPinCid(uploaded.Hash);
    return {
      role, cid, bytes: sealed.size, sha256: sealed.digest(),
      plaintextBytes: plain.size, plaintextSha256: plain.digest(),
      iv: encode(iv), authTag: encode(cipher.getAuthTag()),
      keyEnvelope: wrapComputeKey(dataKey, recipient, `${aad}:${cid}`),
    };
  } finally {
    await fs.rm(encryptedFile, { force: true });
    dataKey.fill(0);
  }
}

function boundedBase64(value: unknown, size: number): value is string {
  return typeof value === 'string' && value.length <= 100 && Buffer.from(value, 'base64').length === size;
}

export function validatePrivateOutput(value: unknown, jobId: string, manifestCid: string, cids: readonly string[]): PrivateOutputCommitment {
  const output = value as Partial<PrivateOutputCommitment> | null;
  if (!output || output.schema !== PRIVATE_OUTPUT_PROTOCOL || output.manifestCid !== manifestCid ||
      !Array.isArray(output.blobs) || output.blobs.length < 2 || output.blobs.length > ROLES.size) {
    throw new Error('private_output_commitment_invalid');
  }
  const byRole = new Map<string, string>();
  const expectedCids = new Set(cids);
  let total = 0;
  for (const blob of output.blobs) {
    if (!blob || !ROLES.has(blob.role) || byRole.has(blob.role) || !expectedCids.delete(blob.cid) ||
        canonicalPinCid(blob.cid) !== blob.cid || !Number.isSafeInteger(blob.bytes) || blob.bytes < 1 ||
        blob.bytes > maxFor(blob.role) || blob.bytes !== blob.plaintextBytes ||
        !SHA256.test(blob.sha256) || !SHA256.test(blob.plaintextSha256) ||
        !boundedBase64(blob.iv, 12) || !boundedBase64(blob.authTag, 16) ||
        blob.keyEnvelope?.context !== `${associatedData(jobId, blob.role)}:${blob.cid}` ||
        blob.keyEnvelope.algorithm !== 'X25519-HKDF-SHA256-AES-256-GCM' ||
        !boundedBase64(blob.keyEnvelope.iv, 12) || !boundedBase64(blob.keyEnvelope.authTag, 16) ||
        !boundedBase64(blob.keyEnvelope.salt, 32) || !boundedBase64(blob.keyEnvelope.wrappedKey, 32)) {
      throw new Error('private_output_blob_invalid');
    }
    encryptionPublicKey(blob.keyEnvelope.ephemeralPublicKey);
    byRole.set(blob.role, blob.cid);
    total += blob.bytes;
  }
  if (byRole.get('manifest') !== manifestCid || expectedCids.size || total > MAX_RESULT_BYTES) {
    throw new Error('private_output_binding_invalid');
  }
  return output as PrivateOutputCommitment;
}

async function* chunks(body: ReadableStream<Uint8Array>): AsyncIterable<Uint8Array> {
  const reader = body.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return;
      yield value;
    }
  } finally { reader.releaseLock(); }
}

export async function openOutputBlob({
  blob, kubo, recipientPrivateKey, jobId, destination,
}: {
  blob: PrivateOutputBlob; kubo: KuboTransport; recipientPrivateKey: crypto.KeyObject;
  jobId: string; destination: string;
}): Promise<void> {
  const aad = associatedData(jobId, blob.role);
  const dataKey = unwrapComputeKey(blob.keyEnvelope, recipientPrivateKey, `${aad}:${blob.cid}`);
  const decipher = crypto.createDecipheriv('aes-256-gcm', dataKey, Buffer.from(blob.iv, 'base64'));
  decipher.setAAD(Buffer.from(aad));
  decipher.setAuthTag(Buffer.from(blob.authTag, 'base64'));
  const temporary = `${destination}.${crypto.randomUUID()}.part`;
  const sealed = new DigestStream(blob.bytes);
  const plain = new DigestStream(blob.plaintextBytes);
  let download: Awaited<ReturnType<KuboTransport['catStream']>> | undefined;
  try {
    const signal = AbortSignal.timeout(120_000);
    download = await kubo.catStream(blob.cid, undefined, signal);
    await pipeline(Readable.from(chunks(download.body)), sealed, decipher, plain,
      createWriteStream(temporary, { mode: 0o600, flags: 'wx' }),
      { signal });
    if (sealed.size !== blob.bytes || plain.size !== blob.plaintextBytes ||
        sealed.digest() !== blob.sha256 || plain.digest() !== blob.plaintextSha256) {
      throw new Error('private_output_digest_mismatch');
    }
    await fs.rename(temporary, destination);
  } finally {
    download?.cancel();
    await fs.rm(temporary, { force: true });
    dataKey.fill(0);
  }
}

export function outputCommitmentDigest(output: PrivateOutputCommitment): string {
  return crypto.createHash('sha256').update(stableStringify(output) ?? '').digest('hex');
}
