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
/** What the worker's output is: a full render derivative (`spatial_mobile`) and an optional lightweight (`spatial_preview`). */
export const SPATIAL_OUTPUT_PROTOCOL = 'kubus.spatial-output/2';
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

/** A blob download is stopped when no bytes arrive for this long. A fixed total time cut off honest slow providers. */
export const OUTPUT_FETCH_INACTIVITY_MS = 120_000;

/**
 * Whether an error from opening a sealed result means the result itself is wrong (a signature, binding, commitment,
 * authentication tag, digest, size, manifest or variant check failed), as opposed to this Node failing to fetch or
 * store it (Kubo down, a stalled or slow transfer, a full disk). Only the first kind may be answered with a signed
 * rejection, which ends the provider's job for good; the second is retried later without acknowledging.
 */
export function isOutputVerificationFailure(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const { code, message, name } = error as { code?: unknown; message?: unknown; name?: unknown };
  const named = [code, message].filter((value): value is string => typeof value === 'string');
  if (named.some(value => /^(?:private_output_|spatial_manifest_|compute_envelope_|compute_encryption_key_)/.test(value))) return true;
  if (typeof message === 'string' && /unable to authenticate data/i.test(message)) return true;
  return name === 'SyntaxError';
}

export async function openOutputBlob({
  blob, kubo, recipientPrivateKey, jobId, destination, inactivityMs = OUTPUT_FETCH_INACTIVITY_MS,
}: {
  blob: PrivateOutputBlob; kubo: KuboTransport; recipientPrivateKey: crypto.KeyObject;
  jobId: string; destination: string; inactivityMs?: number;
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
  // The limit is on silence, not on the whole transfer: a blob of hundreds of megabytes from a slow provider keeps
  // going as long as bytes keep arriving, and a transfer that stalls (or never starts) stops after `inactivityMs`.
  const controller = new AbortController();
  let timer: NodeJS.Timeout | undefined;
  const watch = () => {
    clearTimeout(timer);
    timer = setTimeout(() => controller.abort(Object.assign(new Error('output_fetch_stalled'), { code: 'output_fetch_stalled' })), inactivityMs);
  };
  const activity = new Transform({ transform(chunk, _encoding, done) { watch(); done(null, chunk); } });
  try {
    watch();
    download = await kubo.catStream(blob.cid, undefined, controller.signal);
    await pipeline(Readable.from(chunks(download.body)), activity, sealed, decipher, plain,
      createWriteStream(temporary, { mode: 0o600, flags: 'wx' }),
      { signal: controller.signal });
    if (sealed.size !== blob.bytes || plain.size !== blob.plaintextBytes ||
        sealed.digest() !== blob.sha256 || plain.digest() !== blob.plaintextSha256) {
      throw new Error('private_output_digest_mismatch');
    }
    await fs.rename(temporary, destination);
  } finally {
    clearTimeout(timer);
    download?.cancel();
    await fs.rm(temporary, { force: true });
    dataKey.fill(0);
  }
}

export type SpatialOutputShape =
  | { kind: 'v2'; full: PrivateOutputBlob; lightweight: PrivateOutputBlob | null }
  | { kind: 'legacy' }
  | { kind: 'invalid' };

/**
 * Reads a validated commitment as a `kubus.spatial-output/2` result: the manifest, one `spatial_mobile` (the full
 * render derivative) and at most one `spatial_preview` (the lightweight). A result with `spatial_archive` and no
 * `spatial_mobile` is a legacy provider's raw-training-file output and is never imported.
 */
export function spatialOutputShape(output: Pick<PrivateOutputCommitment, 'blobs'>): SpatialOutputShape {
  const mobile = output.blobs.filter(blob => blob.role === 'spatial_mobile');
  const preview = output.blobs.filter(blob => blob.role === 'spatial_preview');
  const archive = output.blobs.some(blob => blob.role === 'spatial_archive');
  if (archive && !mobile.length) return { kind: 'legacy' };
  const others = output.blobs.filter(blob => !['manifest', 'spatial_mobile', 'spatial_preview'].includes(blob.role));
  if (mobile.length !== 1 || preview.length > 1 || others.length) return { kind: 'invalid' };
  return { kind: 'v2', full: mobile[0]!, lightweight: preview[0] ?? null };
}

/** The roles a worker may hand a provider for a private-output job; anything else is a legacy or wrong worker. */
export function assertSpatialOutputRoles(roles: readonly string[]): void {
  const mobile = roles.filter(role => role === 'spatial_mobile').length;
  const preview = roles.filter(role => role === 'spatial_preview').length;
  if (mobile !== 1 || preview > 1 || roles.length !== mobile + preview) {
    throw Object.assign(new Error('worker_output_roles_invalid'), { code: 'worker_output_roles_invalid' });
  }
}

export function outputCommitmentDigest(output: PrivateOutputCommitment): string {
  return crypto.createHash('sha256').update(stableStringify(output) ?? '').digest('hex');
}
