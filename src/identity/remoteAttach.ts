import crypto from 'node:crypto';
import canonical from 'json-stable-stringify';
import type { KubusApiClient } from '../backend/kubusApiClient.js';
import type { NodeIdentity } from './nodeIdentity.js';
import { localError } from '../localApi/pairingService.js';

export interface NodeAuthorization {
  id: string;
  nodeId: string;
  kind: 'ENROLLMENT' | 'REMOTE_ATTACH';
  challenge: string;
  payload: Record<string, unknown>;
  expiresAt: string;
}

export function authorizationMessage(grant: NodeAuthorization): Buffer {
  const { id, nodeId, kind, challenge, payload } = grant;
  return Buffer.from(`kubus.node-authorization/1\n${canonical({ id, nodeId, kind, challenge, payload })}`);
}

export async function enrollNodeIdentity(api: KubusApiClient, nodeId: string, identity: NodeIdentity): Promise<void> {
  const grant = await api.createIdentityChallenge(nodeId, identity.publicKeyBase64Url);
  if (grant.nodeId !== nodeId || grant.kind !== 'ENROLLMENT' || grant.payload.publicKey !== identity.publicKeyBase64Url) {
    throw localError(403, 'node_identity_enrollment_invalid');
  }
  await api.consumeNodeAuthorization(nodeId, grant.id, {
    challenge: grant.challenge, signature: identity.sign(authorizationMessage(grant)).toString('base64url'),
  });
}

export function signRemoteAttach(grant: NodeAuthorization, verifier: string, sessionId: string, nodeId: string, identity: NodeIdentity): string {
  if (!grant || grant.kind !== 'REMOTE_ATTACH' || grant.nodeId !== nodeId
    || !grant.payload || grant.payload.publicKey !== identity.publicKeyBase64Url
    || grant.payload.sessionId !== sessionId || typeof verifier !== 'string'
    || !/^[A-Za-z0-9_-]{43}$/.test(verifier)
    || grant.payload.verifierHash !== crypto.createHash('sha256').update(verifier).digest('hex')
    || typeof grant.payload.deviceId !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(grant.payload.deviceId)
    || !Number.isFinite(Date.parse(grant.expiresAt)) || Date.parse(grant.expiresAt) <= Date.now()) {
    throw localError(403, 'remote_attach_binding_invalid');
  }
  return identity.sign(authorizationMessage(grant)).toString('base64url');
}
