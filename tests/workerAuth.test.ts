import crypto from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { WorkerAuthService } from '../src/spatial/workerAuth.js';

const dirs: string[] = [];
afterEach(async () => Promise.all(dirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true }))));

describe('spatial worker authorization', () => {
  const claimsOf = (token: string) => JSON.parse(Buffer.from(token.split('.')[0]!, 'base64url').toString()) as Record<string, unknown>;
  async function service(now = () => 1_000_000) {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'kubus-worker-auth-')); dirs.push(dir);
    const keyPath = path.join(dir, 'worker.key');
    return { keyPath, auth: new WorkerAuthService(keyPath, now) };
  }

  it('issues a short-lived HMAC token bound to job ID, type and the endpoint it is for', async () => {
    const { keyPath, auth } = await service();
    const token = await auth.issue('job-1', 'spatial.reconstruct', { purpose: 'cancel' }, 60);
    const [payload, signature] = token.split('.'); const secret = await fs.readFile(keyPath);
    expect(signature).toBe(crypto.createHmac('sha256', secret).update(payload!).digest('base64url'));
    expect(claimsOf(token)).toMatchObject({ v: 2, jobId: 'job-1', type: 'spatial.reconstruct', purpose: 'cancel', exp: 1060 });
    // A cancel token names no directories.
    expect(claimsOf(token)).not.toHaveProperty('capture');
  });

  it('binds a process token to the capture and output directories, the input mode and the masking request', async () => {
    const { auth } = await service();
    const input = { mode: 'source_set', maskFaces: { photos: true, video: true } };
    const token = await auth.issue('job-1', 'spatial.reconstruct', { purpose: 'process', captureDirectory: '/data/set', outputDirectory: '/data/out', input });
    expect(claimsOf(token)).toMatchObject({ purpose: 'process', capture: '/data/set', output: '/data/out', mode: 'source_set', mask: 'pv' });
    // The defaults the worker applies: no mode is `frames`, no masking request is none.
    const bare = await auth.issue('job-1', 'spatial.reconstruct', { purpose: 'process', captureDirectory: '/a', outputDirectory: '/b', input: {} });
    expect(claimsOf(bare)).toMatchObject({ mode: 'frames', mask: '' });
    const video = await auth.issue('job-1', 'spatial.reconstruct', { purpose: 'process', captureDirectory: '/a', outputDirectory: '/b', input: { mode: 'video', maskFaces: { video: true, photos: false } } });
    expect(claimsOf(video)).toMatchObject({ mode: 'video', mask: 'v' });
  });

  it('gives every token its own nonce and keeps the lifetime within 15 s to 300 s', async () => {
    const { auth } = await service();
    const nonces = new Set<unknown>();
    for (let i = 0; i < 5; i += 1) nonces.add(claimsOf(await auth.issue('job-1', 'spatial.reconstruct', { purpose: 'cancel' })).nonce);
    expect(nonces.size).toBe(5);
    expect(claimsOf(await auth.issue('job-1', 'spatial.reconstruct', { purpose: 'cancel' }))).toMatchObject({ iat: 1000, exp: 1090 });
    expect(claimsOf(await auth.issue('job-1', 'spatial.reconstruct', { purpose: 'cancel' }, 5000))).toMatchObject({ exp: 1300 });
    expect(claimsOf(await auth.issue('job-1', 'spatial.reconstruct', { purpose: 'cancel' }, 1))).toMatchObject({ exp: 1015 });
  });
});
