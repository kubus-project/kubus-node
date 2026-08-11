import { afterEach, describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CaptureStore } from '../src/captures/captureStore.js';
import { ComputeIdentityService } from '../src/compute/computeIdentity.js';
import { PrivatePayloadTransport } from '../src/compute/privatePayloadTransport.js';
import { LocalStore } from '../src/state/localStore.js';

const dirs: string[] = [];
afterEach(async () => Promise.all(dirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true }))));

describe('encrypted private compute payload transport', () => {
  it('uses X25519 + HKDF + AES-256-GCM and detects tampering', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'kubus-private-transport-')); dirs.push(dir);
    const requesterStore = new LocalStore(path.join(dir, 'requester.json')); await requesterStore.load();
    const providerStore = new LocalStore(path.join(dir, 'provider.json')); await providerStore.load();
    const captures = new CaptureStore(path.join(dir, 'requester'), requesterStore);
    const capture = await captures.create({ schema: 'kubus.capture/1', artworkId: 'art-1', capturedAt: '2026-08-11T00:00:00Z', metadata: { private: true }, files: [{ path: 'rgb/0001.jpg', contentBase64: Buffer.from('private-frame').toString('base64') }] });
    let encrypted = Buffer.alloc(0);
    const kubo = { addBytes: async (bytes: Uint8Array) => { encrypted = Buffer.from(bytes); return { Hash: `Qm${'a'.repeat(44)}` }; } };
    const requesterIdentity = new ComputeIdentityService(requesterStore); const providerIdentity = new ComputeIdentityService(providerStore);
    const requester = new PrivatePayloadTransport({ captures, kubo: kubo as never, store: requesterStore, identity: requesterIdentity, dataRoot: dir, maxInputBytes: 1024 * 1024 });
    const provider = new PrivatePayloadTransport({ captures, kubo: kubo as never, store: providerStore, identity: providerIdentity, dataRoot: dir, maxInputBytes: 1024 * 1024 });
    const providerPublic = (await providerIdentity.publicIdentity()).encryptionPublicKey;
    const prepared = await requester.encryptCapture(capture.id, 'provider-1', providerPublic);
    expect(prepared.inputKeyEnvelope.algorithm).toBe('X25519-HKDF-SHA256-AES-256-GCM');
    const output = path.join(dir, 'decrypted');
    await provider.decryptToDirectory(encrypted, prepared.inputKeyEnvelope, output, prepared.inputHash);
    expect(await fs.readFile(path.join(output, 'rgb', '0001.jpg'), 'utf8')).toBe('private-frame');
    const tampered = Buffer.from(encrypted); tampered[tampered.length - 1] = (tampered[tampered.length - 1] ?? 0) ^ 1;
    await expect(provider.decryptToDirectory(tampered, prepared.inputKeyEnvelope, path.join(dir, 'bad'), prepared.inputHash)).rejects.toMatchObject({ code: 'encrypted_payload_hash_mismatch' });
  });
});
