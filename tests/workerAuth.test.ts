import crypto from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { WorkerAuthService } from '../src/spatial/workerAuth.js';

const dirs: string[] = [];
afterEach(async () => Promise.all(dirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true }))));

describe('spatial worker authorization', () => {
  it('issues a short-lived HMAC token bound to job ID and type', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'kubus-worker-auth-')); dirs.push(dir);
    const keyPath = path.join(dir, 'worker.key'); const service = new WorkerAuthService(keyPath, () => 1_000_000);
    const token = await service.issue('job-1', 'spatial.reconstruct', 60);
    const [payload, signature] = token.split('.'); const secret = await fs.readFile(keyPath);
    expect(signature).toBe(crypto.createHmac('sha256', secret).update(payload!).digest('base64url'));
    const claims = JSON.parse(Buffer.from(payload!, 'base64url').toString()) as { jobId: string; type: string; exp: number };
    expect(claims).toMatchObject({ jobId: 'job-1', type: 'spatial.reconstruct', exp: 1060 });
  });
});
