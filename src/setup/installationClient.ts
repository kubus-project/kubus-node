/**
 * The Node's half of account-authorized installation and permission rotation.
 *
 * The Node never asks a person for a scoped operator token. It starts an
 * installation signed by its own durable Ed25519 identity, waits for the
 * account holder to authorize it from a signed-in art.kubus surface, and then
 * collects the credential by proving that same identity plus a verifier that
 * never leaves this process.
 *
 * The verifier is the reason observing the control plane is not enough to steal
 * the credential, and the reason this module — not the backend — decides when a
 * credential has been durably stored.
 */
import crypto from 'node:crypto';
import type { NodeIdentity } from '../identity/nodeIdentity.js';

export type InstallationKind = 'NODE_SETUP' | 'PERMISSION_UPDATE';
export type InstallationState = 'PENDING' | 'AUTHORIZED' | 'DELIVERED' | 'CONFIRMED' | 'DECLINED' | 'EXPIRED';

export interface StartedInstallation {
  installationId: string;
  userCode: string;
  expiresAt: string;
  /** Held only in this process. Required to poll, claim and confirm. */
  claimVerifier: string;
  kind: InstallationKind;
  nodeId: string | null;
}

export interface ClaimedCredential {
  installationId: string;
  kind: InstallationKind;
  token: string;
  wallet: string;
  nodeId: string | null;
  scopes: string[];
  replacesTokenId: string | null;
}

export class InstallationError extends Error {
  constructor(readonly code: string, readonly status: number) {
    super(code);
  }
}

function canonical(value: Record<string, unknown>): string {
  // Matches the backend's json-stable-stringify ordering: keys ascending, no
  // whitespace. Both sides must produce byte-identical messages or no
  // signature this module makes can ever verify.
  const keys = Object.keys(value).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${JSON.stringify(value[key] ?? null)}`).join(',')}}`;
}

function message(fields: {
  action: string;
  id: string | null;
  userCode: string | null;
  publicKey: string;
  claimVerifierHash: string;
  kind: InstallationKind;
  nodeId: string | null;
}): Buffer {
  return Buffer.from(`kubus.node-installation/1\n${canonical({
    action: fields.action,
    id: fields.id,
    userCode: fields.userCode,
    publicKey: fields.publicKey,
    claimVerifierHash: fields.claimVerifierHash,
    kind: fields.kind,
    nodeId: fields.nodeId,
  })}`);
}

async function post<T>(apiBaseUrl: string, path: string, body: unknown, timeoutMs = 15000): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let response: Response;
  try {
    response = await fetch(`${apiBaseUrl.replace(/\/$/, '')}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } catch {
    throw new InstallationError('NODE_INSTALLATION_UNREACHABLE', 503);
  } finally { clearTimeout(timer); }
  let payload: { success?: boolean; data?: T; errorCode?: string; code?: string } = {};
  try { payload = await response.json() as typeof payload; } catch { /* handled below */ }
  if (!response.ok || payload.success !== true) {
    throw new InstallationError(payload.errorCode || payload.code || 'NODE_INSTALLATION_FAILED', response.status);
  }
  return payload.data as T;
}

/** Begins an installation. Nothing is granted until an account authorizes it. */
export async function startInstallation(options: {
  apiBaseUrl: string;
  identity: NodeIdentity;
  label?: string | null;
  kind: InstallationKind;
  nodeId?: string | null;
  /** Non-secret prefix of the credential this rotation replaces, if any. */
  previousTokenPrefix?: string | null;
}): Promise<StartedInstallation> {
  const claimVerifier = crypto.randomBytes(32).toString('base64url');
  const claimVerifierHash = crypto.createHash('sha256').update(claimVerifier).digest('hex');
  const nodeId = options.nodeId ?? null;
  const signature = options.identity.sign(message({
    action: 'create',
    id: null,
    userCode: null,
    publicKey: options.identity.publicKeyBase64Url,
    claimVerifierHash,
    kind: options.kind,
    nodeId,
  })).toString('base64url');

  const data = await post<{ installationId: string; userCode: string; expiresAt: string }>(
    options.apiBaseUrl, '/api/availability/node-installations', {
      kind: options.kind,
      publicKey: options.identity.publicKeyBase64Url,
      fingerprint: options.identity.fingerprint,
      claimVerifierHash,
      signature,
      label: options.label ?? null,
      nodeId,
      previousTokenPrefix: options.previousTokenPrefix ?? null,
    },
  );
  return {
    installationId: data.installationId,
    userCode: data.userCode,
    expiresAt: data.expiresAt,
    claimVerifier,
    kind: options.kind,
    nodeId,
  };
}

export async function pollInstallation(options: {
  apiBaseUrl: string;
  started: StartedInstallation;
}): Promise<InstallationState> {
  const data = await post<{ state: InstallationState }>(
    options.apiBaseUrl,
    `/api/availability/node-installations/${encodeURIComponent(options.started.installationId)}/status`,
    { claimVerifier: options.started.claimVerifier },
  );
  return data.state;
}

/**
 * Collects the credential. Single-use on the backend, so a caller that loses
 * the result loses the credential — store it before treating this as done.
 */
export async function claimInstallation(options: {
  apiBaseUrl: string;
  identity: NodeIdentity;
  started: StartedInstallation;
}): Promise<ClaimedCredential> {
  const claimVerifierHash = crypto.createHash('sha256').update(options.started.claimVerifier).digest('hex');
  const signature = options.identity.sign(message({
    action: 'claim',
    id: options.started.installationId,
    userCode: options.started.userCode,
    publicKey: options.identity.publicKeyBase64Url,
    claimVerifierHash,
    kind: options.started.kind,
    nodeId: options.started.nodeId,
  })).toString('base64url');
  return post<ClaimedCredential>(
    options.apiBaseUrl,
    `/api/availability/node-installations/${encodeURIComponent(options.started.installationId)}/claim`,
    { claimVerifier: options.started.claimVerifier, signature },
  );
}

/**
 * Reports that the replacement credential is durably stored.
 *
 * Only this call retires the superseded credential, so it must happen strictly
 * after the new one is on disk. A Node that dies before confirming keeps
 * working on the old token instead of holding one nobody accepts.
 */
export async function confirmInstallation(options: {
  apiBaseUrl: string;
  identity: NodeIdentity;
  started: StartedInstallation;
}): Promise<void> {
  const claimVerifierHash = crypto.createHash('sha256').update(options.started.claimVerifier).digest('hex');
  const signature = options.identity.sign(message({
    action: 'confirm',
    id: options.started.installationId,
    userCode: options.started.userCode,
    publicKey: options.identity.publicKeyBase64Url,
    claimVerifierHash,
    kind: options.started.kind,
    nodeId: options.started.nodeId,
  })).toString('base64url');
  await post(
    options.apiBaseUrl,
    `/api/availability/node-installations/${encodeURIComponent(options.started.installationId)}/confirm`,
    { claimVerifier: options.started.claimVerifier, signature },
  );
}
