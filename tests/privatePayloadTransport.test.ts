import { afterEach, describe, expect, it, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CaptureStore } from '../src/captures/captureStore.js';
import { ComputeIdentityService } from '../src/compute/computeIdentity.js';
import { PrivatePayloadTransport } from '../src/compute/privatePayloadTransport.js';
import { LocalStore } from '../src/state/localStore.js';
import { syntheticCid } from './fixtures/contentIds.js';
import { canonicalPinCid } from '../src/ipfs/managedPins.js';

const dirs: string[] = [];
afterEach(async () => Promise.all(dirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true }))));

describe('encrypted private compute payload transport', () => {
  it('rejects an unusable provider key before reading or importing private capture data', async () => {
    const captures = { get: vi.fn() };
    const kubo = { addBytes: vi.fn(), pinAdd: vi.fn() };
    const transport = new PrivatePayloadTransport({ captures, kubo, store: {}, identity: {}, dataRoot: '', maxInputBytes: 1024 } as never);
    await expect(transport.encryptCapture('synthetic', 'synthetic-provider', 'invalid-public-key')).rejects.toMatchObject({ code: 'compute_provider_key_invalid' });
    expect(captures.get).not.toHaveBeenCalled();
    expect(kubo.addBytes).not.toHaveBeenCalled();
    expect(kubo.pinAdd).not.toHaveBeenCalled();
  });
  it('refuses to pack a photo, video or mixed capture for a remote provider, whatever the masking setting', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'kubus-private-transport-media-')); dirs.push(dir);
    await fs.mkdir(path.join(dir, 'photos'), { recursive: true });
    await fs.writeFile(path.join(dir, 'photos', 'a.jpg'), 'synthetic-raw-photo');
    const requesterStore = new LocalStore(path.join(dir, 'requester.json')); await requesterStore.load();
    const providerStore = new LocalStore(path.join(dir, 'provider.json')); await providerStore.load();
    const providerPublic = (await new ComputeIdentityService(providerStore).publicIdentity()).encryptionPublicKey;
    const kubo = { addBytes: vi.fn(), pinAdd: vi.fn(), pinLs: vi.fn() };
    const records = [
      { id: 'c-photos', kind: 'photos', directory: dir, faceMasking: { mode: 'premasked' } },
      { id: 'c-video', kind: 'video', directory: dir },
      { id: 'c-mixed', kind: 'mixed', directory: dir, faceMasking: { mode: 'none' } },
      { id: 'c-untyped', directory: dir },
    ];
    const captures = { get: vi.fn((id: string) => records.find((record) => record.id === id)) };
    const transport = new PrivatePayloadTransport({ captures, kubo, store: requesterStore, identity: {}, dataRoot: dir, maxInputBytes: 1024 * 1024 } as never);
    for (const record of records) {
      await expect(transport.encryptCapture(record.id, 'provider-1', providerPublic)).rejects.toMatchObject({ code: 'remote_compute_media_capture_unsupported', statusCode: 422 });
    }
    expect(kubo.addBytes).not.toHaveBeenCalled();
    expect(kubo.pinAdd).not.toHaveBeenCalled();
    expect(requesterStore.snapshot().privateComputeCids ?? {}).toEqual({});
  });
  it('uses X25519 + HKDF + AES-256-GCM and detects tampering', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'kubus-private-transport-')); dirs.push(dir);
    const requesterStore = new LocalStore(path.join(dir, 'requester.json')); await requesterStore.load();
    const providerStore = new LocalStore(path.join(dir, 'provider.json')); await providerStore.load();
    const captures = new CaptureStore(path.join(dir, 'requester'), requesterStore);
    const capture = await captures.create({ schema: 'kubus.capture/1', artworkId: 'art-1', capturedAt: '2026-08-11T00:00:00Z', metadata: { private: true }, files: [{ path: 'rgb/0001.jpg', contentBase64: Buffer.from('private-frame').toString('base64') }] });
    let encrypted = Buffer.alloc(0);
    const cid = syntheticCid('encrypted-synthetic-input');
    const pinAdd = vi.fn(async (value: string) => {
      expect(Object.keys(requesterStore.snapshot().managedPins![value]!.owners)[0]).toMatch(/^requester-input:/);
      expect(requesterStore.snapshot().privateComputeCids![cid]!.pinOwner).toMatch(/^requester-input:/);
    });
    const kubo = { pinLs: async () => ({ Keys: {} }), pinAdd, addBytes: vi.fn(async (bytes: Uint8Array) => { encrypted = Buffer.from(bytes); return { Hash: cid }; }) };
    const requesterIdentity = new ComputeIdentityService(requesterStore); const providerIdentity = new ComputeIdentityService(providerStore);
    const requester = new PrivatePayloadTransport({ captures, kubo: kubo as never, store: requesterStore, identity: requesterIdentity, dataRoot: dir, maxInputBytes: 1024 * 1024 });
    const provider = new PrivatePayloadTransport({ captures, kubo: kubo as never, store: providerStore, identity: providerIdentity, dataRoot: dir, maxInputBytes: 1024 * 1024 });
    const providerPublic = (await providerIdentity.publicIdentity()).encryptionPublicKey;
    const prepared = await requester.encryptCapture(capture.id, 'provider-1', providerPublic);
    expect(kubo.addBytes).toHaveBeenCalledWith(expect.any(Uint8Array), `${capture.id}.kubusenc`, { pin: false });
    expect(pinAdd).toHaveBeenCalledWith(canonicalPinCid(cid));
    expect(prepared.inputKeyEnvelope.algorithm).toBe('X25519-HKDF-SHA256-AES-256-GCM');
    const output = path.join(dir, 'decrypted');
    await provider.decryptToDirectory(encrypted, prepared.inputKeyEnvelope, output, prepared.inputHash, { nodeId: 'provider-1', inputCid: cid });
    expect(await fs.readFile(path.join(output, 'rgb', '0001.jpg'), 'utf8')).toBe('private-frame');
    const tampered = Buffer.from(encrypted); tampered[tampered.length - 1] = (tampered[tampered.length - 1] ?? 0) ^ 1;
    await expect(provider.decryptToDirectory(tampered, prepared.inputKeyEnvelope, path.join(dir, 'bad'), prepared.inputHash, { nodeId: 'provider-1', inputCid: cid })).rejects.toMatchObject({ code: 'encrypted_payload_hash_mismatch' });
  });
  it('only decrypts an input whose key envelope names this provider and this input CID', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'kubus-private-transport-context-')); dirs.push(dir);
    const requesterStore = new LocalStore(path.join(dir, 'requester.json')); await requesterStore.load();
    const providerStore = new LocalStore(path.join(dir, 'provider.json')); await providerStore.load();
    const captures = new CaptureStore(path.join(dir, 'requester'), requesterStore);
    const capture = await captures.create({ schema: 'kubus.capture/1', artworkId: 'art-1', capturedAt: '2026-08-11T00:00:00Z', metadata: { private: true }, files: [{ path: 'rgb/0001.jpg', contentBase64: Buffer.from('private-frame').toString('base64') }] });
    let encrypted = Buffer.alloc(0);
    const cid = syntheticCid('encrypted-synthetic-context-input');
    const kubo = { pinLs: async () => ({ Keys: {} }), pinAdd: vi.fn(), addBytes: vi.fn(async (bytes: Uint8Array) => { encrypted = Buffer.from(bytes); return { Hash: cid }; }) };
    const providerIdentity = new ComputeIdentityService(providerStore);
    const requester = new PrivatePayloadTransport({ captures, kubo: kubo as never, store: requesterStore, identity: new ComputeIdentityService(requesterStore), dataRoot: dir, maxInputBytes: 1024 * 1024 });
    const provider = new PrivatePayloadTransport({ captures, kubo: kubo as never, store: providerStore, identity: providerIdentity, dataRoot: dir, maxInputBytes: 1024 * 1024 });
    const prepared = await requester.encryptCapture(capture.id, 'provider-1', (await providerIdentity.publicIdentity()).encryptionPublicKey);
    const attempt = (expected: { nodeId: string; inputCid: string }, name: string) =>
      provider.decryptToDirectory(encrypted, prepared.inputKeyEnvelope, path.join(dir, name), prepared.inputHash, expected);
    // Wrapped for another provider, or for another input CID: refused before anything is unwrapped or written.
    await expect(attempt({ nodeId: 'provider-2', inputCid: cid }, 'other-node')).rejects.toMatchObject({ code: 'encrypted_payload_context_mismatch' });
    await expect(attempt({ nodeId: 'provider-1', inputCid: syntheticCid('some-other-input') }, 'other-cid')).rejects.toMatchObject({ code: 'encrypted_payload_context_mismatch' });
    await expect(fs.stat(path.join(dir, 'other-node'))).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(fs.stat(path.join(dir, 'other-cid'))).rejects.toMatchObject({ code: 'ENOENT' });
    // An envelope whose own context was rewritten to match is still refused: the key is bound to the context.
    const forged = { ...prepared.inputKeyEnvelope, context: 'provider-2:' + cid };
    await expect(provider.decryptToDirectory(encrypted, forged, path.join(dir, 'forged'), prepared.inputHash, { nodeId: 'provider-2', inputCid: cid })).rejects.toThrow();
    await attempt({ nodeId: 'provider-1', inputCid: cid }, 'right');
    expect(await fs.readFile(path.join(dir, 'right', 'rgb', '0001.jpg'), 'utf8')).toBe('private-frame');
  });
  it('pins the encrypted input under the owner the caller names, so the caller can find it again after a crash', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'kubus-private-transport-owner-')); dirs.push(dir);
    const requesterStore = new LocalStore(path.join(dir, 'requester.json')); await requesterStore.load();
    const providerStore = new LocalStore(path.join(dir, 'provider.json')); await providerStore.load();
    const captures = new CaptureStore(path.join(dir, 'requester'), requesterStore);
    const capture = await captures.create({ schema: 'kubus.capture/1', artworkId: 'art-1', capturedAt: '2026-08-11T00:00:00Z', metadata: { private: true }, files: [{ path: 'rgb/0001.jpg', contentBase64: Buffer.from('x').toString('base64') }] });
    const cid = syntheticCid('encrypted-synthetic-owner-input');
    const kubo = { pinLs: async () => ({ Keys: {} }), pinAdd: vi.fn(), addBytes: vi.fn(async () => ({ Hash: cid })) };
    const requester = new PrivatePayloadTransport({ captures, kubo: kubo as never, store: requesterStore, identity: new ComputeIdentityService(requesterStore), dataRoot: dir, maxInputBytes: 1024 * 1024 });
    const providerPublic = (await new ComputeIdentityService(providerStore).publicIdentity()).encryptionPublicKey;
    await requester.encryptCapture(capture.id, 'provider-1', providerPublic, { pinOwner: 'requester-input:11111111-1111-4111-8111-111111111111' });
    expect(requesterStore.snapshot().privateComputeCids![cid]!.pinOwner).toBe('requester-input:11111111-1111-4111-8111-111111111111');
    await expect(requester.encryptCapture(capture.id, 'provider-1', providerPublic, { pinOwner: 'spatial:not-an-input-owner' })).rejects.toMatchObject({ code: 'requester_input_owner_invalid' });
  });
});
