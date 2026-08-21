/**
 * The proof a paired peer signs after a WebRTC DataChannel opens, so the app
 * can confirm it is still talking to the node it paired with rather than
 * whatever answered the connection.
 *
 * Both sides must build byte-for-byte the same message before signing or
 * verifying, so the canonical builder lives here rather than being
 * reimplemented on each side of the channel. Every field is bound for a
 * specific reason, and dropping any one of them reopens a specific attack:
 *
 * - The domain separator (`kubus-node-identity-proof/v1`) stops a signature
 *   minted for this protocol from being replayed into a different one that
 *   happens to sign the same bytes for an unrelated purpose.
 * - `sessionId` binds the proof to one signaling session, so a proof captured
 *   from a previous connection cannot be replayed into a new one.
 * - `nonce` makes every challenge unique even within the same session, so a
 *   proof cannot be reused for a second challenge in that session either.
 * - `publicKeyRaw` binds the proof to the specific identity being asserted,
 *   so a valid proof for one key cannot be re-presented as if it were signed
 *   by a substituted key.
 * - `clientRole` stops a proof signed by one side of the connection (the
 *   phone) being reflected back and accepted as if the node had signed it,
 *   or vice versa.
 *
 * The message is built from length-implicit, NUL-terminated UTF-8 fields
 * followed by two fixed-length 32-byte fields (nonce, public key) — fixed
 * length removes any ambiguity about where they end, so no separator is
 * needed around them.
 */
import { verifyNodeSignature, type NodeIdentity } from './nodeIdentity.js';

export const IDENTITY_PROOF_PROTOCOL_VERSION = 'kubus-node/1';

const DOMAIN_SEPARATOR = Buffer.from('kubus-node-identity-proof/v1', 'utf8');
const FIELD_TERMINATOR = Buffer.from([0x00]);
const NONCE_LENGTH = 32;
const PUBLIC_KEY_LENGTH = 32;
const SIGNATURE_LENGTH = 64;

export interface IdentityProofMessageInput {
  protocolVersion: string;
  sessionId: string;
  /** Exactly 32 raw bytes. */
  nonce: Buffer;
  /** Exactly 32 raw bytes — the signer's Ed25519 public key. */
  publicKeyRaw: Buffer;
  clientRole: string;
}

function utf8Field(value: string): Buffer {
  return Buffer.concat([Buffer.from(value, 'utf8'), FIELD_TERMINATOR]);
}

/** The exact bytes both sides sign/verify. See the file doc comment for why each field is present. */
export function buildIdentityProofMessage(input: IdentityProofMessageInput): Buffer {
  if (input.nonce.length !== NONCE_LENGTH) throw new Error('identity_proof_nonce_invalid_length');
  if (input.publicKeyRaw.length !== PUBLIC_KEY_LENGTH) throw new Error('identity_proof_public_key_invalid_length');
  return Buffer.concat([
    DOMAIN_SEPARATOR, FIELD_TERMINATOR,
    utf8Field(input.protocolVersion),
    utf8Field(input.sessionId),
    input.nonce,
    input.publicKeyRaw,
    utf8Field(input.clientRole),
  ]);
}

export interface IdentityProof {
  signature: Buffer;
  publicKeyRaw: Buffer;
  fingerprint: string;
}

/** Signs a fresh challenge with the node's persisted identity. */
export function createIdentityProof(
  identity: NodeIdentity,
  input: { protocolVersion: string; sessionId: string; nonce: Buffer; clientRole: string },
): IdentityProof {
  const message = buildIdentityProofMessage({ ...input, publicKeyRaw: identity.publicKeyRaw });
  return {
    signature: identity.sign(message),
    publicKeyRaw: identity.publicKeyRaw,
    fingerprint: identity.fingerprint,
  };
}

export interface IdentityProofVerificationInput {
  publicKeyRaw: Buffer;
  signature: Buffer;
  protocolVersion: string;
  sessionId: string;
  nonce: Buffer;
  clientRole: string;
}

/**
 * Rejects malformed shapes before any cryptographic work, so a peer cannot
 * probe the verifier with arbitrary-length input. The actual comparison is
 * `crypto.verify`'s, not a manually written one — see `verifyNodeSignature`.
 */
export function verifyIdentityProof(input: IdentityProofVerificationInput): boolean {
  if (input.nonce.length !== NONCE_LENGTH) return false;
  if (input.publicKeyRaw.length !== PUBLIC_KEY_LENGTH) return false;
  if (input.signature.length !== SIGNATURE_LENGTH) return false;
  let message: Buffer;
  try {
    message = buildIdentityProofMessage(input);
  } catch {
    return false;
  }
  return verifyNodeSignature(input.publicKeyRaw, message, input.signature);
}
