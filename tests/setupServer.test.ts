import { afterEach, describe, expect, it, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { startSetupServer, type SetupServerHandle } from '../src/gui/setupServer.js';
import { validGuiSession } from '../src/gui/guiSession.js';

let server: SetupServerHandle | undefined;
let directory: string | undefined;
afterEach(async () => {
  await server?.close();
  if (directory) await fs.rm(directory, { recursive: true, force: true });
  vi.restoreAllMocks();
});

async function setup() {
  const listener = net.createServer();
  await new Promise<void>((resolve) => listener.listen(0, '127.0.0.1', resolve));
  const port = (listener.address() as net.AddressInfo).port;
  await new Promise<void>((resolve) => listener.close(() => resolve()));
  directory = await fs.mkdtemp(path.join(os.tmpdir(), 'kubus-setup-security-'));
  const configPath = path.join(directory, 'config.env');
  server = await startSetupServer({ KUBUS_SETUP_HOST: '127.0.0.1', KUBUS_SETUP_PORT: String(port), KUBUS_NODE_CONFIG_PATH: configPath });
  const origin = new URL(server.url).origin;
  const page = await fetch(server.url);
  expect(page.headers.get('access-control-allow-origin')).toBeNull();
  expect(page.headers.get('x-frame-options')).toBe('DENY');
  const html = await page.text();
  const nonce = html.match(/'x-kubus-setup-nonce':'([^']+)'/)?.[1];
  expect(nonce).toMatch(/^[A-Za-z0-9_-]{43}$/);
  return { origin, configPath, headers: { origin, 'content-type': 'application/json', 'x-kubus-setup-nonce': nonce! } };
}

describe('setup HTTP security boundary', () => {
  it.each([
    ['foreign origin', { origin: 'https://attacker.example' }, 403],
    ['text/plain', { 'content-type': 'text/plain' }, 415],
    ['missing nonce', { 'x-kubus-setup-nonce': '' }, 403],
    ['wrong origin port', { origin: 'http://127.0.0.1:1' }, 403],
    ['missing origin', { origin: '' }, 403],
    ['cross-site fetch', { 'sec-fetch-site': 'cross-site' }, 403],
  ])('rejects %s without writing configuration', async (_name, override, status) => {
    const context = await setup();
    const response = await fetch(`${context.origin}/setup/config`, {
      method: 'POST', headers: { ...context.headers, ...override }, body: '{}',
    });
    expect(response.status).toBe(status);
    await expect(fs.stat(context.configPath)).rejects.toThrow();
  });

  it('rejects a DNS-rebinding Host before serving a nonce', async () => {
    const { origin } = await setup();
    const status = await new Promise<number | undefined>((resolve, reject) => {
      http.get(`${origin}/setup`, { headers: { host: 'attacker.example' } }, (response) => {
        response.resume(); resolve(response.statusCode);
      }).on('error', reject);
    });
    expect(status).toBe(403);
  });

  it('rejects oversized and malformed JSON without writing configuration', async () => {
    const { origin, headers, configPath } = await setup();
    for (const [body, status] of [['x'.repeat(17000), 413], ['{', 400], ['[]', 400]] as const) {
      expect((await fetch(`${origin}/setup/config`, { method: 'POST', headers, body })).status).toBe(status);
    }
    await expect(fs.stat(configPath)).rejects.toThrow();
  });

  it('saves once and rejects replay without replacing the configuration', async () => {
    const { origin, headers, configPath } = await setup();
    vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
    // Advanced setup: manual token entry survives for operator recovery, but
    // only when the person explicitly asked for it.
    const body = JSON.stringify({ advanced: true, nodeLabel: 'Home', apiBaseUrl: 'https://api.kubus.site', operatorWallet: 'wallet', operatorToken: 'kubus_node_test' });
    const send = () => fetch(`${origin}/setup/config`, { method: 'POST', headers, body });
    const response = await send();
    expect(response.status).toBe(201);
    const saved = await fs.readFile(configPath, 'utf8');
    const secret = JSON.parse(saved.match(/^NODE_GUI_TOKEN=(.+)$/m)![1]!) as string;
    const cookie = response.headers.get('set-cookie')!;
    expect(cookie).toContain('HttpOnly');
    expect(cookie).not.toContain(secret);
    expect(validGuiSession(cookie.split(';')[0]!.split('=')[1]!, secret)).toBe(true);
    expect((await send()).status).toBe(409);
    expect(await fs.readFile(configPath, 'utf8')).toBe(saved);
    // Let the production restart callback execute while process.exit is mocked.
    await new Promise((resolve) => setTimeout(resolve, 180));
    expect(process.exit).toHaveBeenCalledWith(75);
  });
});
