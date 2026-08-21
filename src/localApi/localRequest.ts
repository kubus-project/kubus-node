import type { LocalScope } from './pairingService.js';

/**
 * A Node API request, independent of how it arrived.
 *
 * The Local API used to be a function over `IncomingMessage`/`ServerResponse`,
 * which meant a second way in — a WebRTC data channel — could only be served
 * by a second route table. Two route tables is how the HTTP path and the
 * WebRTC path end up disagreeing about which scope a route needs, or which
 * body size it accepts, and the disagreement is invisible until someone
 * exploits it. There is exactly one dispatcher; the transports differ only in
 * how they turn bytes into this shape and this shape back into bytes.
 */
export interface LocalRequest {
  /** Upper-case HTTP verb. Every transport speaks the same canonical verbs. */
  method: string;
  /** Canonical Node path, e.g. `/local/v1/captures/drafts`. Never transport-specific. */
  path: string;
  query: URLSearchParams;
  /**
   * The bearer credential, already extracted from wherever the transport
   * carries it. The dispatcher never parses an `Authorization` header itself,
   * because only the HTTP transport has one.
   */
  credential?: string;
  /**
   * Client-generated key for a mutation that must not be applied twice if the
   * client retried it on a different rung. Absent means "not deduplicable",
   * which is the safe reading — see `IdempotencyStore`.
   */
  idempotencyKey?: string;
  contentType?: string;
  body: LocalRequestBody;
  peer: LocalPeer;
}

/**
 * Where a request came from, in the terms authorization actually cares about.
 *
 * Deliberately not an IP address: a WebRTC peer has no meaningful one, and the
 * checks that used to read `socket.remoteAddress` are really asking "is this
 * caller entitled to reach a privileged route", which a verified peer answers
 * differently from an anonymous socket.
 */
export interface LocalPeer {
  kind: 'loopback' | 'lan' | 'trusted-proxy' | 'webrtc';
  /** Present only for socket transports; used for pairing rate-limit keys. */
  address?: string;
  /**
   * Whether the identity handshake this transport requires has completed.
   *
   * Be precise about what this does and does not buy, because the name invites
   * an overclaim. The Ed25519 challenge protects the *client* from a fake
   * node: the client picks a nonce, the node signs it, and the client checks
   * the signature against the public key it recorded at pairing time. It is
   * not, and cannot be, authentication of the client — a caller that simply
   * sends a challenge gets a signature, because the signature discloses
   * nothing beyond what the pairing QR already published.
   *
   * What gating privileged routes on it actually provides is protocol
   * ordering: a client cannot present its credential over a data channel
   * before it has been given the opportunity to verify who it is talking to.
   * That closes a client-implementation mistake, not an attack by a peer that
   * already holds a stolen credential — the credential's own scope, expiry
   * and revocation are what bound that.
   *
   * Socket transports set this true because the transport itself is the
   * evidence: loopback is the operator's own machine, and a LAN address is
   * one the operator explicitly opted into.
   */
  identityHandshakeComplete: boolean;
  /**
   * The signaling session this peer arrived on, if any. Bound into the
   * identity proof so a captured proof cannot be replayed into a new session.
   */
  sessionId?: string;
}

/**
 * Body access, deliberately pull-based.
 *
 * A capture file is hundreds of megabytes; handing the dispatcher a
 * pre-read `Buffer` would defeat every streaming limit the routes set. Each
 * accessor may be called at most once — reading a stream twice is a bug the
 * type cannot express, so implementations throw rather than silently
 * returning an empty second read.
 */
export interface LocalRequestBody {
  /** Parses JSON, refusing anything over `maxBytes` before parsing it. */
  json(maxBytes?: number): Promise<Record<string, unknown>>;
  /** Reads raw bytes, refusing anything over `maxBytes` mid-stream. */
  binary(maxBytes: number): Promise<Buffer>;
  /** Streams raw bytes without buffering the whole body. */
  stream(): AsyncIterable<Buffer>;
}

/**
 * A response, in the three shapes the Node actually produces.
 *
 * Split by kind rather than carrying an optional body of every type so a
 * transport cannot forget that a `stream` must be pumped rather than
 * serialized — the case where a bounded-memory guarantee is silently lost.
 */
export type LocalResponse =
  | {
      kind: 'json';
      status: number;
      /** Wrapped in the `{ success, data }` envelope by the transport, identically everywhere. */
      value: unknown;
    }
  | {
      kind: 'bytes';
      status: number;
      contentType: string;
      body: Buffer;
      cacheControl?: string;
      /** Lower-case hex SHA-256 the client verifies before promoting a download. */
      contentSha256?: string;
    }
  | {
      kind: 'stream';
      status: number;
      contentType: string;
      body: AsyncIterable<Buffer>;
      /** Present when known ahead of time, so the client can bound its sink. */
      contentLength?: number;
      cacheControl?: string;
      contentSha256?: string;
    };

export const jsonResponse = (status: number, value: unknown): LocalResponse => ({
  kind: 'json',
  status,
  value,
});

/**
 * The scope a route requires, resolved from the path.
 *
 * Kept as data rather than scattered `authorize` calls so both transports
 * enforce identically and so the mapping can be asserted in one test.
 */
export interface RouteAuthorization {
  scope: LocalScope;
  /** Routes that must never be reachable before an identity proof succeeds. */
  requiresIdentityProof: boolean;
}

/** Thrown body-reading limits, shared by every transport implementation. */
export const BODY_LIMITS = {
  json: 1024 * 1024,
  captureDraftMetadata: 64 * 1024,
  capturePackage: 256 * 1024 * 1024,
  captureDraftFile: 128 * 1024 * 1024,
} as const;
