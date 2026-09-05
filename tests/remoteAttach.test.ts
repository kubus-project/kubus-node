import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import crypto from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AppConfig } from '../src/config/schema.js';
import { loadOrCreateNodeIdentity, type NodeIdentity } from '../src/identity/nodeIdentity.js';
import { authorizationMessage, signRemoteAttach, type NodeAuthorization } from '../src/identity/remoteAttach.js';
import { dispatchLocalRequest, type LocalApiDeps } from '../src/localApi/dispatch.js';
import type { LocalRequest } from '../src/localApi/localRequest.js';
import { PairingService } from '../src/localApi/pairingService.js';
import { LocalStore } from '../src/state/localStore.js';

const opaque = () => crypto.randomBytes(32).toString('base64url');
let dir: string;
let identity: NodeIdentity;
let store: LocalStore;
let grant: NodeAuthorization;
let verifier: string;
let request: LocalRequest;
let deps: LocalApiDeps;
const nodeId = crypto.randomUUID();

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'kubus-remote-attach-'));
  identity = await loadOrCreateNodeIdentity(dir);
  store = new LocalStore(path.join(dir, 'state.json'));
  await store.load();
  await store.update((state) => { state.nodeId = nodeId; });
  verifier = opaque();
  grant = { id: crypto.randomUUID(), nodeId, kind: 'REMOTE_ATTACH', challenge: opaque(),
    expiresAt: new Date(Date.now() + 120000).toISOString(),
    payload: { publicKey: identity.publicKeyBase64Url, sessionId: opaque(), deviceId: opaque(),
      verifierHash: crypto.createHash('sha256').update(verifier).digest('hex') } };
  const config = { nodeLabel: 'Home', localApiEnabled: true } as AppConfig;
  deps = { store, identity, config, pairing: new PairingService(store, config, identity),
    api: { consumeNodeAuthorization: vi.fn(async () => ({ authorized: true, kind: grant.kind,
      nodeId, deviceId: grant.payload.deviceId })) } } as unknown as LocalApiDeps;
  request = { method: 'POST', path: '/local/v1/pairing/remote-attach', query: new URLSearchParams(),
    peer: { kind: 'webrtc', identityHandshakeComplete: true, sessionId: grant.payload.sessionId as string },
    body: { json: vi.fn(async () => ({ authorization: grant, verifier })) } as unknown as LocalRequest['body'] };
});

afterEach(async () => { await fs.rm(dir, { recursive: true, force: true }); });

it('issues a scoped credential directly on the verified channel and persists only its hash', async () => {
  const result = await dispatchLocalRequest(request, deps);
  expect(result.status).toBe(201);
  if (result.kind !== 'json') throw new Error('Expected JSON');
  const credential = (result.value as { token: string }).token;
  expect(credential).toMatch(/^kubus_local_/);
  expect(await deps.pairing.authorize(credential, 'jobs:read')).toBeTruthy();
  expect(await fs.readFile(path.join(dir, 'state.json'), 'utf8')).not.toContain(credential);
  expect(JSON.stringify(vi.mocked(deps.api.consumeNodeAuthorization).mock.calls)).not.toContain(credential);
  expect((await loadOrCreateNodeIdentity(dir)).fingerprint).toBe(identity.fingerprint);
  expect(request.body.json).toHaveBeenCalledWith(16384);
  await expect(dispatchLocalRequest(request, deps)).rejects.toThrow('remote_attach_replayed');
});

it.each(['loopback', 'lan', 'trusted-proxy'] as const)('never exposes remote attach over %s', async (kind) => {
  request.peer.kind = kind;
  await expect(dispatchLocalRequest(request, deps)).rejects.toThrow('remote_attach_verified_channel_required');
  expect(deps.api.consumeNodeAuthorization).not.toHaveBeenCalled();
});

it('does not authorize before the Ed25519 handshake', async () => {
  request.peer.identityHandshakeComplete = false;
  await expect(dispatchLocalRequest(request, deps)).rejects.toThrow('remote_attach_verified_channel_required');
});

it('uses the transport session, never a client-supplied alternate session', async () => {
  request.peer.sessionId = opaque();
  await expect(dispatchLocalRequest(request, deps)).rejects.toThrow('remote_attach_binding_invalid');
  expect(deps.api.consumeNodeAuthorization).not.toHaveBeenCalled();
});

it('backend rejection creates no local credential', async () => {
  vi.mocked(deps.api.consumeNodeAuthorization).mockRejectedValue(new Error('NODE_AUTHORIZATION_REPLAYED'));
  await expect(dispatchLocalRequest(request, deps)).rejects.toThrow('NODE_AUTHORIZATION_REPLAYED');
  expect(Object.keys(store.snapshot().localCredentials ?? {})).toHaveLength(0);
});

it('signs the canonical grant with the existing persistent Ed25519 key', () => {
  const signature = signRemoteAttach(grant, verifier, request.peer.sessionId!, nodeId, identity);
  const key = crypto.createPublicKey({ format: 'jwk', key: { kty: 'OKP', crv: 'Ed25519', x: identity.publicKeyBase64Url } });
  expect(crypto.verify(null, authorizationMessage(grant), key, Buffer.from(signature, 'base64url'))).toBe(true);
  expect(() => signRemoteAttach(grant, opaque(), request.peer.sessionId!, nodeId, identity)).toThrow();
  expect(() => signRemoteAttach({ ...grant, expiresAt: '2000-01-01' }, verifier, request.peer.sessionId!, nodeId, identity)).toThrow();
});
