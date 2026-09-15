import { execFile, spawn } from 'node:child_process';
import { once } from 'node:events';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';

describe.skipIf(process.platform !== 'win32')('real Windows PowerShell launcher handoff', () => {
  it('protects the live progress handoff from cross-site and rebinding reads', async () => {
    const reservation = http.createServer();
    await new Promise<void>((resolve) => reservation.listen(0, '127.0.0.1', resolve));
    const port = (reservation.address() as AddressInfo).port;
    await new Promise<void>((resolve) => reservation.close(() => resolve()));
    const child = spawn('powershell.exe', ['-NoProfile', '-File', path.resolve('tests/fixtures/gui-progress.ps1'), '-Port', String(port)], { windowsHide: true });
    const exited = once(child, 'exit');
    try {
      await once(child.stdout, 'data');
      const origin = `http://127.0.0.1:${port}`;
      const request = (headers: Record<string, string> = {}) => fetch(`${origin}/status`, { headers });
      expect(await (await request()).json()).toMatchObject({ nextUrl: 'test-only-handoff' });
      const deniedHeaders: Record<string, string>[] = [{ host: 'attacker.test' }, { origin: 'https://attacker.test' }, { 'sec-fetch-site': 'cross-site' }];
      for (const headers of deniedHeaders) {
        const status = await new Promise<number | undefined>((resolve, reject) => {
          http.get(`${origin}/status`, { headers }, (response) => {
            response.resume(); resolve(response.statusCode);
          }).on('error', reject);
        });
        expect(status, JSON.stringify(headers)).toBe(403);
      }
      expect((await fetch(`${origin}/status`, { method: 'POST' })).status).toBe(403);
    } finally {
      child.stdin.end('\n');
      await exited;
    }
  });

  it('authenticates over HTTP and returns only the one-use fragment', async () => {
    let calls = 0;
    const ticket = 'a'.repeat(43);
    const server = http.createServer((req, res) => {
      calls++;
      expect(req.url).toBe('/gui/api/session/handoff');
      expect(req.method).toBe('POST');
      expect(req.headers.authorization).toBe('Bearer test-windows-gui-credential');
      res.writeHead(201, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ticket }));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    try {
      const result = await promisify(execFile)('powershell.exe', [
        '-NoProfile', '-File', path.resolve('tests/fixtures/gui-handoff.ps1'), '-Origin', origin,
      ], { windowsHide: true });
      expect(calls).toBe(1);
      expect(result.stdout.trim()).toBe(`${origin}/gui#handoff=${ticket}`);
      expect(result.stderr).toBe('');
      expect(result.stdout).not.toContain('test-windows-gui-credential');
    } finally { await new Promise<void>((resolve) => server.close(() => resolve())); }
  });
});
