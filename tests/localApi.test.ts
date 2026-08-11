import { afterEach, describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AppConfig } from '../src/config/schema.js';
import { CapabilityRegistry } from '../src/capabilities/registry.js';
import { startGuiServer } from '../src/gui/guiServer.js';
import { PairingService } from '../src/localApi/pairingService.js';
import { ActionLock } from '../src/runtime/actionLock.js';
import { LocalStore } from '../src/state/localStore.js';

const dirs: string[] = [];
afterEach(async () => Promise.all(dirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true }))));

describe('local/v1 authorization', () => {
  it('requires a scoped local credential after one-time pairing', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'kubus-local-api-')); dirs.push(dir);
    const store = new LocalStore(path.join(dir, 'state.json'));
    await store.load();
    await store.getOrCreateNodeKey();
    const config = {
      guiEnabled: false,
      guiHost: '127.0.0.1',
      guiPort: 0,
      localApiEnabled: true,
      localApiHost: '127.0.0.1',
      localApiPort: 0,
      localApiAllowLan: false,
      nodeLabel: 'test-node',
      pairingSessionTtlMs: 60_000,
    } as AppConfig;
    const kubo = {
      id: async () => ({ ID: 'peer-1' }),
      version: async () => ({ Version: '0.41.0' }),
      repoStat: async () => ({ RepoSize: 0, StorageMax: 0 }),
    };
    const pairing = new PairingService(store, config);
    const localApi = {
      api: {} as never,
      kubo: kubo as never,
      store,
      config,
      capabilities: new CapabilityRegistry(kubo as never),
      pairing,
      captures: { list: () => [] } as never,
      jobs: { health: () => ({ running: 0, queued: 0 }), list: () => [] } as never,
      participationGate: { refresh: async () => ({ state: 'CONTRIBUTING', leaseEligible: true }), assertUsefulOperation: async () => undefined } as never,
      remoteCompute: {} as never,
    };
    const server = await startGuiServer({
      api: {} as never,
      kubo: kubo as never,
      store,
      config,
      logger: { info: () => undefined } as never,
      actionLock: new ActionLock(),
      localApi,
    });
    const base = server.url.replace('/gui', '');
    try {
      const unauthorized = await fetch(`${base}/local/v1/info`);
      expect(unauthorized.status).toBe(401);

      const sessionResponse = await fetch(`${base}/local/v1/pairing/session`, { method: 'POST' });
      const sessionBody = await sessionResponse.json() as { data: { sessionId: string; secret: string } };
      const exchangeResponse = await fetch(`${base}/local/v1/pairing/exchange`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(sessionBody.data),
      });
      const exchangeBody = await exchangeResponse.json() as { data: { token: string } };
      const authorized = await fetch(`${base}/local/v1/info`, {
        headers: { Authorization: `Bearer ${exchangeBody.data.token}` },
      });
      expect(authorized.status).toBe(200);
      expect(await authorized.text()).toContain('test-node');
    } finally {
      await server.close();
    }
  });
});
