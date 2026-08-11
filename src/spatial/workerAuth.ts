import crypto from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';

export class WorkerAuthService {
  private secret?: Buffer;
  constructor(private readonly keyPath: string, private readonly now: () => number = Date.now) {}

  async initialize(): Promise<void> {
    await fs.mkdir(path.dirname(this.keyPath), { recursive: true, mode: 0o700 });
    try {
      this.secret = await fs.readFile(this.keyPath);
      if (this.secret.byteLength < 32) throw new Error('worker_auth_key_too_short');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      this.secret = crypto.randomBytes(32);
      await fs.writeFile(this.keyPath, this.secret, { mode: 0o600, flag: 'wx' });
    }
  }

  async issue(jobId: string, type: string, ttlSeconds = 90): Promise<string> {
    if (!this.secret) await this.initialize();
    const payload = Buffer.from(JSON.stringify({ v: 1, jobId, type, iat: Math.floor(this.now() / 1000), exp: Math.floor(this.now() / 1000) + Math.max(15, Math.min(ttlSeconds, 300)), nonce: crypto.randomBytes(12).toString('base64url') })).toString('base64url');
    const signature = crypto.createHmac('sha256', this.secret!).update(payload).digest('base64url');
    return `${payload}.${signature}`;
  }
}
