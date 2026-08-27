import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Buffer } from 'node:buffer';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { AppConfig } from '../src/config/schema.js';
import { loadOrCreateNodeIdentity } from '../src/identity/nodeIdentity.js';
import { IdempotencyStore } from '../src/localApi/idempotencyStore.js';
import {
  dispatchLocalRequest,
  routeScope,
  AdmissionLimiter,
  HTTP_IDENTITY_SESSION_ID,
  type LocalApiDeps,
} from '../src/localApi/dispatch.js';
import { IDENTITY_PROOF_PROTOCOL_VERSION, verifyIdentityProof } from '../src/identity/identityProof.js';
import type { LocalPeer, LocalRequest, LocalRequestBody } from '../src/localApi/localRequest.js';
import { LOCAL_SCOPES, PairingService } from '../src/localApi/pairingService.js';
import { LocalStore } from '../src/state/localStore.js';

/**
 * The dispatcher is the single place that decides what a Node operation means
 * and who may perform it. These tests exercise it directly, without a socket,
 * because the property that matters is that the answer does not depend on
 * which transport asked.
 */

const jsonBody = (value: unknown): LocalRequestBody => {
  let read = false;
  const claim = () => {
    if (read) throw new Error('body already read');
    read = true;
  };
  return {
    async json() {
      claim();
      return (value ?? {}) as Record<string, unknown>;
    },
    async binary() {
      claim();
      return Buffer.from(JSON.stringify(value ?? {}));
    },
    stream() {
      claim();
      return (async function* () {
        yield Buffer.from(JSON.stringify(value ?? {}));
      })();
    },
  };
};

const verifiedPeer: LocalPeer = { kind: 'loopback', address: '127.0.0.1', identityHandshakeComplete: true };
const unverifiedWebRtcPeer: LocalPeer = { kind: 'webrtc', identityHandshakeComplete: false, sessionId: 'session-1' };

function request(overrides: Partial<LocalRequest> & Pick<LocalRequest, 'method' | 'path'>): LocalRequest {
  return {
    query: new URLSearchParams(),
    body: jsonBody({}),
    peer: verifiedPeer,
    ...overrides,
  };
}

describe('route scope mapping', () => {
  it('assigns every canonical prefix a scope from the declared set', () => {
    // Both transports read this mapping. Asserting it in one place is what
    // stops the HTTP and WebRTC paths from disagreeing about what a route costs.
    const expected: Array<[string, string]> = [
      ['/local/v1/content/bafy', 'content:read'],
      ['/local/v1/captures', 'captures:read'],
      ['/local/v1/captures/drafts/d1/commit', 'captures:read'],
      ['/local/v1/jobs', 'jobs:read'],
      ['/local/v1/jobs/j1/cancel', 'jobs:read'],
      ['/local/v1/spatial/s1', 'spatial:read'],
      ['/local/v1/compute/jobs', 'jobs:read'],
      ['/local/v1/info', 'content:read'],
    ];
    for (const [routePath, scope] of expected) {
      expect(routeScope(routePath), routePath).toBe(scope);
      expect(LOCAL_SCOPES).toContain(routeScope(routePath));
    }
  });
});

describe('dispatchLocalRequest', () => {
  let dir: string;
  let deps: LocalApiDeps;
  let token: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'kubus-dispatch-'));
    const store = new LocalStore(path.join(dir, 'state.json'));
    await store.load();
    const identity = await loadOrCreateNodeIdentity(dir);
    const config = {
      localApiEnabled: true,
      // A pairing session needs at least one advertisable endpoint.
      localApiAllowLan: true,
      localApiLanUrl: 'http://192.168.1.10:8787',
      localApiRemoteUrl: undefined,
      localApiTrustedProxyAddresses: [],
      guiToken: 'gui-administrator-token',
      nodeLabel: 'TEST-NODE',
      nodeKey: undefined,
      pairingSessionTtlMs: 300_000,
      maxPinnedBytes: 0,
      maxPinnedCids: 0,
    } as unknown as AppConfig;
    const pairing = new PairingService(store, config, identity);

    deps = {
      api: {} as never,
      kubo: { repoStat: async () => ({ RepoSize: 0, StorageMax: 0 }) } as never,
      store,
      config,
      capabilities: {
        refreshIfStale: async () => [],
        getWorkerHealth: () => ({ status: 'unknown' }),
      } as never,
      pairing,
      captures: { list: () => [] } as never,
      jobs: { health: () => ({ running: 0, queued: 0 }), list: () => [] } as never,
      participationGate: {
        refresh: async () => ({ state: 'CONTRIBUTING', leaseEligible: true }),
        assertUsefulOperation: async () => undefined,
      } as never,
      remoteCompute: {} as never,
      identity,
      idempotency: new IdempotencyStore(),
    };

    const session = await pairing.createSession();
    const exchanged = await pairing.exchange(session.sessionId, session.secret, 'test device');
    token = exchanged.token;
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  });

  it('refuses an unauthenticated caller before doing any work', async () => {
    await expect(
      dispatchLocalRequest(request({ method: 'GET', path: '/local/v1/info' }), deps),
    ).rejects.toMatchObject({ statusCode: 401, code: 'local_credential_required' });
  });

  it('serves the node identity to an authenticated, verified caller', async () => {
    const response = await dispatchLocalRequest(
      request({ method: 'GET', path: '/local/v1/info', credential: token }),
      deps,
    );
    expect(response.kind).toBe('json');
    const value = (response as { value: Record<string, unknown> }).value;
    expect(value.identityAlgorithm).toBe('ed25519');
    expect(value.publicKey).toBe(deps.identity.publicKeyBase64Url);
    expect(value.fingerprint).toBe(deps.identity.fingerprint);
  });

  it('refuses a data-channel peer that has not proved the node identity', async () => {
    // ICE and DTLS prove a channel exists, never who is on the far end of it.
    // A valid credential does not change that — a stolen credential is exactly
    // the case this guards.
    await expect(
      dispatchLocalRequest(
        request({
          method: 'GET',
          path: '/local/v1/info',
          credential: token,
          peer: unverifiedWebRtcPeer,
        }),
        deps,
      ),
    ).rejects.toMatchObject({ statusCode: 403, code: 'node_identity_proof_required' });
  });

  it('serves the same operation to a data-channel peer once it has been verified', async () => {
    const response = await dispatchLocalRequest(
      request({
        method: 'GET',
        path: '/local/v1/info',
        credential: token,
        peer: { ...unverifiedWebRtcPeer, identityHandshakeComplete: true },
      }),
      deps,
    );
    expect(response.status).toBe(200);
  });

  it('requires the administrator credential to mint a pairing session, on any transport', async () => {
    // A public reverse proxy legitimately connects from loopback and a WebRTC
    // peer has no address at all, so the peer can never be the evidence here.
    await expect(
      dispatchLocalRequest(
        request({ method: 'POST', path: '/local/v1/pairing/session', credential: token }),
        deps,
      ),
    ).rejects.toMatchObject({ statusCode: 401, code: 'pairing_activation_required' });

    const minted = await dispatchLocalRequest(
      request({
        method: 'POST',
        path: '/local/v1/pairing/session',
        credential: 'gui-administrator-token',
      }),
      deps,
    );
    expect(minted.status).toBe(201);
  });

  it('does not disclose which pairing credential check failed', async () => {
    await expect(
      dispatchLocalRequest(
        request({
          method: 'POST',
          path: '/local/v1/pairing/exchange',
          body: jsonBody({ sessionId: 'nope', secret: 'wrong' }),
        }),
        deps,
      ),
    ).rejects.toMatchObject({ statusCode: 401, code: 'pairing_exchange_failed' });
  });

  it('rejects an unknown route rather than falling through to something else', async () => {
    await expect(
      dispatchLocalRequest(
        request({ method: 'GET', path: '/local/v1/definitely-not-a-route', credential: token }),
        deps,
      ),
    ).rejects.toMatchObject({ statusCode: 404, code: 'local_route_not_found' });
  });

  it('refuses a path outside the canonical namespace', async () => {
    await expect(
      dispatchLocalRequest(request({ method: 'GET', path: '/webrtc/v1/info', credential: token }), deps),
    ).rejects.toMatchObject({ statusCode: 404 });
  });

  it('replays a keyed mutation instead of performing it twice', async () => {
    // The duplicate-capture case, at the dispatcher rather than in the store:
    // a commit whose response was lost must not commit again.
    let commits = 0;
    deps.captures = {
      list: () => [],
      commitDraft: async () => {
        commits += 1;
        return { id: `capture-${commits}` };
      },
    } as never;

    const send = () =>
      dispatchLocalRequest(
        request({
          method: 'POST',
          path: '/local/v1/captures/drafts/d1/commit',
          credential: token,
          idempotencyKey: 'capture.commit.draft-d1',
        }),
        deps,
      );

    const first = await send();
    const second = await send();

    expect(commits).toBe(1);
    expect((second as { value: unknown }).value).toEqual((first as { value: unknown }).value);
  });

  it('performs a keyless mutation every time it is asked to', async () => {
    // Without a key the node cannot deduplicate, so it must not pretend to.
    // The client's own rule is the other half of this: an unkeyed mutation is
    // never retried on another transport.
    let commits = 0;
    deps.captures = {
      list: () => [],
      commitDraft: async () => {
        commits += 1;
        return { id: `capture-${commits}` };
      },
    } as never;

    const send = () =>
      dispatchLocalRequest(
        request({
          method: 'POST',
          path: '/local/v1/captures/drafts/d1/commit',
          credential: token,
        }),
        deps,
      );

    await send();
    await send();
    expect(commits).toBe(2);
  });

  it('treats a blank key as no key rather than as a key that matches everything', async () => {
    let commits = 0;
    deps.captures = {
      list: () => [],
      commitDraft: async () => {
        commits += 1;
        return { id: `capture-${commits}` };
      },
    } as never;

    for (const blank of ['', '   ']) {
      await dispatchLocalRequest(
        request({
          method: 'POST',
          path: '/local/v1/captures/drafts/d1/commit',
          credential: token,
          idempotencyKey: blank,
        }),
        deps,
      );
    }
    expect(commits).toBe(2);
  });

  it('lets a deliberate retry work after the first attempt genuinely failed', async () => {
    let attempts = 0;
    deps.captures = {
      list: () => [],
      commitDraft: async () => {
        attempts += 1;
        if (attempts === 1) throw new Error('disk full');
        return { id: 'capture-after-retry' };
      },
    } as never;

    const send = () =>
      dispatchLocalRequest(
        request({
          method: 'POST',
          path: '/local/v1/captures/drafts/d1/commit',
          credential: token,
          idempotencyKey: 'capture.commit.draft-d1',
        }),
        deps,
      );

    await expect(send()).rejects.toThrow('disk full');
    const recovered = await send();
    expect((recovered as { value: unknown }).value).toEqual({ id: 'capture-after-retry' });
  });

  it('does not deduplicate reads', async () => {
    // A GET has no effect to duplicate, and caching one here would serve stale
    // status to a client polling for a job to finish.
    const first = await dispatchLocalRequest(
      request({ method: 'GET', path: '/local/v1/participation', credential: token }),
      deps,
    );
    expect(first.status).toBe(200);
    const second = await dispatchLocalRequest(
      request({ method: 'GET', path: '/local/v1/participation', credential: token }),
      deps,
    );
    expect(second.status).toBe(200);
  });

  it('refuses every route when the local API is disabled', async () => {
    (deps.config as { localApiEnabled: boolean }).localApiEnabled = false;
    await expect(
      dispatchLocalRequest(request({ method: 'GET', path: '/local/v1/info', credential: token }), deps),
    ).rejects.toMatchObject({ statusCode: 503, code: 'local_api_disabled' });
  });
});

/**
 * The HTTP identity proof.
 *
 * The app must decide whether the machine that answered is the Node it paired
 * with *before* it sends the Node credential or a private capture. It cannot
 * present the credential to find out, so this route has to answer without one
 * -- and it has to answer with something an impostor could not produce. The
 * node id, fingerprint and public key are all printed in the pairing QR, so
 * echoing them proves nothing; only a signature over the caller's own nonce
 * does.
 */
/** The exact shape the proof route returns, so the strict check config does not see every field as possibly absent. */
interface ProofResponse {
  protocolVersion: string;
  sessionId: string;
  nodeId: string;
  fingerprint: string;
  publicKey: string;
  signature: string;
}

describe('POST /local/v1/identity/proof', () => {
  let dir: string;
  let deps: LocalApiDeps;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'kubus-identity-'));
    const store = new LocalStore(path.join(dir, 'state.json'));
    await store.load();
    const identity = await loadOrCreateNodeIdentity(dir);
    const config = {
      localApiEnabled: true,
      localApiAllowLan: true,
      localApiLanUrl: 'http://192.168.1.10:8787',
      localApiTrustedProxyAddresses: [],
      guiToken: 'gui-administrator-token',
      nodeLabel: 'SECRET-LABEL',
      pairingSessionTtlMs: 300_000,
    } as unknown as AppConfig;
    deps = {
      api: {} as never,
      kubo: {} as never,
      store,
      config,
      capabilities: {} as never,
      pairing: new PairingService(store, config, identity),
      captures: {} as never,
      jobs: {} as never,
      participationGate: {} as never,
      remoteCompute: {} as never,
      identity,
      idempotency: new IdempotencyStore(),
    };
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  });

  const proofRequest = (body: unknown) =>
    request({ method: 'POST', path: '/local/v1/identity/proof', body: jsonBody(body) });

  const freshNonce = () => Buffer.from(Array.from({ length: 32 }, (_, i) => (i * 7 + 3) % 256));

  it('answers an unauthenticated caller, because proving identity is what comes before trust', async () => {
    const response = await dispatchLocalRequest(
      proofRequest({ protocolVersion: IDENTITY_PROOF_PROTOCOL_VERSION, nonce: freshNonce().toString('base64') }),
      deps,
    );
    expect(response.kind).toBe('json');
    expect((response as { status: number }).status).toBe(200);
  });

  it('signs the nonce the caller chose, using the key recorded at pairing', async () => {
    const nonce = freshNonce();
    const response = await dispatchLocalRequest(
      proofRequest({ protocolVersion: IDENTITY_PROOF_PROTOCOL_VERSION, nonce: nonce.toString('base64') }),
      deps,
    );
    const value = (response as { value: ProofResponse }).value;

    // Verified the way the app verifies it: against the key recorded at
    // pairing, over the canonical message, never against the key the response
    // supplied for itself.
    expect(
      verifyIdentityProof({
        publicKeyRaw: deps.identity.publicKeyRaw,
        signature: Buffer.from(value.signature, 'base64'),
        protocolVersion: IDENTITY_PROOF_PROTOCOL_VERSION,
        sessionId: HTTP_IDENTITY_SESSION_ID,
        nonce,
        clientRole: 'client',
      }),
    ).toBe(true);
  });

  it('does not verify against a different nonce, so a captured proof cannot be replayed', async () => {
    const nonce = freshNonce();
    const response = await dispatchLocalRequest(
      proofRequest({ protocolVersion: IDENTITY_PROOF_PROTOCOL_VERSION, nonce: nonce.toString('base64') }),
      deps,
    );
    const value = (response as { value: ProofResponse }).value;
    const otherNonce = Buffer.alloc(32, 9);
    expect(
      verifyIdentityProof({
        publicKeyRaw: deps.identity.publicKeyRaw,
        signature: Buffer.from(value.signature, 'base64'),
        protocolVersion: IDENTITY_PROOF_PROTOCOL_VERSION,
        sessionId: HTTP_IDENTITY_SESSION_ID,
        nonce: otherNonce,
        clientRole: 'client',
      }),
    ).toBe(false);
  });

  it('binds a transport-specific session id, keeping HTTP and data-channel proofs disjoint', async () => {
    const nonce = freshNonce();
    const response = await dispatchLocalRequest(
      proofRequest({ protocolVersion: IDENTITY_PROOF_PROTOCOL_VERSION, nonce: nonce.toString('base64') }),
      deps,
    );
    const value = (response as { value: ProofResponse }).value;
    expect(value.sessionId).toBe(HTTP_IDENTITY_SESSION_ID);
    // The same signature must not verify under a signalling session id.
    expect(
      verifyIdentityProof({
        publicKeyRaw: deps.identity.publicKeyRaw,
        signature: Buffer.from(value.signature, 'base64'),
        protocolVersion: IDENTITY_PROOF_PROTOCOL_VERSION,
        sessionId: 'session-1',
        nonce,
        clientRole: 'client',
      }),
    ).toBe(false);
  });

  it('discloses only identity, never the deployment description', async () => {
    const response = await dispatchLocalRequest(
      proofRequest({ protocolVersion: IDENTITY_PROOF_PROTOCOL_VERSION, nonce: freshNonce().toString('base64') }),
      deps,
    );
    const value = (response as { value: Record<string, unknown> }).value;
    expect(Object.keys(value).sort()).toEqual(
      ['fingerprint', 'nodeId', 'protocolVersion', 'publicKey', 'sessionId', 'signature'].sort(),
    );
    // /local/v1/info carries these; this route must not.
    expect(value.label).toBeUndefined();
    expect(value.endpoints).toBeUndefined();
    expect(value.version).toBeUndefined();
    expect(value.peerId).toBeUndefined();
    expect(JSON.stringify(value)).not.toContain('SECRET-LABEL');
  });

  it('is not served over a data channel, so an HTTP proof cannot be relayed', async () => {
    // ChannelServer forwards canonical paths straight to this dispatcher, and
    // this route sits ahead of the channel's own identity handshake. Without
    // the transport check a peer could relay an HTTP verifier's nonce over a
    // data channel and hand back a proof bound to `local-http/v1` — exactly the
    // separation the session id exists to keep.
    const webRtcPeer: LocalPeer = { kind: 'webrtc', identityHandshakeComplete: false, sessionId: 'session-1' };
    await expect(
      dispatchLocalRequest(
        request({
          method: 'POST',
          path: '/local/v1/identity/proof',
          peer: webRtcPeer,
          body: jsonBody({ protocolVersion: IDENTITY_PROOF_PROTOCOL_VERSION, nonce: freshNonce().toString('base64') }),
        }),
        deps,
      ),
    ).rejects.toMatchObject({ statusCode: 404, code: 'local_route_not_found' });
  });

  it('refuses a nonce that is not 32 bytes, before signing anything', async () => {
    await expect(
      dispatchLocalRequest(
        proofRequest({ protocolVersion: IDENTITY_PROOF_PROTOCOL_VERSION, nonce: Buffer.alloc(8).toString('base64') }),
        deps,
      ),
    ).rejects.toMatchObject({ statusCode: 400, code: 'identity_nonce_invalid' });
  });

  it('refuses a protocol version it does not implement', async () => {
    await expect(
      dispatchLocalRequest(proofRequest({ protocolVersion: 'kubus-node/99', nonce: freshNonce().toString('base64') }), deps),
    ).rejects.toMatchObject({ statusCode: 400, code: 'identity_protocol_version_unsupported' });
  });
});

/**
 * The proof route answers every well-formed challenge, so it has no
 * authentication-failure signal to meter on. PairingAttemptLimiter charges only
 * its global counter from assertAllowed and moves a client's own bucket solely
 * in failed(), which means a per-client ceiling attached to this route would
 * never bind. These cover the limiter that replaced it.
 */
describe('AdmissionLimiter', () => {
  it('binds the per-client ceiling', () => {
    const limiter = new AdmissionLimiter(3, 60_000, 16, 100);
    for (let i = 0; i < 3; i++) limiter.assertAllowed('a', 1_000);
    expect(() => limiter.assertAllowed('a', 1_000)).toThrow(
      expect.objectContaining({ statusCode: 429 }),
    );
  });

  it('does not let a refused client keep spending the shared allowance', () => {
    // The property that matters. If the global counter were charged before the
    // per-client ceiling was checked, one flooding caller would still drain the
    // process-wide budget and 429 everybody else while being refused itself.
    const limiter = new AdmissionLimiter(2, 60_000, 16, 4);
    for (let i = 0; i < 2; i++) limiter.assertAllowed('flooder', 1_000);
    for (let i = 0; i < 20; i++) {
      expect(() => limiter.assertAllowed('flooder', 1_000)).toThrow();
    }
    // Two of the four global admissions are still unspent. Had the refusals
    // charged the global counter, these twenty would have exhausted it and this
    // unrelated device would be refused something it never used.
    expect(() => limiter.assertAllowed('someone-else', 1_000)).not.toThrow();
    expect(() => limiter.assertAllowed('someone-else', 1_000)).not.toThrow();
  });

  it('binds the process-wide ceiling across distinct clients', () => {
    const limiter = new AdmissionLimiter(10, 60_000, 16, 3);
    limiter.assertAllowed('a', 1_000);
    limiter.assertAllowed('b', 1_000);
    limiter.assertAllowed('c', 1_000);
    expect(() => limiter.assertAllowed('d', 1_000)).toThrow(
      expect.objectContaining({ statusCode: 429 }),
    );
  });

  it('lets both ceilings recover once the window rolls over', () => {
    const limiter = new AdmissionLimiter(1, 60_000, 16, 1);
    limiter.assertAllowed('a', 1_000);
    expect(() => limiter.assertAllowed('a', 1_000)).toThrow();
    expect(() => limiter.assertAllowed('a', 1_000 + 60_000)).not.toThrow();
  });

  it('bounds how many clients it tracks', () => {
    const limiter = new AdmissionLimiter(1, 60_000, 2, 1000);
    for (let i = 0; i < 50; i++) limiter.assertAllowed(`client-${i}`, 1_000);
    // Evicting the oldest is what keeps this from being a memory-growth vector
    // for an unauthenticated route; the earliest key is no longer remembered.
    expect(() => limiter.assertAllowed('client-0', 1_000)).not.toThrow();
  });
});
