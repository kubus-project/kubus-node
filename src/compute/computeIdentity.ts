import crypto from 'node:crypto';
import stableStringify from 'json-stable-stringify';
import type { LocalStore } from '../state/localStore.js';

interface StoredIdentity {
  encryptionPublicKey: string;
  encryptionPrivateKey: string;
  signingPublicKey: string;
  signingPrivateKey: string;
  createdAt: string;
}

const exportDer = (key: crypto.KeyObject, type: 'spki' | 'pkcs8') => key.export({ format: 'der', type }).toString('base64');

export class ComputeIdentityService {
  private identity?: StoredIdentity;
  constructor(private readonly store: LocalStore) {}

  async initialize(): Promise<StoredIdentity> {
    const existing = this.store.snapshot().computeIdentity;
    if (existing) { this.identity = existing; return structuredClone(existing); }
    const encryption = crypto.generateKeyPairSync('x25519');
    const signing = crypto.generateKeyPairSync('ed25519');
    const created: StoredIdentity = {
      encryptionPublicKey: exportDer(encryption.publicKey, 'spki'),
      encryptionPrivateKey: exportDer(encryption.privateKey, 'pkcs8'),
      signingPublicKey: exportDer(signing.publicKey, 'spki'),
      signingPrivateKey: exportDer(signing.privateKey, 'pkcs8'),
      createdAt: new Date().toISOString(),
    };
    await this.store.update((state) => { state.computeIdentity = created; });
    this.identity = created;
    return structuredClone(created);
  }

  async publicIdentity(): Promise<{ encryptionPublicKey: string; signingPublicKey: string; createdAt: string }> {
    const value = await this.initialize();
    return { encryptionPublicKey: value.encryptionPublicKey, signingPublicKey: value.signingPublicKey, createdAt: value.createdAt };
  }

  async encryptionPrivateKey(): Promise<crypto.KeyObject> {
    const value = await this.initialize();
    return crypto.createPrivateKey({ key: Buffer.from(value.encryptionPrivateKey, 'base64'), format: 'der', type: 'pkcs8' });
  }

  async signPayload(payload: Record<string, unknown>): Promise<string> {
    const value = await this.initialize();
    const privateKey = crypto.createPrivateKey({ key: Buffer.from(value.signingPrivateKey, 'base64'), format: 'der', type: 'pkcs8' });
    return crypto.sign(null, Buffer.from(stableStringify(payload) ?? '{}'), privateKey).toString('base64');
  }
}
