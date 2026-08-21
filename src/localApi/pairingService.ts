import crypto from 'node:crypto';
import type { AppConfig } from '../config/schema.js';
import type { NodeIdentity } from '../identity/nodeIdentity.js';
import type { LocalStore } from '../state/localStore.js';

export const LOCAL_SCOPES = [
  'content:read',
  'captures:create',
  'captures:read',
  'jobs:create',
  'jobs:read',
  'spatial:read',
  'spatial:publish-request',
  'compute:manage',
] as const;
export type LocalScope = typeof LOCAL_SCOPES[number];

export interface PairingSessionResponse {
  version: 3;
  sessionId: string;
  secret: string;
  expiresAt: string;
  payload: string;
  node: { id: string | null; label: string; endpoint: string; endpoints: string[]; fingerprint: string; publicKey: string };
}

/** Bounded, in-memory protection for a remotely exposed pairing exchange. */
export class PairingAttemptLimiter {
  private readonly attempts = new Map<string, { windowStartedAt: number; count: number }>();
  private globalWindowStartedAt: number | undefined;
  private globalCount = 0;

  constructor(
    private readonly maxAttempts = 5,
    private readonly windowMs = 60_000,
    private readonly maxTrackedKeys = 4096,
    private readonly maxGlobalAttempts = 120,
  ) {}

  assertAllowed(client: string, now = Date.now()): void {
    if (this.globalWindowStartedAt === undefined || now - this.globalWindowStartedAt >= this.windowMs) {
      this.globalWindowStartedAt = now;
      this.globalCount = 0;
    }
    if (this.globalCount >= this.maxGlobalAttempts) throw localError(429, 'pairing_rate_limited');
    this.globalCount += 1;

    const attempts = this.attempts.get(client);
    if (attempts && now - attempts.windowStartedAt < this.windowMs && attempts.count >= this.maxAttempts) {
      throw localError(429, 'pairing_rate_limited');
    }
    if (attempts && now - attempts.windowStartedAt >= this.windowMs) this.attempts.delete(client);
  }

  failed(client: string, now = Date.now()): void {
    const previous = this.attempts.get(client);
    const attempts = previous && now - previous.windowStartedAt < this.windowMs
      ? { ...previous, count: previous.count + 1 }
      : { windowStartedAt: now, count: 1 };
    if (!this.attempts.has(client) && this.attempts.size >= this.maxTrackedKeys) {
      const oldest = this.attempts.keys().next().value as string | undefined;
      if (oldest) this.attempts.delete(oldest);
    }
    this.attempts.set(client, attempts);
  }

  succeeded(client: string): void {
    this.attempts.delete(client);
  }
}

const digest = (value: string) => crypto.createHash('sha256').update(value).digest('hex');

/**
 * Session-specific keys keep one bad pairing from immediately consuming a
 * legitimate session's small budget. PairingAttemptLimiter also applies a
 * higher process-wide admission bound so rotating random IDs cannot bypass
 * throttling or create unbounded work behind a shared reverse proxy.
 */
export const pairingAttemptKey = (client: string, sessionId: string): string =>
  `${client}:${digest(sessionId).slice(0, 24)}`;

const safeEqual = (left: string, right: string) => {
  const a = Buffer.from(left, 'hex');
  const b = Buffer.from(right, 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
};

/**
 * One versioned serialization for the QR, copy action, and API response.
 *
 * v3 adds `pk`, the node's raw Ed25519 public key: the value a WebRTC peer
 * verifies the node against after connecting, so a paired app can hold the
 * key across the session rather than trusting the fingerprint alone. `f`
 * stays a separate parameter (rather than something the app derives locally)
 * so a display/compare flow that only reads `f` keeps working unchanged; the
 * two must agree — `nodeFingerprintFromPublicKey(pk) === f` always holds; see
 * `PairingService.createSession`. There are no production pairing partners on
 * v2 to keep compatible, so v3 is emitted exclusively rather than dual-issued.
 */
export function serializePairingPayload(input: {
  endpoint: string;
  alternateEndpoints: string[];
  sessionId: string;
  secret: string;
  nodeId: string;
  label: string;
  fingerprint: string;
  publicKey: string;
}): string {
  const uri = new URL('kubus-node://pair');
  uri.searchParams.set('v', '3');
  uri.searchParams.set('e', input.endpoint);
  uri.searchParams.set('s', input.sessionId);
  uri.searchParams.set('k', input.secret);
  uri.searchParams.set('n', input.nodeId);
  uri.searchParams.set('l', input.label.slice(0, 80));
  uri.searchParams.set('f', input.fingerprint);
  uri.searchParams.set('pk', input.publicKey);
  for (const endpoint of input.alternateEndpoints) uri.searchParams.append('a', endpoint);
  return uri.toString();
}

export class PairingService {
  constructor(private readonly store: LocalStore, private readonly config: AppConfig, private readonly identity: NodeIdentity) {}

  async createSession(): Promise<PairingSessionResponse> {
    // Pairing is available before public registration, so ensure the legacy
    // node key exists even for the standalone `kubus-node gui` command — it is
    // still what `registerNode`/heartbeat send to the backend. It plays no
    // part in the identity below: that comes from the Ed25519 keypair, which
    // is minted independently of registration and of this call.
    await this.store.getOrCreateNodeKey(this.config.nodeKey);
    const id = crypto.randomUUID();
    const secret = crypto.randomBytes(32).toString('base64url');
    const now = Date.now();
    const expiresAt = new Date(now + this.config.pairingSessionTtlMs).toISOString();
    await this.store.update((state) => {
      const sessions = state.pairingSessions ??= {};
      for (const [sessionId, session] of Object.entries(sessions)) {
        if (Date.parse(session.expiresAt) <= now || session.usedAt) delete sessions[sessionId];
      }
      sessions[id] = { secretHash: digest(secret), createdAt: new Date(now).toISOString(), expiresAt };
    });
    const state = this.store.snapshot();
    const endpoints = [
      this.config.localApiAllowLan ? this.config.localApiLanUrl : undefined,
      this.config.localApiRemoteUrl,
    ]
      .filter((endpoint): endpoint is string => Boolean(endpoint));
    if (endpoints.length === 0) throw localError(409, 'pairing_endpoint_unavailable');
    const fingerprint = this.identity.fingerprint;
    const publicKey = this.identity.publicKeyBase64Url;
    // A Node can pair before it has registered with the public availability
    // service. Its local identity remains stable because the Ed25519 keypair
    // is generated once and persisted independently of registration.
    //
    // Deliberate choice: the fallback id is `local-${fingerprint}`, and
    // `fingerprint` used to be derived from the shared node key; it is now
    // derived from the public key instead. That is the identity a connecting
    // client actually verifies (see identityProof.ts), so it is the more
    // correct fallback id, not just an incidental consequence of this change.
    // Nothing downstream depends on the old value: `registerNode`/heartbeat
    // send the raw node key to the backend directly and never read this
    // fallback id, and once registration succeeds `state.nodeId` (the
    // backend-issued id) takes over here regardless.
    const nodeId = state.nodeId || `local-${fingerprint}`;
    const [endpoint, ...alternateEndpoints] = endpoints;
    const payload = serializePairingPayload({ endpoint: endpoint!, alternateEndpoints, sessionId: id, secret, nodeId, label: this.config.nodeLabel, fingerprint, publicKey });
    return {
      version: 3,
      sessionId: id,
      secret,
      expiresAt,
      payload,
      node: {
        id: nodeId,
        label: this.config.nodeLabel,
        endpoint: endpoint!,
        endpoints,
        fingerprint,
        publicKey,
      },
    };
  }

  async exchange(sessionId: string, secret: string, label?: string): Promise<{ token: string; credentialId: string; scopes: LocalScope[] }> {
    const state = this.store.snapshot();
    const session = state.pairingSessions?.[sessionId];
    if (!session) throw localError(401, 'invalid_pairing_session');
    if (session.usedAt) throw localError(409, 'pairing_session_replayed');
    if (Date.parse(session.expiresAt) <= Date.now()) throw localError(410, 'pairing_session_expired');
    if (!secret || !safeEqual(session.secretHash, digest(secret))) throw localError(401, 'invalid_pairing_secret');

    const credentialId = crypto.randomUUID();
    const token = `kubus_local_${crypto.randomBytes(32).toString('base64url')}`;
    const scopes = [...LOCAL_SCOPES];
    await this.store.update((next) => {
      const current = next.pairingSessions?.[sessionId];
      if (!current || current.usedAt) throw localError(409, 'pairing_session_replayed');
      current.usedAt = new Date().toISOString();
      (next.localCredentials ??= {})[credentialId] = {
        tokenHash: digest(token),
        label: label?.slice(0, 80),
        scopes,
        createdAt: new Date().toISOString(),
      };
    });
    return { token, credentialId, scopes };
  }

  /**
   * Disconnects a paired device. The credential is marked revoked rather than
   * deleted so `authorize` fails closed for a token that is still in the wild,
   * and so the record remains available to an audit of past access.
   */
  async revoke(credentialId: string): Promise<void> {
    const credential = this.store.snapshot().localCredentials?.[credentialId];
    if (!credential || credential.revokedAt) throw localError(404, 'device_not_found');
    await this.store.update((state) => {
      const current = state.localCredentials?.[credentialId];
      if (current) current.revokedAt = new Date().toISOString();
    });
  }

  async authorize(token: string | undefined, requiredScope: LocalScope): Promise<boolean> {
    if (!token?.startsWith('kubus_local_')) return false;
    const hash = digest(token);
    const entry = Object.entries(this.store.snapshot().localCredentials || {})
      .find(([, credential]) => !credential.revokedAt && safeEqual(credential.tokenHash, hash));
    if (!entry || !entry[1].scopes.includes(requiredScope)) return false;
    await this.store.update((state) => {
      const credential = state.localCredentials?.[entry[0]];
      if (credential) credential.lastUsedAt = new Date().toISOString();
    });
    return true;
  }
}

export function localError(statusCode: number, code: string, details?: Record<string, unknown>): Error & { statusCode: number; code: string; details?: Record<string, unknown> } {
  return Object.assign(new Error(code), { statusCode, code, details });
}
