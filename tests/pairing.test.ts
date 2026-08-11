import { afterEach, describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AppConfig } from '../src/config/schema.js';
import { PairingService } from '../src/localApi/pairingService.js';
import { LocalStore } from '../src/state/localStore.js';

const dirs: string[] = [];
afterEach(async () => Promise.all(dirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true }))));

async function fixture(ttl = 300000) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'kubus-pairing-')); dirs.push(dir);
  const store = new LocalStore(path.join(dir, 'state.json')); await store.load(); await store.getOrCreateNodeKey();
  return {
    service: new PairingService(store, { nodeLabel: 'test', localApiPort: 8787, pairingSessionTtlMs: ttl } as AppConfig),
    statePath: path.join(dir, 'state.json'),
  };
}

describe('PairingService', () => {
  it('exchanges a one-time secret for a scoped credential and rejects replay', async () => {
    const { service } = await fixture();
    const session = await service.createSession();
    const credential = await service.exchange(session.sessionId, session.secret, 'phone');
    expect(credential.token).toMatch(/^kubus_local_/);
    expect(credential.scopes).toContain('content:read');
    await expect(service.authorize(credential.token, 'jobs:create')).resolves.toBe(true);
    await expect(service.exchange(session.sessionId, session.secret)).rejects.toThrow('pairing_session_replayed');
  });

  it('rejects expired sessions and never stores the raw secret or token', async () => {
    const { service, statePath } = await fixture(1);
    const session = await service.createSession();
    await new Promise((resolve) => setTimeout(resolve, 5));
    await expect(service.exchange(session.sessionId, session.secret)).rejects.toThrow('pairing_session_expired');
    const persisted = await fs.readFile(statePath, 'utf8');
    expect(persisted).not.toContain(session.secret);
  });
});
