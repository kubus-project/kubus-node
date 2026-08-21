import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Buffer } from 'node:buffer';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { AppConfig } from '../src/config/schema.js';
import { loadOrCreateNodeIdentity } from '../src/identity/nodeIdentity.js';
import { IdempotencyStore } from '../src/localApi/idempotencyStore.js';
import { dispatchLocalRequest, routeScope, type LocalApiDeps } from '../src/localApi/dispatch.js';
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

