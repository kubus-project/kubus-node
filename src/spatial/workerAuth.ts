import crypto from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';

/** What a worker token is for: the endpoint, and for `process` the exact request it authorizes. */
export type WorkerTokenBinding =
  | { purpose: 'cancel' }
  | { purpose: 'process'; captureDirectory: string; outputDirectory: string; input: Record<string, unknown> | undefined };

/** The masking request as the worker reads it: `p` for photos, `v` for video, in that order. */
function maskFlags(input: Record<string, unknown> | undefined): string {
  const mask = input?.maskFaces as { photos?: unknown; video?: unknown } | undefined;
  if (!mask || typeof mask !== 'object') return '';
  return `${mask.photos === true ? 'p' : ''}${mask.video === true ? 'v' : ''}`;
}

/**
 * Issues the Node-to-worker request tokens. A token is single use (the worker remembers each nonce until it expires)
 * and says which endpoint it is for. A `process` token also names the capture and output directories, the input mode
 * and the masking request, and the worker refuses a request that differs in any of them, so a captured header cannot
 * be replayed with other paths or with masking switched off. Worker protocol 2.
 */
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

  async issue(jobId: string, type: string, binding: WorkerTokenBinding, ttlSeconds = 90): Promise<string> {
    if (!this.secret) await this.initialize();
    const iat = Math.floor(this.now() / 1000);
    const claims = {
      v: 2, jobId, type, purpose: binding.purpose, iat, exp: iat + Math.max(15, Math.min(ttlSeconds, 300)), nonce: crypto.randomBytes(12).toString('base64url'),
      ...(binding.purpose === 'process' ? {
        capture: binding.captureDirectory, output: binding.outputDirectory,
        mode: typeof binding.input?.mode === 'string' && binding.input.mode ? binding.input.mode : 'frames', mask: maskFlags(binding.input),
      } : {}),
    };
    const payload = Buffer.from(JSON.stringify(claims)).toString('base64url');
    const signature = crypto.createHmac('sha256', this.secret!).update(payload).digest('base64url');
    return `${payload}.${signature}`;
  }
}
