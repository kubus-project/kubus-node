/**
 * The node's durable Ed25519 identity.
 *
 * A pairing "fingerprint" used to be `sha256("kubus-local-identity:" + nodeKey)`:
 * a hash of a shared secret. That proves nothing on its own — anyone who ever
 * learns the secret (it lives in `state.json`, in backend registration
 * payloads, in logs of anyone careless with them) can compute the identical
 * hash and claim to be this node. It cannot answer "is the peer I just
 * connected to over WebRTC actually the node I paired with", because knowing
 * the hash and knowing the secret are the same fact.
 *
 * An Ed25519 keypair fixes this: the public key (and the fingerprint derived
 * from it) can be handed to anyone, including an attacker, without weakening
 * the identity, because recognising the node still requires a signature only
 * the holder of the private key can produce. `identityProof.ts` builds the
 * actual challenge/response on top of this keypair.
 *
 * The key is minted once and kept in its own file, `identity.json`, deliberately
 * outside `state.json`. `LocalStore` re-serializes the *entire* state object on
 * every single update (heartbeats, pin reconciliation, job status, ...), so a
 * long-lived secret sitting in that file is written to disk constantly, is
 * more likely to be swept up in an ad hoc "just tar the state dir" backup or
 * debug log, and shares one corruption/rollback unit with a hundred unrelated
 * fields. A key that is only ever written once benefits from living somewhere
 * that is only ever written once.
 */
import crypto from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { Logger } from '../logging/logger.js';

const IDENTITY_FILE_NAME = 'identity.json';
const IDENTITY_FILE_VERSION = 1;
const IDENTITY_ALGORITHM = 'ed25519';

interface StoredIdentityFile {
  version: 1;
  algorithm: 'ed25519';
  createdAt: string;
  /** PKCS8 DER, base64url. */
  privateKey: string;
  /** Raw 32-byte Ed25519 public key, base64url. */
  publicKey: string;
}

export interface NodeIdentity {
  /** Raw 32-byte Ed25519 public key. */
  publicKeyRaw: Buffer;
  publicKeyBase64Url: string;
  /** Full sha256(publicKeyRaw) hex digest. Display code truncates via `formatFingerprint`. */
  fingerprint: string;
  createdAt: string;
  /** Signs with the persisted private key. The key itself never leaves this closure. */
  sign(message: Buffer): Buffer;
}

/** sha256 of the raw public key. Pure and exported so every caller derives the same value the same way. */
export function nodeFingerprintFromPublicKey(publicKeyRaw: Buffer): string {
  return crypto.createHash('sha256').update(publicKeyRaw).digest('hex');
}

/**
 * The human-comparable form: the first 16 hex characters (64 bits — enough to
 * make a collision impractical to fake in the seconds a pairing screen is
 * open), uppercased and grouped in 4s. This is what a person reads off the
 * node's screen and off their phone and compares by eye, so it is kept short
 * and evenly grouped; the full 64-character hex value is the machine value
 * used everywhere else (pairing payload, `/local/v1/info`, the WebRTC proof).
 */
export function formatFingerprint(fingerprint: string): string {
  const groups = fingerprint.slice(0, 16).toUpperCase().match(/.{1,4}/g) ?? [];
  return groups.join(' ');
}

/** For tests and any future verifier: checks an Ed25519 signature against a raw public key. Never throws. */
export function verifyNodeSignature(publicKeyRaw: Buffer, message: Buffer, signature: Buffer): boolean {
  try {
    if (publicKeyRaw.length !== 32) return false;
    return crypto.verify(null, message, publicKeyObjectFromRaw(publicKeyRaw), signature);
  } catch {
    // A malformed key or signature is a verification failure, not an
    // exceptional condition — callers (a remote peer's WebRTC handshake) must
    // not be able to crash the caller by sending garbage.
    return false;
  }
}

function publicKeyObjectFromRaw(publicKeyRaw: Buffer): crypto.KeyObject {
  return crypto.createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: publicKeyRaw.toString('base64url') }, format: 'jwk' });
}

/** Exactly the 32 raw bytes backing an Ed25519 public key, independent of DER/JWK wrapping. */
function publicKeyRawFromKeyObject(publicKey: crypto.KeyObject): Buffer {
  const jwk = publicKey.export({ format: 'jwk' }) as { x?: string };
  if (!jwk.x) throw new Error('ed25519_public_key_export_failed');
  const raw = Buffer.from(jwk.x, 'base64url');
  if (raw.length !== 32) throw new Error('ed25519_public_key_unexpected_length');
  return raw;
}

function toNodeIdentity(stored: StoredIdentityFile): NodeIdentity {
  const privateKey = crypto.createPrivateKey({ key: Buffer.from(stored.privateKey, 'base64url'), format: 'der', type: 'pkcs8' });
  const publicKeyRaw = Buffer.from(stored.publicKey, 'base64url');
  if (publicKeyRaw.length !== 32) {
    // Never interpolate key bytes into an Error message — even a length
    // mismatch is reported without touching the value itself.
    throw new Error('node_identity_public_key_invalid_length');
  }
  return {
    publicKeyRaw,
    publicKeyBase64Url: stored.publicKey,
    fingerprint: nodeFingerprintFromPublicKey(publicKeyRaw),
    createdAt: stored.createdAt,
    sign: (message: Buffer) => crypto.sign(null, message, privateKey),
  };
}

/**
 * In-process cache keyed by resolved state directory. Keeps concurrent callers
 * inside one process (the CLI constructs several services against the same
 * state directory during startup) from each generating and racing to persist
 * a different keypair. Cleared on failure so a transient error (e.g. a full
 * disk) does not permanently wedge every later caller behind one rejection.
 */
const identityCache = new Map<string, Promise<NodeIdentity>>();

export function loadOrCreateNodeIdentity(stateDir: string, logger?: Logger): Promise<NodeIdentity> {
  const resolvedDir = path.resolve(stateDir);
  const cached = identityCache.get(resolvedDir);
  if (cached) return cached;
  const promise = loadOrCreateNodeIdentityUncached(resolvedDir, logger).catch((error: unknown) => {
    identityCache.delete(resolvedDir);
    throw error;
  });
  identityCache.set(resolvedDir, promise);
  return promise;
}

async function loadOrCreateNodeIdentityUncached(stateDir: string, logger?: Logger): Promise<NodeIdentity> {
  await fs.mkdir(stateDir, { recursive: true, mode: 0o700 });
  const filePath = path.join(stateDir, IDENTITY_FILE_NAME);
  const existing = await readIdentityFile(filePath, logger);
  if (existing) return toNodeIdentity(existing);
  const created = await generateAndPersist(stateDir, filePath, logger);
  return toNodeIdentity(created);
}

async function readIdentityFile(filePath: string, logger?: Logger): Promise<StoredIdentityFile | null> {
  let raw: Buffer;
  try {
    raw = await fs.readFile(filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
  // fs.chmod is a documented no-op on Windows (there is no POSIX mode bit to
  // set), so checking or "repairing" it there would log a false guarantee.
  if (process.platform !== 'win32') {
    const stat = await fs.stat(filePath);
    const mode = stat.mode & 0o777;
    if (mode !== 0o600) {
      logger?.warn({ filePath, mode: mode.toString(8) }, 'node identity file was more permissive than 0600; repairing');
      await fs.chmod(filePath, 0o600);
    }
  }
  const parsed = JSON.parse(raw.toString('utf8')) as StoredIdentityFile;
  if (parsed.version !== IDENTITY_FILE_VERSION || parsed.algorithm !== IDENTITY_ALGORITHM) {
    throw new Error('unsupported_node_identity_file');
  }
  return parsed;
}

async function generateAndPersist(stateDir: string, filePath: string, logger?: Logger): Promise<StoredIdentityFile> {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const stored: StoredIdentityFile = {
    version: IDENTITY_FILE_VERSION,
    algorithm: IDENTITY_ALGORITHM,
    createdAt: new Date().toISOString(),
    privateKey: privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64url'),
    publicKey: publicKeyRawFromKeyObject(publicKey).toString('base64url'),
  };
  const tmpPath = path.join(stateDir, `.${IDENTITY_FILE_NAME}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`);
  await fs.writeFile(tmpPath, `${JSON.stringify(stored, null, 2)}\n`, { mode: 0o600 });
  try {
    // `fs.rename` is not usable for the promotion step here: on both POSIX
    // and Windows it silently *overwrites* an existing destination rather
    // than failing, which is exactly wrong for a mint-once file — a second
    // process (or a second caller that lost the in-process cache race, e.g.
    // after a crash-restart) that independently generated its own keypair
    // would clobber an identity another caller may already have loaded,
    // signed with, and handed out. `fs.link` performs the same atomic,
    // same-directory promotion but fails with EEXIST instead of overwriting,
    // so exactly one generated keypair can ever become the persisted
    // identity; every other generator discovers the collision and defers.
    await fs.link(tmpPath, filePath);
  } catch (error) {
    await fs.unlink(tmpPath).catch(() => undefined);
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
      const winner = await readIdentityFile(filePath, logger);
      if (winner) return winner;
    }
    throw error;
  }
  await fs.unlink(tmpPath).catch(() => undefined);
  return stored;
}
