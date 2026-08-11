import crypto from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { gzipSync, gunzipSync } from 'node:zlib';
import type { CaptureStore } from '../captures/captureStore.js';
import type { KuboClient } from '../ipfs/kuboClient.js';
import { localError } from '../localApi/pairingService.js';
import type { LocalStore } from '../state/localStore.js';
import type { ComputeIdentityService } from './computeIdentity.js';

export interface ComputeKeyEnvelope {
  algorithm: 'X25519-HKDF-SHA256-AES-256-GCM';
  ephemeralPublicKey: string;
  salt: string;
  iv: string;
  authTag: string;
  wrappedKey: string;
  context: string;
}

interface PackedCapture { schema: 'kubus.private-capture/1'; capture: Record<string, unknown>; files: Array<{ path: string; contentBase64: string }> }

async function walkFiles(root: string): Promise<Array<{ path: string; bytes: Buffer }>> {
  const output: Array<{ path: string; bytes: Buffer }> = [];
  const visit = async (directory: string): Promise<void> => {
    for (const entry of (await fs.readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      const target = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) throw localError(400, 'capture_symlink_forbidden');
      if (entry.isDirectory()) await visit(target);
      else if (entry.isFile()) {
        const relative = path.relative(root, target).replaceAll('\\', '/');
        if (!relative || relative.startsWith('../')) throw localError(400, 'capture_path_invalid');
        output.push({ path: relative, bytes: await fs.readFile(target) });
      }
    }
  };
  await visit(root);
  return output;
}

function keyObject(raw: string): crypto.KeyObject {
  return crypto.createPublicKey({ key: Buffer.from(raw, 'base64'), format: 'der', type: 'spki' });
}

export class PrivatePayloadTransport {
  constructor(private readonly deps: { captures: CaptureStore; kubo: KuboClient; store: LocalStore; identity: ComputeIdentityService; dataRoot: string; maxInputBytes: number }) {}

  async encryptCapture(captureId: string, providerNodeId: string, providerPublicKey: string): Promise<{ inputCid: string; inputBytes: number; inputHash: string; inputKeyEnvelope: ComputeKeyEnvelope; jobSpec: Record<string, unknown> }> {
    const capture = this.deps.captures.get(captureId);
    const files = await walkFiles(capture.directory);
    const rawBytes = files.reduce((sum, item) => sum + item.bytes.byteLength, 0);
    if (rawBytes > this.deps.maxInputBytes) throw localError(413, 'remote_compute_input_too_large');
    const packed: PackedCapture = { schema: 'kubus.private-capture/1', capture: { ...capture, directory: undefined }, files: files.map((file) => ({ path: file.path, contentBase64: file.bytes.toString('base64') })) };
    const compressed = gzipSync(Buffer.from(JSON.stringify(packed)), { level: 9 });
    const dataKey = crypto.randomBytes(32);
    const payloadIv = crypto.randomBytes(12);
    const payloadCipher = crypto.createCipheriv('aes-256-gcm', dataKey, payloadIv);
    payloadCipher.setAAD(Buffer.from('kubus.private-capture/1'));
    const ciphertext = Buffer.concat([payloadCipher.update(compressed), payloadCipher.final()]);
    const header = { schema: 'kubus.encrypted-payload/1', algorithm: 'AES-256-GCM', compression: 'gzip', iv: payloadIv.toString('base64'), authTag: payloadCipher.getAuthTag().toString('base64'), plaintextHash: crypto.createHash('sha256').update(compressed).digest('hex') };
    const encrypted = Buffer.concat([Buffer.from('KUBUSENC1\n'), Buffer.from(JSON.stringify(header)), Buffer.from('\n'), ciphertext]);
    if (encrypted.byteLength > this.deps.maxInputBytes) throw localError(413, 'remote_compute_input_too_large');
    const added = await this.deps.kubo.addBytes(encrypted, `${captureId}.kubusenc`);
    if (!added.Hash) throw localError(502, 'encrypted_input_cid_missing');
    const context = `${providerNodeId}:${added.Hash}`;
    const ephemeral = crypto.generateKeyPairSync('x25519');
    const shared = crypto.diffieHellman({ privateKey: ephemeral.privateKey, publicKey: keyObject(providerPublicKey) });
    const salt = crypto.randomBytes(32);
    const wrappingKey = Buffer.from(crypto.hkdfSync('sha256', shared, salt, Buffer.from(context), 32));
    const wrapIv = crypto.randomBytes(12);
    const wrapCipher = crypto.createCipheriv('aes-256-gcm', wrappingKey, wrapIv);
    wrapCipher.setAAD(Buffer.from(context));
    const wrappedKey = Buffer.concat([wrapCipher.update(dataKey), wrapCipher.final()]);
    const envelope: ComputeKeyEnvelope = { algorithm: 'X25519-HKDF-SHA256-AES-256-GCM', ephemeralPublicKey: exportPublic(ephemeral.publicKey), salt: salt.toString('base64'), iv: wrapIv.toString('base64'), authTag: wrapCipher.getAuthTag().toString('base64'), wrappedKey: wrappedKey.toString('base64'), context };
    const inputHash = crypto.createHash('sha256').update(encrypted).digest('hex');
    await this.deps.store.update((state) => { (state.privateComputeCids ??= {})[added.Hash!] = { role: 'encrypted_input', createdAt: new Date().toISOString() }; });
    return { inputCid: added.Hash, inputBytes: encrypted.byteLength, inputHash, inputKeyEnvelope: envelope, jobSpec: { captureSchema: 'kubus.capture/1', encryptedPayloadSchema: 'kubus.encrypted-payload/1', sourceBytes: rawBytes, fileCount: files.length } };
  }

  async decryptToDirectory(encrypted: Uint8Array, envelope: ComputeKeyEnvelope, outputDirectory: string, expectedHash: string): Promise<void> {
    const bytes = Buffer.from(encrypted);
    if (crypto.createHash('sha256').update(bytes).digest('hex') !== expectedHash) throw localError(422, 'encrypted_payload_hash_mismatch');
    const first = bytes.indexOf(10); const second = bytes.indexOf(10, first + 1);
    if (first < 0 || second < 0 || bytes.subarray(0, first).toString() !== 'KUBUSENC1') throw localError(422, 'encrypted_payload_invalid');
    const header = JSON.parse(bytes.subarray(first + 1, second).toString()) as { schema?: string; iv?: string; authTag?: string; plaintextHash?: string };
    if (header.schema !== 'kubus.encrypted-payload/1') throw localError(422, 'encrypted_payload_schema_invalid');
    const ephemeral = keyObject(envelope.ephemeralPublicKey);
    const shared = crypto.diffieHellman({ privateKey: await this.deps.identity.encryptionPrivateKey(), publicKey: ephemeral });
    const wrappingKey = Buffer.from(crypto.hkdfSync('sha256', shared, Buffer.from(envelope.salt, 'base64'), Buffer.from(envelope.context), 32));
    const unwrap = crypto.createDecipheriv('aes-256-gcm', wrappingKey, Buffer.from(envelope.iv, 'base64'));
    unwrap.setAAD(Buffer.from(envelope.context)); unwrap.setAuthTag(Buffer.from(envelope.authTag, 'base64'));
    const dataKey = Buffer.concat([unwrap.update(Buffer.from(envelope.wrappedKey, 'base64')), unwrap.final()]);
    const decipher = crypto.createDecipheriv('aes-256-gcm', dataKey, Buffer.from(header.iv || '', 'base64'));
    decipher.setAAD(Buffer.from('kubus.private-capture/1')); decipher.setAuthTag(Buffer.from(header.authTag || '', 'base64'));
    const compressed = Buffer.concat([decipher.update(bytes.subarray(second + 1)), decipher.final()]);
    if (crypto.createHash('sha256').update(compressed).digest('hex') !== header.plaintextHash) throw localError(422, 'encrypted_payload_plaintext_hash_mismatch');
    const packed = JSON.parse(gunzipSync(compressed).toString()) as PackedCapture;
    if (packed.schema !== 'kubus.private-capture/1' || !Array.isArray(packed.files) || packed.files.length > 5000) throw localError(422, 'private_capture_package_invalid');
    await fs.mkdir(outputDirectory, { recursive: true, mode: 0o700 });
    let total = 0;
    try {
      for (const file of packed.files) {
        const relative = file.path.replaceAll('\\', '/').replace(/^\/+/, '');
        if (!relative || relative.includes('..') || path.isAbsolute(relative)) throw localError(422, 'private_capture_path_invalid');
        const content = Buffer.from(file.contentBase64, 'base64'); total += content.byteLength;
        if (total > this.deps.maxInputBytes) throw localError(413, 'private_capture_expansion_limit');
        const target = path.resolve(outputDirectory, relative);
        if (!target.startsWith(`${path.resolve(outputDirectory)}${path.sep}`)) throw localError(422, 'private_capture_path_invalid');
        await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o700 }); await fs.writeFile(target, content, { mode: 0o600 });
      }
    } catch (error) { await fs.rm(outputDirectory, { recursive: true, force: true }); throw error; }
  }
}

function exportPublic(key: crypto.KeyObject): string { return key.export({ format: 'der', type: 'spki' }).toString('base64'); }
