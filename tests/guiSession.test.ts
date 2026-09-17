import { afterEach, describe, expect, it } from 'vitest';
import { GuiHandoffs, guiSessionCookie, validGuiSession } from '../src/gui/guiSession.js';
import { startGuiServer, type GuiServerHandle } from '../src/gui/guiServer.js';
import type { AppConfig } from '../src/config/schema.js';

let server: GuiServerHandle | undefined;
afterEach(async () => { await server?.close(); server = undefined; });
const secret = 'test-gui-credential';
const cookieValue = (cookie: string) => cookie.split(';')[0]!.split('=')[1]!;

describe('GUI browser sessions', () => {
  it('expires, rejects tampering and credential rotation, and survives a process restart', () => {
    const now = Date.now();
    const cookie = guiSessionCookie(secret, now);
    expect(cookie).toContain('HttpOnly; SameSite=Strict; Max-Age=43200');
    expect(cookie).not.toContain(secret);
    const value = cookieValue(cookie);
    expect(validGuiSession(value, secret, now)).toBe(true);
    expect(validGuiSession(value, secret, now + 43_200_000)).toBe(false);
    expect(validGuiSession(value, 'rotated', now)).toBe(false);
    expect(validGuiSession(value + 'x', secret, now)).toBe(false);
    expect(validGuiSession(secret, secret, now)).toBe(false);
  });

  it('bounds handoffs, expires them, consumes once, and rejects a new process', () => {
    const tickets = new GuiHandoffs();
    const first = tickets.issue(0)!;
    expect(new GuiHandoffs().consume(first, 1)).toBe(false);
    for (let i = 1; i < 8; i++) expect(tickets.issue(0)).toBeDefined();
    expect(tickets.issue(0)).toBeUndefined();
    expect(tickets.consume(first, 1)).toBe(true);
    expect(tickets.consume(first, 2)).toBe(false);
    const expired = tickets.issue(2)!;
    expect(tickets.consume(expired, 60_002)).toBe(false);
    expect(tickets.issue(60_002)).toBeDefined();
  });

  it('requires the configured credential, exchanges only same-origin, and protects cookie mutations', async () => {
    server = await startGuiServer({
      config: { guiEnabled: true, guiHost: '127.0.0.1', guiPort: 0, guiToken: secret } as AppConfig,
      logger: { info: () => undefined } as never,
      api: {} as never, kubo: {} as never, store: {} as never, actionLock: {} as never,
    });
    const origin = new URL(server.url).origin;
    const mint = (authorization = '') => fetch(`${origin}/gui/api/session/handoff`, {
      method: 'POST', headers: { authorization }, body: '{}',
    });
    expect((await mint()).status).toBe(401);
    expect((await mint('Bearer wrong')).status).toBe(401);
    const issued = await mint(`Bearer ${secret}`);
    expect(issued.status).toBe(201);
    expect(issued.headers.get('cache-control')).toBe('no-store');
    const { ticket } = await issued.json() as { ticket: string };
    const exchange = (headers: Record<string, string>, body = JSON.stringify({ ticket })) => fetch(`${origin}/gui/session`, {
      method: 'POST', headers, body,
    });
    const headers = { origin, 'content-type': 'application/json' };
    expect((await exchange({ ...headers, origin: 'https://attacker.test' })).status).toBe(403);
    expect((await exchange({ ...headers, 'sec-fetch-site': 'cross-site' })).status).toBe(403);
    expect((await exchange({ ...headers, 'content-type': 'text/plain' })).status).toBe(415);
    expect((await exchange(headers, 'x'.repeat(1025))).status).toBe(413);
    const signedIn = await exchange(headers);
    expect(signedIn.status).toBe(200);
    expect((await exchange(headers)).status).toBe(401);
    const cookie = signedIn.headers.get('set-cookie')!.split(';')[0]!;
    expect(cookie).not.toContain(secret);
    expect((await fetch(`${origin}/gui/api/logs`, { headers: { cookie } })).status).toBe(200);
    expect((await fetch(`${origin}/gui/api/logs`, { method: 'DELETE', headers: { cookie } })).status).toBe(401);
    expect((await fetch(`${origin}/gui/api/logs`, { method: 'DELETE', headers: { cookie, origin } })).status).toBe(200);
    expect((await fetch(`${origin}/gui/api/session/handoff`, { method: 'POST', headers: { cookie, origin } })).status).toBe(401);
    await server.close();
    server = await startGuiServer({
      config: { guiEnabled: true, guiHost: '127.0.0.1', guiPort: 0, guiToken: secret } as AppConfig,
      logger: { info: () => undefined } as never,
      api: {} as never, kubo: {} as never, store: {} as never, actionLock: {} as never,
    });
    expect((await fetch(server.url + '/api/logs', { headers: { cookie } })).status).toBe(200);
  });
});
