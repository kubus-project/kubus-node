import crypto from 'node:crypto';

/**
 * A stable, non-reversible label for the operator token currently in use.
 *
 * Recorded alongside a blocked authorization verdict so the runtime can tell
 * "still the credential that was rejected" from "a different credential, which
 * has not been judged yet". That distinction is what makes a rotated token
 * resume polling on its own, without the operator restarting anything.
 *
 * Salted with a fixed domain string and truncated: this must never be usable to
 * confirm a guessed token, and it never appears anywhere a token would be
 * refused. It is safe to persist and safe to show in diagnostics.
 */
const DOMAIN = 'kubus-node/operator-credential-fingerprint/v1';

export function credentialFingerprint(token: string | undefined | null): string | undefined {
  const value = (token ?? '').trim();
  if (!value) return undefined;
  return crypto.createHash('sha256').update(DOMAIN).update('\0').update(value).digest('hex').slice(0, 16);
}
