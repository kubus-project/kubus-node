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
] as const;
export type LocalScope = typeof LOCAL_SCOPES[number];

export interface PairingSessionResponse {
  sessionId: string;
  secret: string;
  expiresAt: string;
  node: { id: string | null; label: string; endpoint: string; fingerprint: string };
}

const digest = (value: string) => crypto.createHash('sha256').update(value).digest('hex');
const safeEqual = (left: string, right: string) => {
  const a = Buffer.from(left, 'hex');
  const b = Buffer.from(right, 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
};

export class PairingService {
  constructor(private readonly store: LocalStore, private readonly config: AppConfig) {}

  async createSession(): Promise<PairingSessionResponse> {
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
    const nodeKey = state.nodeKey || '';
    return {
      sessionId: id,
      secret,
      expiresAt,
      node: {
        id: state.nodeId || null,
        label: this.config.nodeLabel,
        endpoint: this.config.localApiPublicUrl || `http://127.0.0.1:${this.config.localApiPort}`,
        fingerprint: digest(`kubus-local-identity:${nodeKey}`),
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
