import { afterEach, describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AppConfig } from '../src/config/schema.js';
import { PairingAttemptLimiter, PairingService, pairingAttemptKey, serializePairingPayload } from '../src/localApi/pairingService.js';
import { renderQrSvg } from '../src/gui/qr.js';
import { LocalStore } from '../src/state/localStore.js';

const dirs: string[] = [];
afterEach(async () => Promise.all(dirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true }))));

async function fixture(ttl = 300000) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'kubus-pairing-')); dirs.push(dir);
  const store = new LocalStore(path.join(dir, 'state.json')); await store.load(); await store.getOrCreateNodeKey();
  return {
    service: new PairingService(store, {
      nodeLabel: 'test', localApiPort: 8787, pairingSessionTtlMs: ttl,
      localApiAllowLan: true,
      localApiLanUrl: 'http://192.168.1.24:8787', localApiRemoteUrl: 'https://node.example.test',
    } as AppConfig),
    statePath: path.join(dir, 'state.json'),
  };
}

describe('PairingService', () => {
  it('rate limits repeated failed remote exchange attempts without storing secrets', () => {
    const limiter = new PairingAttemptLimiter(2, 60_000);
    limiter.assertAllowed('198.51.100.4', 100);
    limiter.failed('198.51.100.4', 100);
    limiter.assertAllowed('198.51.100.4', 101);
    limiter.failed('198.51.100.4', 101);
    expect(() => limiter.assertAllowed('198.51.100.4', 102)).toThrow('pairing_rate_limited');
    limiter.succeeded('198.51.100.4');
    expect(() => limiter.assertAllowed('198.51.100.4', 103)).not.toThrow();
  });

  it('isolates attempt budgets by session behind one reverse proxy', () => {
    const limiter = new PairingAttemptLimiter(2, 60_000);
    const first = pairingAttemptKey('10.0.0.10', 'attacker-session');
    const legitimate = pairingAttemptKey('10.0.0.10', 'legitimate-session');
    limiter.failed(first, 100);
    limiter.failed(first, 101);

    expect(() => limiter.assertAllowed(first, 102)).toThrow('pairing_rate_limited');
    expect(() => limiter.assertAllowed(legitimate, 102)).not.toThrow();
    expect(first).not.toContain('attacker-session');
  });

  it('globally expires stale limiter keys and caps adversarial session cardinality', () => {
    const limiter = new PairingAttemptLimiter(2, 10, 2);
    limiter.failed('old', 1);
    limiter.failed('second', 2);
    limiter.failed('third', 3);
    // The bounded map evicts the oldest live key when a third distinct session
    // arrives, so it cannot grow with attacker-controlled session IDs.
    expect(() => limiter.assertAllowed('old', 4)).not.toThrow();
    limiter.failed('expiring', 4);
    expect(() => limiter.assertAllowed('expiring', 15)).not.toThrow();
  });

  it('rate limits a flood that rotates random session IDs', () => {
    const limiter = new PairingAttemptLimiter(5, 60_000, 4096, 3);
    for (let index = 0; index < 3; index += 1) {
      const key = pairingAttemptKey('10.0.0.10', `random-${index}`);
      limiter.assertAllowed(key, 100 + index);
      limiter.failed(key, 100 + index);
    }
    expect(() => limiter.assertAllowed(pairingAttemptKey('10.0.0.10', 'random-4'), 104))
      .toThrow('pairing_rate_limited');
    expect(() => limiter.assertAllowed(pairingAttemptKey('10.0.0.10', 'after-window'), 60_101))
      .not.toThrow();
  });

  it('creates a stable persisted identity before an unregistered GUI pairs', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'kubus-pairing-fresh-')); dirs.push(dir);
    const statePath = path.join(dir, 'state.json');
    const config = {
      nodeLabel: 'fresh', localApiPort: 8787, pairingSessionTtlMs: 300000,
      localApiAllowLan: true, localApiLanUrl: 'http://192.168.1.24:8787',
    } as AppConfig;
    const firstStore = new LocalStore(statePath); await firstStore.load();
    const first = await new PairingService(firstStore, config).createSession();
    expect(firstStore.snapshot().nodeKey).toBeTruthy();

    const restartedStore = new LocalStore(statePath); await restartedStore.load();
    const second = await new PairingService(restartedStore, config).createSession();
    expect(second.node.id).toBe(first.node.id);
    expect(second.node.fingerprint).toBe(first.node.fingerprint);
  });

  it('does not advertise a configured LAN URL while LAN access is disabled', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'kubus-pairing-remote-')); dirs.push(dir);
    const store = new LocalStore(path.join(dir, 'state.json')); await store.load();
    const service = new PairingService(store, {
      nodeLabel: 'remote-only', localApiPort: 8787, pairingSessionTtlMs: 300000,
      localApiAllowLan: false,
      localApiLanUrl: 'http://192.168.1.24:8787',
      localApiRemoteUrl: 'https://node.example.test',
    } as AppConfig);
    const session = await service.createSession();
    expect(session.node.endpoints).toEqual(['https://node.example.test']);
    expect(new URL(session.payload).searchParams.get('e')).toBe('https://node.example.test');
  });
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

  it('uses one versioned payload for pairing and preserves LAN then remote endpoints', async () => {
    const { service } = await fixture();
    const session = await service.createSession();
    expect(session.payload).toBe(serializePairingPayload({
      endpoint: session.node.endpoint,
      alternateEndpoints: session.node.endpoints.slice(1),
      sessionId: session.sessionId,
      secret: session.secret,
      nodeId: session.node.id!,
      label: session.node.label,
      fingerprint: session.node.fingerprint,
    }));
    const uri = new URL(session.payload);
    expect(uri.searchParams.get('v')).toBe('2');
    expect(uri.searchParams.get('e')).toBe('http://192.168.1.24:8787');
    expect(uri.searchParams.getAll('a')).toEqual(['https://node.example.test']);
    expect(uri.searchParams.get('n')).toBe(session.node.id);
    expect(uri.searchParams.get('f')).toHaveLength(64);
  });

  it('keeps complete identity metadata in a dense maintained QR', async () => {
    const payload = serializePairingPayload({
      endpoint: 'https://a-very-long-tunnel-hostname-for-a-kubus-node.example.test/local/v1',
      alternateEndpoints: ['http://192.168.100.200:8787'],
      sessionId: '8f14e45f-ea4e-4e2f-9c1a-2b3c4d5e6f70',
      secret: 'x'.repeat(43),
      nodeId: 'node-8f14e45f-ea4e-4e2f-9c1a-2b3c4d5e6f70',
      label: 'Ž'.repeat(80),
      fingerprint: 'f'.repeat(64),
    });
    const uri = new URL(payload);
    expect(uri.searchParams.get('f')).toBe('f'.repeat(64));
    expect(uri.searchParams.get('l')!.length).toBe(80);
    await expect(renderQrSvg(payload)).resolves.toContain('<svg');
  });
});
