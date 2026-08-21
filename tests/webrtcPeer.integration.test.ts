import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Buffer } from 'node:buffer';
import crypto from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PeerConnection, cleanup as cleanupWebRtc } from 'node-datachannel';
import type { AppConfig } from '../src/config/schema.js';
import { loadOrCreateNodeIdentity } from '../src/identity/nodeIdentity.js';
import {
  IDENTITY_PROOF_PROTOCOL_VERSION,
  verifyIdentityProof,
} from '../src/identity/identityProof.js';
import { IdempotencyStore } from '../src/localApi/idempotencyStore.js';
import type { LocalApiDeps } from '../src/localApi/dispatch.js';
import { PairingService } from '../src/localApi/pairingService.js';
import { LocalStore } from '../src/state/localStore.js';
import { CHANNEL_PROTOCOL, NodePeer } from '../src/webrtc/nodePeer.js';
import {
  FLAG_FINAL,
  FrameType,
  decodeFrame,
  encodeFrame,
  isFinalFrame,
} from '../src/webrtc/frameCodec.js';

/**
 * End to end over a real WebRTC connection.
 *
 * Everything below this point in the stack has unit tests against fakes, which
 * is where the protocol's real risk lives. What a fake cannot show is that the
 * pieces fit: that a genuine ICE negotiation completes, that a real data
 * channel carries our framing intact, that the identity challenge is answered
 * over that channel, and that a dispatched operation comes back correctly. Two
 * real `PeerConnection`s in one process is the smallest arrangement that
 * proves it.
 */

/** A minimal client speaking the same wire protocol the Flutter app speaks. */
class TestClient {
  private nextRequestId = 1;
  private readonly pending = new Map<
    number,
    {
      resolve: (value: { status: number; body: string }) => void;
      reject: (error: Error) => void;
      chunks: Buffer[];
      status?: number;
    }
  >();

  constructor(private readonly send: (data: Buffer) => void) {}

  handleMessage(data: Buffer): void {
    const frame = decodeFrame(data);
    const entry = this.pending.get(frame.requestId);
    if (!entry) return;
    if (frame.type === FrameType.Error) {
      entry.reject(new Error(String(frame.metadata?.message ?? 'peer error')));
      this.pending.delete(frame.requestId);
      return;
    }
    if (frame.type === FrameType.ResponseHead) {
      entry.status = Number(frame.metadata?.status ?? 200);
    }
    if (frame.payload) entry.chunks.push(frame.payload);
    if (isFinalFrame(frame)) {
      entry.resolve({
        status: entry.status ?? 200,
        body: Buffer.concat(entry.chunks).toString('utf8'),
      });
      this.pending.delete(frame.requestId);
    }
  }

  request(options: {
    method: string;
    path: string;
    credential?: string;
    idempotencyKey?: string;
    json?: Record<string, unknown>;
    nonce?: Buffer;
    query?: Record<string, string>;
  }): Promise<{ status: number; body: string }> {
    const id = this.nextRequestId;
    this.nextRequestId += 1;
    const promise = new Promise<{ status: number; body: string }>((resolve, reject) => {
      this.pending.set(id, { resolve, reject, chunks: [] });
      const timer = setTimeout(() => {
        if (this.pending.delete(id)) reject(new Error(`request ${options.path} timed out`));
      }, 15_000);
      timer.unref?.();
    });
    this.send(
      encodeFrame({
        type: FrameType.RequestHead,
        requestId: id,
        flags: FLAG_FINAL,
        metadata: {
          method: options.method,
          path: options.path,
          ...(options.query ? { query: options.query } : {}),
          ...(options.credential
            ? { headers: { Authorization: `Bearer ${options.credential}` } }
            : {}),
          ...(options.idempotencyKey !== undefined
            ? { idempotencyKey: options.idempotencyKey }
            : {}),
          ...(options.json ? { json: options.json } : {}),
          ...(options.nonce
            ? {
                nonce: options.nonce.toString('base64'),
                protocolVersion: IDENTITY_PROOF_PROTOCOL_VERSION,
              }
            : {}),
        },
      }),
    );
    return promise;
  }
}

interface Harness {
  client: TestClient;
  peer: NodePeer;
  clientConnection: PeerConnection;
  credential: string;
  deps: LocalApiDeps;
  sessionId: string;
  identityFingerprint: string;
  identityPublicKey: Buffer;
  commitCount: () => number;
}

describe('node WebRTC peer, end to end', () => {
  const dirs: string[] = [];
  let harness: Harness;

  const build = async (): Promise<Harness> => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'kubus-rtc-'));
    dirs.push(dir);

    const store = new LocalStore(path.join(dir, 'state.json'));
    await store.load();
    const identity = await loadOrCreateNodeIdentity(dir);

    const config = {
      localApiEnabled: true,
      localApiAllowLan: true,
      localApiLanUrl: 'http://192.168.1.10:8787',
      localApiRemoteUrl: undefined,
      localApiTrustedProxyAddresses: [],
      guiToken: 'gui-administrator-token',
      nodeLabel: 'RTC-TEST-NODE',
      pairingSessionTtlMs: 300_000,
      maxPinnedBytes: 0,
      maxPinnedCids: 0,
    } as unknown as AppConfig;

    const pairing = new PairingService(store, config, identity);
    let commits = 0;

    const deps: LocalApiDeps = {
      api: {} as never,
      kubo: { repoStat: async () => ({ RepoSize: 0, StorageMax: 0 }) } as never,
      store,
      config,
      capabilities: {
        refreshIfStale: async () => [],
        getWorkerHealth: () => ({ status: 'unknown' }),
      } as never,
      pairing,
      captures: {
        list: () => [],
        commitDraft: async () => {
          commits += 1;
          return { id: `capture-${commits}` };
        },
      } as never,
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
    const exchanged = await pairing.exchange(session.sessionId, session.secret, 'rtc test device');

    const sessionId = crypto.randomUUID();
    const clientConnection = new PeerConnection('test-client', { iceServers: [] });

    const peer = new NodePeer({
      sessionId,
      iceServers: [],
      deps,
      identity,
      onLocalDescription: (sdp, type) => clientConnection.setRemoteDescription(sdp, type as never),
      onLocalCandidate: (candidate, mid) => clientConnection.addRemoteCandidate(candidate, mid),
    });

    clientConnection.onLocalDescription((sdp, type) => peer.setRemoteDescription(sdp, type));
    clientConnection.onLocalCandidate((candidate, mid) => peer.addRemoteCandidate(candidate, mid));

    // Ordered and fully reliable is the default and what the protocol requires:
    // `unordered` absent/false, and no maxRetransmits/maxPacketLifeTime.
    const channel = clientConnection.createDataChannel('kubus', {
      protocol: CHANNEL_PROTOCOL,
      unordered: false,
    });
    const client = new TestClient((data) => channel.sendMessageBinary(data));
    channel.onMessage((message) => {
      if (typeof message === 'string') return;
      client.handleMessage(
        Buffer.isBuffer(message) ? message : Buffer.from(new Uint8Array(message)),
      );
    });

    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('data channel never opened')), 20_000);
      timer.unref?.();
      if (channel.isOpen()) {
        clearTimeout(timer);
        resolve();
        return;
      }
      channel.onOpen(() => {
        clearTimeout(timer);
        resolve();
      });
    });

    return {
      client,
      peer,
      clientConnection,
      credential: exchanged.token,
      deps,
      sessionId,
      identityFingerprint: identity.fingerprint,
      identityPublicKey: identity.publicKeyRaw,
      commitCount: () => commits,
    };
  };

  const verify = () =>
    harness.client.request({
      method: 'POST',
      path: '/local/v1/identity/challenge',
      nonce: crypto.randomBytes(32),
    });

  beforeEach(async () => {
    harness = await build();
  }, 40_000);

  afterEach(() => {
    harness?.peer.close();
    try {
      harness?.clientConnection.close();
    } catch {
      // Already closed.
    }
  });

  afterAll(async () => {
    cleanupWebRtc();
    await Promise.all(
      dirs.map((dir) => rm(dir, { recursive: true, force: true }).catch(() => undefined)),
    );
  });

  it('refuses a privileged operation before the identity challenge is answered', async () => {
    // A data channel proves a channel exists, never who opened it. A valid
    // credential does not change that — a stolen credential is exactly this case.
    const response = await harness.client.request({
      method: 'GET',
      path: '/local/v1/info',
      credential: harness.credential,
    });
    expect(response.status).toBe(403);
    expect(response.body).toContain('node_identity_proof_required');
  });

  it('answers the challenge with a signature the client can verify against the paired key', async () => {
    const nonce = crypto.randomBytes(32);
    const response = await harness.client.request({
      method: 'POST',
      path: '/local/v1/identity/challenge',
      nonce,
    });
    expect(response.status).toBe(200);

    const proof = JSON.parse(response.body).data as {
      publicKey: string;
      fingerprint: string;
      signature: string;
      sessionId: string;
      protocolVersion: string;
    };

    // The client checks against the key it learned at pairing time, not
    // against whatever the peer just claimed.
    expect(Buffer.from(proof.publicKey, 'base64url').equals(harness.identityPublicKey)).toBe(true);
    expect(proof.fingerprint).toBe(harness.identityFingerprint);

    expect(
      verifyIdentityProof({
        publicKeyRaw: harness.identityPublicKey,
        signature: Buffer.from(proof.signature, 'base64'),
        protocolVersion: IDENTITY_PROOF_PROTOCOL_VERSION,
        sessionId: proof.sessionId,
        nonce,
        clientRole: 'client',
      }),
    ).toBe(true);

    // The same signature must not verify against a different nonce or session.
    expect(
      verifyIdentityProof({
        publicKeyRaw: harness.identityPublicKey,
        signature: Buffer.from(proof.signature, 'base64'),
        protocolVersion: IDENTITY_PROOF_PROTOCOL_VERSION,
        sessionId: proof.sessionId,
        nonce: crypto.randomBytes(32),
        clientRole: 'client',
      }),
    ).toBe(false);
    expect(
      verifyIdentityProof({
        publicKeyRaw: harness.identityPublicKey,
        signature: Buffer.from(proof.signature, 'base64'),
        protocolVersion: IDENTITY_PROOF_PROTOCOL_VERSION,
        sessionId: 'some-other-session',
        nonce,
        clientRole: 'client',
      }),
    ).toBe(false);
  });

  it('serves canonical /local/v1 operations once verified', async () => {
    await verify();

    const info = await harness.client.request({
      method: 'GET',
      path: '/local/v1/info',
      credential: harness.credential,
    });
    expect(info.status).toBe(200);
    const data = JSON.parse(info.body).data as Record<string, unknown>;
    // Identical semantics to the HTTP rung: same path, same envelope, same
    // fields. Nothing above the transport can tell which rung it used.
    expect(data.apiVersion).toBe('local/v1');
    expect(data.identityAlgorithm).toBe('ed25519');
    expect(data.fingerprint).toBe(harness.identityFingerprint);

    const status = await harness.client.request({
      method: 'GET',
      path: '/local/v1/status',
      credential: harness.credential,
    });
    expect(status.status).toBe(200);
  });

  it('still refuses an unauthenticated caller over the data channel', async () => {
    await verify();
    const response = await harness.client.request({ method: 'GET', path: '/local/v1/info' });
    expect(response.status).toBe(401);
  });

  it('deduplicates a keyed mutation carried over the data channel', async () => {
    // The whole point of the ladder: the same commit retried on a different
    // rung must not produce a second capture.
    await verify();

    const commit = () =>
      harness.client.request({
        method: 'POST',
        path: '/local/v1/captures/drafts/d1/commit',
        credential: harness.credential,
        idempotencyKey: 'capture.commit.draft-d1',
      });

    const first = await commit();
    const second = await commit();

    expect(first.status).toBe(201);
    expect(harness.commitCount()).toBe(1);
    expect(second.body).toBe(first.body);
  });

  it('reports an unknown route as 404 rather than dropping the request', async () => {
    await verify();
    const response = await harness.client.request({
      method: 'GET',
      path: '/local/v1/not-a-route',
      credential: harness.credential,
    });
    expect(response.status).toBe(404);
  });

  it('reaches a connected state over a real ICE negotiation', () => {
    expect(harness.peer.currentState).toBe('connected');
    // No relay is configured here, so a relayed pair would mean the detection
    // is wrong rather than that a relay was used.
    expect(harness.peer.isRelayed()).toBe(false);
  });
});
