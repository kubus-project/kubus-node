import { Buffer } from 'node:buffer';
import crypto from 'node:crypto';
import type { NodeIdentity } from '../identity/nodeIdentity.js';
import {
  IDENTITY_PROOF_PROTOCOL_VERSION,
  createIdentityProof,
} from '../identity/identityProof.js';
import { dispatchLocalRequest, type LocalApiDeps } from '../localApi/dispatch.js';
import type { LocalPeer, LocalRequest, LocalRequestBody, LocalResponse } from '../localApi/localRequest.js';
import type { Logger } from '../logging/logger.js';
import {
  ChunkReassembler,
  FLAG_FINAL,
  FrameType,
  FrameVersionError,
  MAX_PAYLOAD_LENGTH,
  decodeFrame,
  encodeFrame,
  isFinalFrame,
  splitIntoFrames,
  type KubusFrame,
} from './frameCodec.js';

/**
 * Serves canonical Node operations over one WebRTC data channel.
 *
 * This is an adapter and nothing more: it turns frames into a `LocalRequest`,
 * hands it to the same dispatcher the HTTP listener uses, and turns the
 * `LocalResponse` back into frames. It deliberately knows no routes, no
 * scopes, and no business rules — a second implementation of those is how the
 * two transports would come to disagree about who may do what.
 *
 * What it *does* own is everything specific to being reachable by an
 * arbitrary internet peer:
 *
 * - Nothing privileged is served until the peer has answered the identity
 *   challenge. A data channel proves a channel exists, never who opened it.
 * - Concurrency, body size, and in-flight request counts are bounded, because
 *   the far end is not trusted and a channel is cheap to open.
 * - A cancelled or abandoned request stops work rather than running to
 *   completion for nobody.
 */

export interface ChannelTransport {
  send(data: Buffer): void;
  close(): void;
  readonly isOpen: boolean;
}

export interface ChannelServerOptions {
  deps: LocalApiDeps;
  identity: NodeIdentity;
  /** Binds the identity proof to one signaling session, so a captured proof cannot move. */
  sessionId: string;
  logger?: Logger;
  /** Simultaneous in-flight operations from this one peer. */
  maxConcurrentRequests?: number;
  /** Largest request body this peer may send, before the route's own limit applies. */
  maxRequestBodyBytes?: number;
  /** How long a peer may stay unverified before the channel is closed. */
  identityProofTimeoutMs?: number;
}

const DEFAULT_MAX_CONCURRENT_REQUESTS = 16;
const DEFAULT_MAX_REQUEST_BODY_BYTES = 192 * 1024 * 1024;
const DEFAULT_IDENTITY_PROOF_TIMEOUT_MS = 15_000;

/**
 * The one operation served before the peer is verified.
 *
 * It is answered on a reserved request id rather than through the dispatcher,
 * because it is not a Node API operation: it is the handshake that decides
 * whether this peer is ever allowed to issue one.
 */
const IDENTITY_CHALLENGE_PATH = '/local/v1/identity/challenge';

interface InFlight {
  id: number;
  method: string;
  path: string;
  reassembler: ChunkReassembler;
  metadata: Record<string, unknown>;
  cancelled: boolean;
  bodyComplete: boolean;
  resolveBody?: (value: Buffer) => void;
  rejectBody?: (error: Error) => void;
  bodyPromise?: Promise<Buffer>;
  started: boolean;
}

export class ChannelServer {
  private readonly deps: LocalApiDeps;
  private readonly identity: NodeIdentity;
  private readonly sessionId: string;
  private readonly logger?: Logger;
  private readonly maxConcurrentRequests: number;
  private readonly maxRequestBodyBytes: number;
  private readonly inFlight = new Map<number, InFlight>();
  private identityVerified = false;
  private proofTimer: NodeJS.Timeout | undefined;
  private closed = false;

  constructor(private readonly transport: ChannelTransport, options: ChannelServerOptions) {
    this.deps = options.deps;
    this.identity = options.identity;
    this.sessionId = options.sessionId;
    this.logger = options.logger;
    this.maxConcurrentRequests = options.maxConcurrentRequests ?? DEFAULT_MAX_CONCURRENT_REQUESTS;
    this.maxRequestBodyBytes = options.maxRequestBodyBytes ?? DEFAULT_MAX_REQUEST_BODY_BYTES;

    // A peer that opens a channel and then says nothing costs us a socket and
    // a timer. Give the handshake a deadline rather than waiting forever.
    this.proofTimer = setTimeout(() => {
      if (!this.identityVerified) {
        this.logger?.warn({ sessionId: this.sessionId }, 'data channel closed: identity challenge not answered');
        this.close();
      }
    }, options.identityProofTimeoutMs ?? DEFAULT_IDENTITY_PROOF_TIMEOUT_MS);
    this.proofTimer.unref?.();
  }

  /** Feeds one inbound DataChannel message. Never throws to the caller. */
  handleMessage(data: Buffer): void {
    if (this.closed) return;
    let frame: KubusFrame;
    try {
      frame = decodeFrame(data);
    } catch (error) {
      if (error instanceof FrameVersionError) {
        // Report it: a version mismatch is something an operator can act on,
        // unlike corruption. There is no request id to attribute it to, so it
        // goes out on id 0.
        this.sendError(0, 'protocol_version_unsupported');
        this.close();
        return;
      }
      // A malformed frame carries no usable request id, so it cannot be
      // attributed. Dropping it is the only safe action; the peer's own
      // timeout is the backstop.
      return;
    }

    switch (frame.type) {
      case FrameType.RequestHead:
        void this.onRequestHead(frame);
        return;
      case FrameType.RequestChunk:
        this.onRequestChunk(frame);
        return;
      case FrameType.Cancel:
        this.onCancel(frame.requestId);
        return;
      case FrameType.WindowUpdate:
        // Accepted and ignored: this peer sends responses as fast as the
        // channel's own buffering allows, which is already bounded.
        return;
      default:
        // Response frames from a client are meaningless here. Ignored so a
        // confused or hostile peer cannot desynchronise the table.
        return;
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.proofTimer) clearTimeout(this.proofTimer);
    this.proofTimer = undefined;
    for (const entry of this.inFlight.values()) {
      entry.cancelled = true;
      entry.rejectBody?.(new Error('channel closed'));
    }
    this.inFlight.clear();
    try {
      this.transport.close();
    } catch {
      // Closing an already-closed channel is not an error worth propagating.
    }
  }

  /** Visible for tests: whether this peer has proved the node's identity. */
  get isIdentityVerified(): boolean {
    return this.identityVerified;
  }

  get inFlightCount(): number {
    return this.inFlight.size;
  }

  private async onRequestHead(frame: KubusFrame): Promise<void> {
    const metadata = frame.metadata ?? {};
    const method = String(metadata.method ?? 'GET').toUpperCase();
    const path = String(metadata.path ?? '');

    if (this.inFlight.has(frame.requestId)) {
      // Reusing an in-flight id would let a peer corrupt another request's
      // body. Refuse rather than overwrite.
      this.sendError(frame.requestId, 'request_id_in_use');
      return;
    }

    if (path === IDENTITY_CHALLENGE_PATH) {
      this.answerIdentityChallenge(frame.requestId, metadata);
      return;
    }

    if (this.inFlight.size >= this.maxConcurrentRequests) {
      this.sendError(frame.requestId, 'too_many_concurrent_requests');
      return;
    }

    const entry: InFlight = {
      id: frame.requestId,
      method,
      path,
      reassembler: new ChunkReassembler(this.maxRequestBodyBytes),
      metadata,
      cancelled: false,
      bodyComplete: false,
      started: false,
    };
    entry.bodyPromise = new Promise<Buffer>((resolve, reject) => {
      entry.resolveBody = resolve;
      entry.rejectBody = reject;
    });
    // Nothing else awaits this promise until the route asks for the body, and
    // an unobserved rejection would otherwise be an unhandled rejection.
    entry.bodyPromise.catch(() => undefined);
    this.inFlight.set(frame.requestId, entry);

    if (isFinalFrame(frame)) {
      entry.bodyComplete = true;
      entry.resolveBody?.(Buffer.alloc(0));
    }

    await this.runRequest(entry);
  }

  private onRequestChunk(frame: KubusFrame): void {
    const entry = this.inFlight.get(frame.requestId);
    // A chunk for an unknown id is stale — its request completed, timed out,
    // or was cancelled. Ignored rather than treated as an error, which would
    // let a peer disrupt live requests.
    if (!entry || entry.cancelled) return;
    try {
      entry.reassembler.append(frame.payload);
      if (isFinalFrame(frame)) {
        entry.reassembler.verify(frame.metadata);
        entry.bodyComplete = true;
        entry.resolveBody?.(entry.reassembler.take());
      }
    } catch (error) {
      entry.rejectBody?.(error as Error);
      this.sendError(frame.requestId, 'request_body_invalid');
      this.inFlight.delete(frame.requestId);
    }
  }

  private onCancel(requestId: number): void {
    const entry = this.inFlight.get(requestId);
    if (!entry) return;
    entry.cancelled = true;
    entry.rejectBody?.(new Error('request cancelled by peer'));
    this.inFlight.delete(requestId);
  }

  /**
   * Signs the peer's challenge with the node's persisted identity key.
   *
   * This is the only thing served before verification, and it discloses
   * nothing an unauthenticated peer could not already read from the pairing
   * QR: the public key and a signature over a nonce the peer itself chose.
   */
  private answerIdentityChallenge(requestId: number, metadata: Record<string, unknown>): void {
    const nonceRaw = typeof metadata.nonce === 'string' ? metadata.nonce : '';
    let nonce: Buffer;
    try {
      nonce = Buffer.from(nonceRaw, 'base64');
    } catch {
      this.sendError(requestId, 'identity_challenge_invalid');
      return;
    }
    if (nonce.length !== 32) {
      this.sendError(requestId, 'identity_challenge_invalid');
      return;
    }

    const protocolVersion = typeof metadata.protocolVersion === 'string'
      ? metadata.protocolVersion
      : IDENTITY_PROOF_PROTOCOL_VERSION;
    if (protocolVersion !== IDENTITY_PROOF_PROTOCOL_VERSION) {
      this.sendError(requestId, 'identity_protocol_version_unsupported');
      return;
    }

    // The session id is the node's own, never the peer's claim: a peer that
    // could choose it could replay a proof captured from another session.
    const proof = createIdentityProof(this.identity, {
      protocolVersion: IDENTITY_PROOF_PROTOCOL_VERSION,
      sessionId: this.sessionId,
      nonce,
      clientRole: 'client',
    });

    this.identityVerified = true;
    if (this.proofTimer) clearTimeout(this.proofTimer);
    this.proofTimer = undefined;

    this.sendJson(requestId, 200, {
      protocolVersion: IDENTITY_PROOF_PROTOCOL_VERSION,
      sessionId: this.sessionId,
      publicKey: proof.publicKeyRaw.toString('base64url'),
      fingerprint: proof.fingerprint,
      signature: proof.signature.toString('base64'),
    });
  }

  private async runRequest(entry: InFlight): Promise<void> {
    if (entry.started) return;
    entry.started = true;

    const request: LocalRequest = {
      method: entry.method,
      path: entry.path,
      query: toQuery(entry.metadata.query),
      credential: readCredential(entry.metadata),
      idempotencyKey: typeof entry.metadata.idempotencyKey === 'string'
        ? entry.metadata.idempotencyKey
        : undefined,
      contentType: typeof entry.metadata.contentType === 'string'
        ? entry.metadata.contentType
        : undefined,
      body: this.bodyFor(entry),
      peer: this.peer(),
    };

    try {
      const response = await dispatchLocalRequest(request, this.deps);
      if (entry.cancelled) return;
      await this.sendResponse(entry.id, response);
    } catch (error) {
      if (entry.cancelled) return;
      const typed = error as Error & { statusCode?: number; code?: string };
      if (typeof typed.statusCode === 'number') {
        // A typed Node error is part of the application protocol and must look
        // identical on every transport, so it goes back as a normal response
        // rather than as a transport-level error frame.
        this.sendJson(entry.id, typed.statusCode, { error: typed.code ?? 'local_error' }, false);
      } else {
        this.logger?.warn(
          { sessionId: this.sessionId, path: entry.path },
          'data channel request failed',
        );
        this.sendError(entry.id, 'internal_error');
      }
    } finally {
      this.inFlight.delete(entry.id);
    }
  }

  private peer(): LocalPeer {
    return {
      kind: 'webrtc',
      identityVerified: this.identityVerified,
      sessionId: this.sessionId,
    };
  }

  /**
   * Body access for a framed request.
   *
   * The JSON case is special: the client puts a small JSON document straight
   * into the head frame's metadata, so there is no body stream at all and
   * waiting for one would hang every ordinary request.
   */
  private bodyFor(entry: InFlight): LocalRequestBody {
    const inlineJson = entry.metadata.json;
    let consumed = false;
    const claim = () => {
      if (consumed) throw new Error('request body already read');
      consumed = true;
    };

    return {
      async json() {
        claim();
        if (inlineJson && typeof inlineJson === 'object' && !Array.isArray(inlineJson)) {
          return inlineJson as Record<string, unknown>;
        }
        const bytes = await (entry.bodyPromise ?? Promise.resolve(Buffer.alloc(0)));
        if (bytes.length === 0) return {};
        try {
          return JSON.parse(bytes.toString('utf8')) as Record<string, unknown>;
        } catch {
          throw Object.assign(new Error('json_invalid'), { statusCode: 400, code: 'json_invalid' });
        }
      },
      async binary(maxBytes: number) {
        claim();
        const bytes = await (entry.bodyPromise ?? Promise.resolve(Buffer.alloc(0)));
        if (bytes.length > maxBytes) {
          throw Object.assign(new Error('request_too_large'), {
            statusCode: 413,
            code: 'request_too_large',
          });
        }
        if (bytes.length === 0) {
          throw Object.assign(new Error('capture_file_empty'), {
            statusCode: 400,
            code: 'capture_file_empty',
          });
        }
        return bytes;
      },
      stream() {
        claim();
        const promise = entry.bodyPromise ?? Promise.resolve(Buffer.alloc(0));
        return (async function* () {
          const bytes = await promise;
          for (let offset = 0; offset < bytes.length; offset += MAX_PAYLOAD_LENGTH) {
            yield bytes.subarray(offset, offset + MAX_PAYLOAD_LENGTH);
          }
        })();
      },
    };
  }

  private async sendResponse(requestId: number, response: LocalResponse): Promise<void> {
    if (response.kind === 'json') {
      this.sendJson(requestId, response.status, { success: true, data: response.value }, false);
      return;
    }

    const source: AsyncIterable<Buffer> = response.kind === 'bytes'
      ? (async function* () {
          yield response.body;
        })()
      : response.body;

    // The head goes out first with the status, then the body streams. Only the
    // head carries status metadata, so a receiver never has to guess.
    this.send({
      type: FrameType.ResponseHead,
      requestId,
      flags: 0,
      metadata: {
        status: response.status,
        contentType: response.contentType,
        ...(response.kind === 'stream' && response.contentLength !== undefined
          ? { contentLength: response.contentLength }
          : {}),
        ...(response.contentSha256 ? { contentSha256: response.contentSha256 } : {}),
      },
    });

    for await (const frame of splitIntoFrames(requestId, source, FrameType.ResponseChunk)) {
      if (!this.transport.isOpen) return;
      this.send(frame);
    }
  }

  /**
   * Sends a complete JSON response in a single final head frame.
   *
   * `envelope` is false when the caller already wrapped the value, so the
   * `{ success, data }` shape is applied exactly once regardless of path.
   */
  private sendJson(requestId: number, status: number, value: unknown, envelope = true): void {
    const payload = Buffer.from(
      JSON.stringify(envelope ? { success: true, data: value } : value),
      'utf8',
    );
    if (payload.length <= MAX_PAYLOAD_LENGTH) {
      this.send({
        type: FrameType.ResponseHead,
        requestId,
        flags: FLAG_FINAL,
        metadata: { status, contentType: 'application/json; charset=utf-8' },
        payload,
      });
      return;
    }
    // A JSON document larger than one frame still has to be chunked, and the
    // client reassembles it exactly as it does any other body.
    this.send({
      type: FrameType.ResponseHead,
      requestId,
      flags: 0,
      metadata: { status, contentType: 'application/json; charset=utf-8' },
    });
    void (async () => {
      for await (const frame of splitIntoFrames(
        requestId,
        (async function* () {
          yield payload;
        })(),
        FrameType.ResponseChunk,
      )) {
        if (!this.transport.isOpen) return;
        this.send(frame);
      }
    })();
  }

  private sendError(requestId: number, message: string): void {
    this.send({
      type: FrameType.Error,
      requestId,
      flags: FLAG_FINAL,
      // A stable code, never an exception message: a raw message can carry a
      // path, a URL, or a credential, and this goes to an untrusted peer.
      metadata: { message },
    });
  }

  private send(frame: KubusFrame): void {
    if (!this.transport.isOpen) return;
    try {
      this.transport.send(encodeFrame(frame));
    } catch (error) {
      this.logger?.debug({ sessionId: this.sessionId }, 'failed to send frame on data channel');
    }
  }
}

function toQuery(value: unknown): URLSearchParams {
  const params = new URLSearchParams();
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      if (typeof entry === 'string') params.set(key, entry);
    }
  }
  return params;
}

/**
 * Reads the bearer credential out of the framed headers.
 *
 * The client sends it in the same `Authorization` header it would use over
 * HTTP, so the dispatcher receives an identical `credential` either way.
 */
function readCredential(metadata: Record<string, unknown>): string | undefined {
  const headers = metadata.headers;
  if (!headers || typeof headers !== 'object' || Array.isArray(headers)) return undefined;
  for (const [key, value] of Object.entries(headers as Record<string, unknown>)) {
    if (key.toLowerCase() !== 'authorization' || typeof value !== 'string') continue;
    return value.startsWith('Bearer ') ? value.slice(7).trim() : undefined;
  }
  return undefined;
}

/** Mints the challenge nonce a client sends. Exported so tests use the real generator. */
export const createChallengeNonce = (): Buffer => crypto.randomBytes(32);

export { IDENTITY_CHALLENGE_PATH };
