import { afterEach, describe, expect, it, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import crypto from 'node:crypto';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
// The backend builds the signed message with json-stable-stringify. Using the
// same implementation here is the point: it turns these tests into a real
// cross-repo contract check rather than a restatement of the client's own
// canonicalisation.
import stableStringify from 'json-stable-stringify';
import { startSetupServer, type SetupServerHandle } from '../src/gui/setupServer.js';

let server: SetupServerHandle | undefined;
let backend: http.Server | undefined;
let directory: string | undefined;

afterEach(async () => {
  await server?.close();
  if (backend) await new Promise<void>((resolve) => backend!.close(() => resolve()));
  backend = undefined;
  if (directory) await fs.rm(directory, { recursive: true, force: true });
  vi.restoreAllMocks();
});

async function freePort(): Promise<number> {
  const listener = net.createServer();
  await new Promise<void>((resolve) => listener.listen(0, '127.0.0.1', resolve));
  const port = (listener.address() as net.AddressInfo).port;
  await new Promise<void>((resolve) => listener.close(() => resolve()));
  return port;
}

interface FakeBackend {
  origin: string;
  state: { value: string };
  seen: { create?: Record<string, unknown>; claimed: number; confirmed: number };
  token: string;
}

/**
 * A stand-in control plane that enforces the same signature contract the real
 * backend does, so a Node-side canonicalisation drift fails here instead of in
 * production.
 */
async function startFakeBackend(): Promise<FakeBackend> {
  const port = await freePort();
  const state = { value: 'PENDING' };
  const seen: FakeBackend['seen'] = { claimed: 0, confirmed: 0 };
  const token = `kubus_node_${'a'.repeat(16)}_${'b'.repeat(64)}`;
  let record: { id: string; userCode: string; publicKey: string; claimVerifierHash: string; kind: string; nodeId: string | null };

  const verify = (action: string, publicKey: string, signature: string, fields: Record<string, unknown>): boolean => {
    const message = Buffer.from(`kubus.node-installation/1\n${stableStringify({ action, ...fields })}`);
    const key = crypto.createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: publicKey }, format: 'jwk' });
    return crypto.verify(null, message, key, Buffer.from(signature, 'base64url'));
  };

  backend = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk) => chunks.push(chunk as Buffer));
    req.on('end', () => {
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
      const reply = (status: number, data: unknown) => {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ success: status < 400, data, errorCode: status >= 400 ? 'REJECTED' : undefined }));
      };
      const url = req.url || '';
      if (url === '/api/availability/node-installations') {
        seen.create = body;
        if (!verify('create', body.publicKey, body.signature, {
          id: null, userCode: null, publicKey: body.publicKey,
          claimVerifierHash: body.claimVerifierHash, kind: body.kind, nodeId: body.nodeId ?? null,
        })) return reply(403, null);
        record = {
          id: '11111111-2222-4333-8444-555555555555', userCode: 'ABCD2345',
          publicKey: body.publicKey, claimVerifierHash: body.claimVerifierHash,
          kind: body.kind, nodeId: body.nodeId ?? null,
        };
        return reply(201, { installationId: record.id, userCode: record.userCode, expiresAt: new Date(Date.now() + 900000).toISOString() });
      }
      if (url.endsWith('/status')) {
        if (crypto.createHash('sha256').update(body.claimVerifier).digest('hex') !== record.claimVerifierHash) return reply(403, null);
        return reply(200, { state: state.value });
      }
      if (url.endsWith('/claim')) {
        if (state.value !== 'AUTHORIZED') return reply(409, null);
        if (crypto.createHash('sha256').update(body.claimVerifier).digest('hex') !== record.claimVerifierHash) return reply(403, null);
        if (!verify('claim', record.publicKey, body.signature, {
          id: record.id, userCode: record.userCode, publicKey: record.publicKey,
          claimVerifierHash: record.claimVerifierHash, kind: record.kind, nodeId: record.nodeId,
        })) return reply(403, null);
        seen.claimed += 1;
        state.value = 'DELIVERED';
        return reply(200, { installationId: record.id, kind: record.kind, token, wallet: 'AccountWallet111', nodeId: record.nodeId, scopes: [], replacesTokenId: null });
      }
      if (url.endsWith('/confirm')) {
        if (!verify('confirm', record.publicKey, body.signature, {
          id: record.id, userCode: record.userCode, publicKey: record.publicKey,
          claimVerifierHash: record.claimVerifierHash, kind: record.kind, nodeId: record.nodeId,
        })) return reply(403, null);
        seen.confirmed += 1;
        return reply(200, { state: 'CONFIRMED' });
      }
      return reply(404, null);
    });
  });
  await new Promise<void>((resolve) => backend!.listen(port, '127.0.0.1', resolve));
  return { origin: `http://127.0.0.1:${port}`, state, seen, token };
}

async function setup() {
  const port = await freePort();
  directory = await fs.mkdtemp(path.join(os.tmpdir(), 'kubus-setup-account-'));
  const configPath = path.join(directory, 'config.env');
  server = await startSetupServer({
    KUBUS_SETUP_HOST: '127.0.0.1',
    KUBUS_SETUP_PORT: String(port),
    KUBUS_NODE_CONFIG_PATH: configPath,
    LOCAL_STATE_PATH: path.join(directory, 'state.json'),
  });
  const origin = new URL(server.url).origin;
  const html = await (await fetch(server.url)).text();
  const nonce = html.match(/'x-kubus-setup-nonce':'([^']+)'/)?.[1];
  return {
    origin, configPath, html,
    headers: { origin, 'content-type': 'application/json', 'x-kubus-setup-nonce': nonce! },
  };
}

describe('account-authorized Node setup', () => {
  it('the ordinary setup page never asks for a scoped Node token', async () => {
    const { html } = await setup();
    const beforeAdvanced = html.slice(0, html.indexOf('Advanced setup'));
    expect(beforeAdvanced).not.toMatch(/operatorToken/);
    expect(beforeAdvanced).not.toMatch(/operatorWallet/);
    // It is still reachable, but only inside the Advanced disclosure.
    expect(html).toMatch(/<details><summary>Advanced setup<\/summary>/);
    expect(html.slice(html.indexOf('Advanced setup'))).toMatch(/operatorToken/);
  });

  it('does not leave the operator at "restarting" with no way to tell it worked', async () => {
    const { html } = await setup();
    // Saving restarts the runtime, which is invisible from the page. Ending
    // there is why a working Node reads as a failed install: the last thing
    // anyone saw was "restarting". The page has to watch for the runtime
    // coming back and then say so.
    expect(html).toMatch(/kubus-setup-waiting/);
    // It watches the runtime's own dashboard route, which only answers once
    // the configured Node has replaced this bootstrap server.
    expect(html).toMatch(/\/gui/);
    expect(html).toMatch(/Open dashboard/i);
    // And it must say the Node is connected, not merely that a file was saved.
    expect(html).toMatch(/connected/i);
  });

  it('refuses a pasted operator token on the ordinary path', async () => {
    const { origin, headers, configPath } = await setup();
    const response = await fetch(`${origin}/setup/config`, {
      method: 'POST',
      headers,
      // No `advanced`, so this is the ordinary path: a token pasted here must
      // not be honoured, or the raw-token flow is back in front of everyone.
      body: JSON.stringify({
        nodeLabel: 'Home', apiBaseUrl: 'https://api.kubus.site',
        operatorWallet: 'wallet', operatorToken: 'kubus_node_smuggled',
      }),
    });
    expect(response.status).toBe(400);
    await expect(fs.readFile(configPath, 'utf8')).rejects.toThrow();
  });

  it('completes install -> authorize -> credential without anyone typing a token', async () => {
    const fake = await startFakeBackend();
    const { origin, headers, configPath } = await setup();
    vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);

    const started = await fetch(`${origin}/setup/account/start`, {
      method: 'POST', headers,
      body: JSON.stringify({ nodeLabel: 'Studio', apiBaseUrl: fake.origin }),
    });
    expect(started.status).toBe(201);
    const startBody = await started.json();
    expect(startBody.userCode).toBe('ABCD2345');
    expect(startBody.fingerprint).toMatch(/^[a-f0-9]{64}$/);
    // The verifier that authorises collection never leaves the Node process.
    expect(JSON.stringify(startBody)).not.toContain(fake.seen.create!.claimVerifierHash as string);

    const poll = () => fetch(`${origin}/setup/account/poll`, { method: 'POST', headers, body: '{}' });
    expect((await (await poll()).json()).ready).toBe(false);

    fake.state.value = 'AUTHORIZED';
    const ready = await (await poll()).json();
    expect(ready.ready).toBe(true);
    expect(fake.seen.claimed).toBe(1);

    const saved = await fetch(`${origin}/setup/config`, {
      method: 'POST', headers,
      body: JSON.stringify({ nodeLabel: 'Studio', apiBaseUrl: fake.origin, archiveRecords: 10, archiveBytes: 1024 }),
    });
    expect(saved.status).toBe(201);
    const config = await fs.readFile(configPath, 'utf8');
    expect(config).toContain(`KUBUS_OPERATOR_TOKEN=${JSON.stringify(fake.token)}`);
    expect(config).toContain('KUBUS_OPERATOR_WALLET="AccountWallet111"');
    // Confirmation happens only after the credential is durably written.
    expect(fake.seen.confirmed).toBe(1);
    // Let the restart callback fire before afterEach restores process.exit.
    await new Promise((resolve) => setTimeout(resolve, 180));
    expect(process.exit).toHaveBeenCalledWith(75);
  });

  it('never echoes the collected credential back to the setup page', async () => {
    const fake = await startFakeBackend();
    const { origin, headers } = await setup();
    await fetch(`${origin}/setup/account/start`, {
      method: 'POST', headers, body: JSON.stringify({ nodeLabel: 'Studio', apiBaseUrl: fake.origin }),
    });
    fake.state.value = 'AUTHORIZED';
    const body = await (await fetch(`${origin}/setup/account/poll`, { method: 'POST', headers, body: '{}' })).text();
    expect(body).not.toContain(fake.token);
  });

  // The account flow must not become a hole in the boundary the setup server
  // already enforced for /setup/config.
  describe.each(['/setup/account/start', '/setup/account/poll'])('%s keeps the setup boundary', (route) => {
    it.each([
      ['foreign origin', { origin: 'https://attacker.example' }, 403],
      ['text/plain', { 'content-type': 'text/plain' }, 415],
      ['missing nonce', { 'x-kubus-setup-nonce': '' }, 403],
      ['cross-site fetch', { 'sec-fetch-site': 'cross-site' }, 403],
    ])('rejects %s', async (_name, override, status) => {
      const { origin, headers } = await setup();
      const response = await fetch(`${origin}${route}`, {
        method: 'POST',
        headers: { ...headers, ...override } as Record<string, string>,
        body: JSON.stringify({ nodeLabel: 'Home', apiBaseUrl: 'https://api.kubus.site' }),
      });
      expect(response.status).toBe(status);
    });

    it('rejects a foreign Host header', async () => {
      const { origin, headers } = await setup();
      // fetch() treats Host as a forbidden header and drops it silently, which
      // would make this assertion vacuous. Raw http.request actually sends it.
      const status = await new Promise<number>((resolve, reject) => {
        const request = http.request(`${origin}${route}`, {
          method: 'POST',
          headers: { ...headers, host: 'evil.example' },
        }, (response) => { response.resume(); resolve(response.statusCode || 0); });
        request.on('error', reject);
        request.end(JSON.stringify({ nodeLabel: 'Home', apiBaseUrl: 'https://api.kubus.site' }));
      });
      expect(status).toBe(403);
    });

    it('rejects a query string', async () => {
      const { origin, headers } = await setup();
      const response = await fetch(`${origin}${route}?token=secret`, {
        method: 'POST', headers, body: '{}',
      });
      expect(response.status).toBe(400);
    });

    it('rejects a body over the 16 KiB limit', async () => {
      const { origin, headers } = await setup();
      const response = await fetch(`${origin}${route}`, {
        method: 'POST', headers,
        body: JSON.stringify({ nodeLabel: 'x'.repeat(32 * 1024), apiBaseUrl: 'https://api.kubus.site' }),
      });
      expect(response.status).toBe(413);
    });
  });
});
