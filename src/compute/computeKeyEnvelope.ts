import crypto from 'node:crypto';

export interface ComputeKeyEnvelope {
  algorithm: 'X25519-HKDF-SHA256-AES-256-GCM';
  ephemeralPublicKey: string;
  salt: string;
  iv: string;
  authTag: string;
  wrappedKey: string;
  context: string;
}

export function encryptionPublicKey(raw: string): crypto.KeyObject {
  const key = crypto.createPublicKey({ key: Buffer.from(raw, 'base64'), format: 'der', type: 'spki' });
  if (key.asymmetricKeyType !== 'x25519') throw new Error('compute_encryption_key_invalid');
  return key;
}

export function wrapComputeKey(dataKey: Buffer, recipient: crypto.KeyObject, context: string): ComputeKeyEnvelope {
  const ephemeral = crypto.generateKeyPairSync('x25519');
  const shared = crypto.diffieHellman({ privateKey: ephemeral.privateKey, publicKey: recipient });
  const salt = crypto.randomBytes(32);
  const wrappingKey = Buffer.from(crypto.hkdfSync('sha256', shared, salt, Buffer.from(context), 32));
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', wrappingKey, iv);
  cipher.setAAD(Buffer.from(context));
  const wrappedKey = Buffer.concat([cipher.update(dataKey), cipher.final()]);
  return {
    algorithm: 'X25519-HKDF-SHA256-AES-256-GCM',
    ephemeralPublicKey: ephemeral.publicKey.export({ format: 'der', type: 'spki' }).toString('base64'),
    salt: salt.toString('base64'), iv: iv.toString('base64'), authTag: cipher.getAuthTag().toString('base64'),
    wrappedKey: wrappedKey.toString('base64'), context,
  };
}

export function unwrapComputeKey(envelope: ComputeKeyEnvelope, recipient: crypto.KeyObject, context: string): Buffer {
  if (envelope.algorithm !== 'X25519-HKDF-SHA256-AES-256-GCM' || envelope.context !== context) {
    throw new Error('compute_envelope_context_invalid');
  }
  const shared = crypto.diffieHellman({ privateKey: recipient, publicKey: encryptionPublicKey(envelope.ephemeralPublicKey) });
  const salt = Buffer.from(envelope.salt, 'base64');
  const wrappingKey = Buffer.from(crypto.hkdfSync('sha256', shared, salt, Buffer.from(context), 32));
  const unwrap = crypto.createDecipheriv('aes-256-gcm', wrappingKey, Buffer.from(envelope.iv, 'base64'));
  unwrap.setAAD(Buffer.from(context));
  unwrap.setAuthTag(Buffer.from(envelope.authTag, 'base64'));
  return Buffer.concat([unwrap.update(Buffer.from(envelope.wrappedKey, 'base64')), unwrap.final()]);
}
