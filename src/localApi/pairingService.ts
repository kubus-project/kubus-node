import crypto from 'node:crypto';
import type { AppConfig } from '../config/schema.js';
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
  version: 2;
  sessionId: string;
  secret: string;
  expiresAt: string;
  payload: string;
  node: { id: string | null; label: string; endpoint: string; endpoints: string[]; fingerprint: string };
}

/** Bounded, in-memory protection for a remotely exposed pairing exchange. */
export class PairingAttemptLimiter {
  private readonly attempts = new Map<string, number[]>();

  constructor(
    private readonly maxAttempts = 5,
    private readonly windowMs = 60_000,
    private readonly maxTrackedKeys = 4096,
  ) {}

  private prune(now: number): void {
    for (const [client, values] of this.attempts) {
      const current = values.filter((attempt) => now - attempt < this.windowMs);
      if (current.length === 0) this.attempts.delete(client);
      else if (current.length !== values.length) this.attempts.set(client, current);
    }
  }

  assertAllowed(client: string, now = Date.now()): void {
    this.prune(now);
    const attempts = this.attempts.get(client) || [];
    if (attempts.length >= this.maxAttempts) throw localError(429, 'pairing_rate_limited');
  }

  failed(client: string, now = Date.now()): void {
    this.prune(now);
    const attempts = this.attempts.get(client) || [];
    attempts.push(now);
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
 * Limits a proxy-shared client only for the pairing session it is attempting.
 * A random invalid session cannot exhaust the budget for a legitimate session
 * coming through the same reverse proxy address.
 */
export const pairingAttemptKey = (client: string, sessionId: string): string =>
  `${client}:${digest(sessionId).slice(0, 24)}`;

const safeEqual = (left: string, right: string) => {
  const a = Buffer.from(left, 'hex');
  const b = Buffer.from(right, 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
};

/** One versioned serialization for the QR, copy action, and API response. */
export function serializePairingPayload(input: {
  endpoint: string;
  alternateEndpoints: string[];
  sessionId: string;
  secret: string;
  nodeId: string;
  label: string;
  fingerprint: string;
}): string {
  const uri = new URL('kubus-node://pair');
  uri.searchParams.set('v', '2');
  uri.searchParams.set('e', input.endpoint);
  uri.searchParams.set('s', input.sessionId);
  uri.searchParams.set('k', input.secret);
  uri.searchParams.set('n', input.nodeId);
  uri.searchParams.set('l', input.label.slice(0, 80));
  uri.searchParams.set('f', input.fingerprint);
  for (const endpoint of input.alternateEndpoints) uri.searchParams.append('a', endpoint);
  return uri.toString();
}

export class PairingService {
  constructor(private readonly store: LocalStore, private readonly config: AppConfig) {}

  async createSession(): Promise<PairingSessionResponse> {
    // Pairing is available before public registration, so ensure the durable
    // local identity exists even for the standalone `kubus-node gui` command.
    const nodeKey = await this.store.getOrCreateNodeKey(this.config.nodeKey);
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
    const fingerprint = digest(`kubus-local-identity:${nodeKey}`);
    // A Node can pair before it has registered with the public availability
    // service. Its local identity remains stable because it is derived from
    // the persisted node key; registration later upgrades only the public ID.
    const nodeId = state.nodeId || `local-${fingerprint}`;
    const [endpoint, ...alternateEndpoints] = endpoints;
    const payload = serializePairingPayload({ endpoint: endpoint!, alternateEndpoints, sessionId: id, secret, nodeId, label: this.config.nodeLabel, fingerprint });
    return {
      version: 2,
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
