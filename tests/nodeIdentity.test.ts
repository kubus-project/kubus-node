import { afterEach, describe, expect, it, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  formatFingerprint,
  loadOrCreateNodeIdentity,
  nodeFingerprintFromPublicKey,
  verifyNodeSignature,
} from '../src/identity/nodeIdentity.js';
import { LocalStore } from '../src/state/localStore.js';

const dirs: string[] = [];
afterEach(async () => Promise.all(dirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true }))));

async function tempDir(prefix: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

describe('loadOrCreateNodeIdentity', () => {
  it('mints an Ed25519 keypair and persists it in its own file, not state.json', async () => {
    const dir = await tempDir('kubus-identity-');
    const identity = await loadOrCreateNodeIdentity(dir);
    expect(identity.publicKeyRaw).toHaveLength(32);
    expect(identity.fingerprint).toBe(nodeFingerprintFromPublicKey(identity.publicKeyRaw));
    expect(identity.fingerprint).toMatch(/^[0-9a-f]{64}$/);

    const stored = JSON.parse(await fs.readFile(path.join(dir, 'identity.json'), 'utf8')) as {
      version: number; algorithm: string; createdAt: string; privateKey: string; publicKey: string;
    };
    expect(stored.version).toBe(1);
    expect(stored.algorithm).toBe('ed25519');
    expect(stored.publicKey).toBe(identity.publicKeyBase64Url);
    expect(stored.createdAt).toBe(identity.createdAt);
    // state.json is never touched by identity minting at all.
    await expect(fs.access(path.join(dir, 'state.json'))).rejects.toThrow();
  });

  it('reuses one in-process identity for concurrent callers against the same directory', async () => {
    const dir = await tempDir('kubus-identity-concurrent-');
    const [a, b, c] = await Promise.all([
      loadOrCreateNodeIdentity(dir),
      loadOrCreateNodeIdentity(dir),
      loadOrCreateNodeIdentity(dir),
    ]);
    expect(a).toBe(b);
    expect(b).toBe(c);
    const files = await fs.readdir(dir);
    expect(files).toEqual(['identity.json']);
  });

  it('survives an independent reload with a byte-identical fingerprint and public key', async () => {
    const dir = await tempDir('kubus-identity-restart-');
    vi.resetModules();
    const first = await (await import('../src/identity/nodeIdentity.js')).loadOrCreateNodeIdentity(dir);

    // A fresh module instance has an empty in-process cache, so this reload
    // can only succeed by actually reading identity.json back off disk —
    // exactly what happens across a real process restart.
    vi.resetModules();
    const second = await (await import('../src/identity/nodeIdentity.js')).loadOrCreateNodeIdentity(dir);

    expect(second.publicKeyBase64Url).toBe(first.publicKeyBase64Url);
    expect(second.fingerprint).toBe(first.fingerprint);
    expect(second.createdAt).toBe(first.createdAt);
    expect(second.publicKeyRaw).toEqual(first.publicKeyRaw);
  });

  it('resolves a concurrent create race to a single identity instead of corrupting the file', async () => {
    const dir = await tempDir('kubus-identity-race-');
    vi.resetModules();
    const moduleA = await import('../src/identity/nodeIdentity.js');
    vi.resetModules();
    const moduleB = await import('../src/identity/nodeIdentity.js');

    // Two independent module instances (standing in for two racing loaders)
    // both find no identity.json and both generate a keypair; only one may
    // win the file. Exercises the EEXIST fallback in generateAndPersist.
    const [a, b] = await Promise.all([
      moduleA.loadOrCreateNodeIdentity(dir),
      moduleB.loadOrCreateNodeIdentity(dir),
    ]);
    expect(a.publicKeyBase64Url).toBe(b.publicKeyBase64Url);
    expect(a.fingerprint).toBe(b.fingerprint);
    // No leftover temp file from the loser.
    expect(await fs.readdir(dir)).toEqual(['identity.json']);
  });

  it('leaves a pre-existing legacy nodeKey untouched while minting a new Ed25519 identity', async () => {
    const dir = await tempDir('kubus-identity-legacy-');
    const statePath = path.join(dir, 'state.json');
    const store = new LocalStore(statePath);
    await store.load();
    const legacyNodeKey = await store.getOrCreateNodeKey('kubus-node-legacy-upgrade-key');
    const beforeState = await fs.readFile(statePath, 'utf8');

    const identity = await loadOrCreateNodeIdentity(dir);

    expect(identity.publicKeyRaw).toHaveLength(32);
    // registerNode/heartbeat still send the raw legacy key to the backend —
    // identity minting must not read, rewrite, or invalidate it.
    expect(store.snapshot().nodeKey).toBe(legacyNodeKey);
    await expect(fs.readFile(statePath, 'utf8')).resolves.toBe(beforeState);
  });

  it('signs and verifies, and rejects a tampered message, wrong key, or wrong-length signature', async () => {
    const dir = await tempDir('kubus-identity-sign-');
    const identity = await loadOrCreateNodeIdentity(dir);
    const other = await loadOrCreateNodeIdentity(await tempDir('kubus-identity-sign-other-'));
    const message = Buffer.from('kubus-node identity proof fixture', 'utf8');
    const signature = identity.sign(message);

    expect(signature).toHaveLength(64);
    expect(verifyNodeSignature(identity.publicKeyRaw, message, signature)).toBe(true);
    expect(verifyNodeSignature(identity.publicKeyRaw, Buffer.from('tampered'), signature)).toBe(false);
    expect(verifyNodeSignature(other.publicKeyRaw, message, signature)).toBe(false);
    expect(verifyNodeSignature(identity.publicKeyRaw, message, Buffer.alloc(10))).toBe(false);
    expect(verifyNodeSignature(Buffer.alloc(10), message, signature)).toBe(false);
  });

  it('never exposes the private key on the returned identity', async () => {
    const dir = await tempDir('kubus-identity-secret-');
    const identity = await loadOrCreateNodeIdentity(dir);
    const serialized = JSON.stringify(identity);
    expect(serialized).not.toContain('privateKey');
    // `sign` is a function; JSON.stringify silently drops it, so it cannot
    // leak the closed-over private key by accident either.
    expect(Object.keys(JSON.parse(serialized))).not.toContain('sign');
    const stored = JSON.parse(await fs.readFile(path.join(dir, 'identity.json'), 'utf8')) as { privateKey: string };
    expect(serialized).not.toContain(stored.privateKey);
  });
});

describe('formatFingerprint', () => {
  it('uppercases and groups the first 16 hex characters in 4s', () => {
    expect(formatFingerprint('abcdef0123456789fedcba9876543210fedcba9876543210fedcba98765432'))
      .toBe('ABCD EF01 2345 6789');
  });
});
