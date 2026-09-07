/**
 * Explicit, account-authorized replacement of this Node's operator credential.
 *
 * A Node paired before the current scope contract keeps working for local and
 * archive work but cannot do network compute, because its credential was issued
 * without the compute scopes. Nothing here grants those silently: the account
 * holder authorizes a replacement credential, and only then is one minted.
 *
 * The Node id, the Ed25519 identity, pairings, captures, archive and results are
 * untouched — this rotates a credential, it does not re-enrol a Node.
 */
import { promises as fs } from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';
import type { NodeIdentity } from '../identity/nodeIdentity.js';
import type { Logger } from '../logging/logger.js';
import {
  InstallationError, claimInstallation, confirmInstallation, pollInstallation, startInstallation,
  type StartedInstallation,
} from './installationClient.js';

export type PermissionUpdatePhase =
  | 'IDLE' | 'WAITING_FOR_AUTHORIZATION' | 'APPLYING' | 'COMPLETED' | 'DECLINED' | 'EXPIRED' | 'FAILED';

export interface PermissionUpdateStatus {
  phase: PermissionUpdatePhase;
  userCode: string | null;
  installationId: string | null;
  expiresAt: string | null;
  errorCode: string | null;
  /** True once the replacement credential is durably stored. */
  restartRequired: boolean;
}

/**
 * Rewrites KUBUS_OPERATOR_TOKEN and KUBUS_OPERATOR_WALLET in place.
 *
 * Writes a sibling temporary file and renames it over the original, so a crash
 * mid-write leaves the previous credential intact rather than a truncated file
 * the Node cannot start from. Every other configured value is preserved
 * verbatim: this must not become an accidental reset of the operator's setup.
 */
export async function replaceOperatorCredential(
  configPath: string,
  credential: { token: string; wallet: string },
): Promise<void> {
  if (/[\r\n"]/.test(credential.token) || /[\r\n"]/.test(credential.wallet)) {
    throw new Error('credential_unrepresentable');
  }
  const current = await fs.readFile(configPath, 'utf8');
  const replaced = new Set<string>();
  const lines = current.split('\n').map((line) => {
    const key = line.slice(0, line.indexOf('='));
    if (key === 'KUBUS_OPERATOR_TOKEN') { replaced.add(key); return `KUBUS_OPERATOR_TOKEN=${JSON.stringify(credential.token)}`; }
    if (key === 'KUBUS_OPERATOR_WALLET') { replaced.add(key); return `KUBUS_OPERATOR_WALLET=${JSON.stringify(credential.wallet)}`; }
    return line;
  });
  if (!replaced.has('KUBUS_OPERATOR_TOKEN')) lines.push(`KUBUS_OPERATOR_TOKEN=${JSON.stringify(credential.token)}`);
  if (!replaced.has('KUBUS_OPERATOR_WALLET')) lines.push(`KUBUS_OPERATOR_WALLET=${JSON.stringify(credential.wallet)}`);
  const temporary = path.join(
    path.dirname(configPath),
    `.config.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`,
  );
  await fs.writeFile(temporary, lines.join('\n').replace(/\n+$/, '') + '\n', { mode: 0o600 });
  await fs.rename(temporary, configPath);
  if (process.platform !== 'win32') await fs.chmod(configPath, 0o600);
}

export class PermissionUpdateService {
  private started: StartedInstallation | undefined;
  private phase: PermissionUpdatePhase = 'IDLE';
  private errorCode: string | null = null;
  private applied = false;

  constructor(private readonly deps: {
    apiBaseUrl: string;
    configPath: string;
    identity: NodeIdentity;
    nodeId: () => string | undefined;
    logger?: Logger;
    /** Called once the replacement credential is durably stored. */
    onCredentialReplaced?: () => void;
  }) {}

  status(): PermissionUpdateStatus {
    return {
      phase: this.phase,
      userCode: this.started?.userCode ?? null,
      installationId: this.started?.installationId ?? null,
      expiresAt: this.started?.expiresAt ?? null,
      errorCode: this.errorCode,
      restartRequired: this.applied,
    };
  }

  /**
   * Begins an update. Returns the existing one while it is still outstanding so
   * repeated taps in the app cannot open a pile of grants.
   */
  async begin(): Promise<PermissionUpdateStatus> {
    if (this.phase === 'WAITING_FOR_AUTHORIZATION' || this.phase === 'APPLYING') return this.status();
    const nodeId = this.deps.nodeId();
    if (!nodeId) throw new InstallationError('NODE_NOT_REGISTERED', 409);
    this.errorCode = null;
    this.applied = false;
    this.started = await startInstallation({
      apiBaseUrl: this.deps.apiBaseUrl,
      identity: this.deps.identity,
      kind: 'PERMISSION_UPDATE',
      nodeId,
      label: null,
    });
    this.phase = 'WAITING_FOR_AUTHORIZATION';
    return this.status();
  }

  /**
   * Advances the update. Safe to call repeatedly; the credential is collected
   * and stored at most once.
   */
  async refresh(): Promise<PermissionUpdateStatus> {
    const started = this.started;
    if (!started || this.phase !== 'WAITING_FOR_AUTHORIZATION') return this.status();
    try {
      const state = await pollInstallation({ apiBaseUrl: this.deps.apiBaseUrl, started });
      if (state === 'DECLINED') { this.phase = 'DECLINED'; return this.status(); }
      if (state === 'EXPIRED') { this.phase = 'EXPIRED'; return this.status(); }
      if (state !== 'AUTHORIZED') return this.status();

      this.phase = 'APPLYING';
      const claimed = await claimInstallation({
        apiBaseUrl: this.deps.apiBaseUrl, identity: this.deps.identity, started,
      });
      // Store first. Confirming before the write would retire the working
      // credential while this Node still had nothing usable on disk.
      await replaceOperatorCredential(this.deps.configPath, { token: claimed.token, wallet: claimed.wallet });
      this.applied = true;
      try {
        await confirmInstallation({ apiBaseUrl: this.deps.apiBaseUrl, identity: this.deps.identity, started });
      } catch {
        // The new credential already works; the old one simply stays active a
        // while longer. Not worth failing an otherwise successful rotation.
      }
      this.phase = 'COMPLETED';
      this.deps.onCredentialReplaced?.();
    } catch (error) {
      // A failure before the write leaves the previous credential in place and
      // the grant unconsumed, so the operator can simply try again.
      this.phase = this.applied ? 'COMPLETED' : 'FAILED';
      this.errorCode = error instanceof InstallationError ? error.code : 'NODE_INSTALLATION_FAILED';
      this.deps.logger?.warn?.(`permission update did not complete: ${this.errorCode}`);
    }
    return this.status();
  }
}
