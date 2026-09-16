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
      await Promise.race([
        once(child.stdout, 'data'),
        exited.then(() => { throw new Error('Progress fixture exited before becoming ready'); }),
      ]);
      const origin = `http://127.0.0.1:${port}`;
      // This small HTTP/1.1 server intentionally closes every response. Do not
      // let undici pre-open an idle keepalive socket ahead of the next request.
      const request = (headers: Record<string, string> = {}, method = 'GET') => new Promise<{ status?: number; body: string }>((resolve, reject) => {
        const req = http.request(`${origin}/status`, { headers, method, agent: false }, (response) => {
          let body = '';
          response.setEncoding('utf8');
          response.on('data', (chunk: string) => { body += chunk; });
          response.on('end', () => resolve({ status: response.statusCode, body }));
        });
        req.on('error', reject);
        req.setTimeout(5000, () => req.destroy(new Error('Progress request timed out')));
        req.end();
      });
      expect(JSON.parse((await request()).body)).toMatchObject({ nextUrl: 'test-only-handoff' });
      const deniedHeaders: Record<string, string>[] = [{ host: 'attacker.test' }, { origin: 'https://attacker.test' }, { 'sec-fetch-site': 'cross-site' }];
      for (const headers of deniedHeaders) {
        expect((await request(headers)).status, JSON.stringify(headers)).toBe(403);
      }
      expect((await request({}, 'POST')).status).toBe(403);
    } finally {
      child.stdin.end('\n');
      await exited;
    }
  }, 20_000);

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
