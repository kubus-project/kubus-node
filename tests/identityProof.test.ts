import { afterEach, describe, expect, it } from 'vitest';
import crypto from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  buildIdentityProofMessage,
  createIdentityProof,
  IDENTITY_PROOF_PROTOCOL_VERSION,
  verifyIdentityProof,
} from '../src/identity/identityProof.js';
import { loadOrCreateNodeIdentity } from '../src/identity/nodeIdentity.js';

const dirs: string[] = [];
afterEach(async () => Promise.all(dirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true }))));

async function identity() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'kubus-identity-proof-'));
  dirs.push(dir);
  return loadOrCreateNodeIdentity(dir);
}

function challenge(overrides: Partial<{ protocolVersion: string; sessionId: string; nonce: Buffer; clientRole: string }> = {}) {
  return {
    protocolVersion: IDENTITY_PROOF_PROTOCOL_VERSION,
    sessionId: 'session-8f14e45f-ea4e-4e2f-9c1a-2b3c4d5e6f70',
    nonce: crypto.randomBytes(32),
    clientRole: 'client',
    ...overrides,
  };
}

describe('buildIdentityProofMessage', () => {
  it('concatenates fields in the documented order with NUL-terminated text and fixed-length binary fields', async () => {
    const node = await identity();
    const input = { ...challenge(), publicKeyRaw: node.publicKeyRaw };
    const message = buildIdentityProofMessage(input);

    const expected = Buffer.concat([
      Buffer.from('kubus-node-identity-proof/v1', 'utf8'), Buffer.from([0x00]),
      Buffer.from(input.protocolVersion, 'utf8'), Buffer.from([0x00]),
      Buffer.from(input.sessionId, 'utf8'), Buffer.from([0x00]),
      input.nonce,
      input.publicKeyRaw,
      Buffer.from(input.clientRole, 'utf8'), Buffer.from([0x00]),
    ]);
    expect(message.equals(expected)).toBe(true);
  });

  it('rejects a nonce or public key that is not exactly 32 bytes', async () => {
    const node = await identity();
    expect(() => buildIdentityProofMessage({ ...challenge({ nonce: Buffer.alloc(31) }), publicKeyRaw: node.publicKeyRaw }))
      .toThrow('identity_proof_nonce_invalid_length');
    expect(() => buildIdentityProofMessage({ ...challenge(), publicKeyRaw: Buffer.alloc(33) }))
      .toThrow('identity_proof_public_key_invalid_length');
  });
});

describe('createIdentityProof / verifyIdentityProof', () => {
  it('round-trips: a proof the node creates verifies against its own public key', async () => {
    const node = await identity();
    const input = challenge();
    const proof = createIdentityProof(node, input);

    expect(proof.publicKeyRaw).toEqual(node.publicKeyRaw);
    expect(proof.fingerprint).toBe(node.fingerprint);
    expect(proof.signature).toHaveLength(64);
    expect(verifyIdentityProof({ ...input, publicKeyRaw: proof.publicKeyRaw, signature: proof.signature })).toBe(true);
  });

  it('rejects a proof replayed against a different session id', async () => {
    const node = await identity();
    const input = challenge();
    const proof = createIdentityProof(node, input);
    expect(verifyIdentityProof({ ...input, sessionId: 'a-different-session', publicKeyRaw: proof.publicKeyRaw, signature: proof.signature }))
      .toBe(false);
  });

  it('rejects a proof replayed against a different nonce', async () => {
    const node = await identity();
    const input = challenge();
    const proof = createIdentityProof(node, input);
    expect(verifyIdentityProof({ ...input, nonce: crypto.randomBytes(32), publicKeyRaw: proof.publicKeyRaw, signature: proof.signature }))
      .toBe(false);
  });

  it('rejects a proof presented under a substituted public key', async () => {
    const node = await identity();
    const impostor = await identity();
    const input = challenge();
    const proof = createIdentityProof(node, input);
    expect(verifyIdentityProof({ ...input, publicKeyRaw: impostor.publicKeyRaw, signature: proof.signature })).toBe(false);
  });

  it('rejects a proof signed for a different protocol version (domain separation)', async () => {
    const node = await identity();
    const input = challenge();
    const proof = createIdentityProof(node, input);
    expect(verifyIdentityProof({ ...input, protocolVersion: 'some-other-protocol/1', publicKeyRaw: proof.publicKeyRaw, signature: proof.signature }))
      .toBe(false);
  });

  it('rejects a client-role proof reflected back as a node-role proof', async () => {
    const node = await identity();
    const clientProof = createIdentityProof(node, challenge({ clientRole: 'client' }));
    const asNodeRole = challenge({ clientRole: 'node' });
    expect(verifyIdentityProof({ ...asNodeRole, publicKeyRaw: clientProof.publicKeyRaw, signature: clientProof.signature }))
      .toBe(false);
  });

  it('rejects malformed shapes before touching the cryptographic verifier', async () => {
    const node = await identity();
    const proof = createIdentityProof(node, challenge());
    const base = { ...challenge(), publicKeyRaw: proof.publicKeyRaw, signature: proof.signature };
    expect(verifyIdentityProof({ ...base, nonce: Buffer.alloc(16) })).toBe(false);
    expect(verifyIdentityProof({ ...base, publicKeyRaw: Buffer.alloc(16) })).toBe(false);
    expect(verifyIdentityProof({ ...base, signature: Buffer.alloc(32) })).toBe(false);
  });
});
