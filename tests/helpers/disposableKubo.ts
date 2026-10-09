import { spawn, type ChildProcess } from 'node:child_process';
import { promises as fs } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

/**
 * A throwaway, offline Kubo for integration tests.
 *
 * Tests that call `repo/gc` or unpin are destructive, so this never attaches to
 * a Kubo it did not start: it initialises a brand-new repository in a temp
 * directory, listens only on loopback ports it picked, joins no network
 * (`--offline`, no swarm addresses, no bootstrap peers) and deletes the whole
 * repository on stop.
 *
 * Set `KUBUS_TEST_KUBO_BIN` to a Kubo binary (>= 0.40) to enable the tests that
 * use it; without it they are skipped, never faked.
 */
export interface DisposableKubo {
  apiUrl: string;
  stop: () => Promise<void>;
}

export const kuboBinary = (): string | undefined => process.env.KUBUS_TEST_KUBO_BIN?.trim() || undefined;

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as net.AddressInfo;
      server.close(() => resolve(port));
    });
  });
}

function run(bin: string, args: string[], repo: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { env: { ...process.env, IPFS_PATH: repo }, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    child.stdout.on('data', (chunk: Buffer) => { output += chunk.toString(); });
    child.stderr.on('data', (chunk: Buffer) => { output += chunk.toString(); });
    child.once('error', reject);
    child.once('exit', (code) => (code === 0 ? resolve(output) : reject(new Error(`ipfs ${args.join(' ')} exited ${code}: ${output.slice(-300)}`))));
  });
}

export async function startDisposableKubo(): Promise<DisposableKubo> {
  const bin = kuboBinary();
  if (!bin) throw new Error('KUBUS_TEST_KUBO_BIN is not set');
  const repo = await fs.mkdtemp(path.join(os.tmpdir(), 'kubus-test-kubo-'));
  const apiPort = await freePort();
  const gatewayPort = await freePort();
  let daemon: ChildProcess | undefined;
  const cleanup = async () => {
    if (daemon && daemon.exitCode === null) {
      daemon.kill('SIGTERM');
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => { daemon?.kill('SIGKILL'); resolve(); }, 8000);
        daemon!.once('exit', () => { clearTimeout(timer); resolve(); });
      });
    }
    await fs.rm(repo, { recursive: true, force: true });
  };
  try {
    await run(bin, ['init', '--profile=test'], repo);
    await run(bin, ['config', 'Addresses.API', `/ip4/127.0.0.1/tcp/${apiPort}`], repo);
    await run(bin, ['config', 'Addresses.Gateway', `/ip4/127.0.0.1/tcp/${gatewayPort}`], repo);
    await run(bin, ['config', '--json', 'Addresses.Swarm', '[]'], repo);
    await run(bin, ['config', '--json', 'Bootstrap', '[]'], repo);
    daemon = spawn(bin, ['daemon', '--offline'], { env: { ...process.env, IPFS_PATH: repo }, stdio: 'ignore' });
    const apiUrl = `http://127.0.0.1:${apiPort}`;
    const deadline = Date.now() + 30_000;
    for (;;) {
      try {
        const response = await fetch(`${apiUrl}/api/v0/version`, { method: 'POST', signal: AbortSignal.timeout(2000) });
        if (response.ok) break;
      } catch { /* not up yet */ }
      if (daemon.exitCode !== null) throw new Error(`kubo daemon exited early with ${daemon.exitCode}`);
      if (Date.now() > deadline) throw new Error('kubo daemon did not become ready');
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    return { apiUrl, stop: cleanup };
  } catch (error) {
    await cleanup();
    throw error;
  }
}

/** Raw API call for the few things KuboClient deliberately does not expose (GC, direct pins). */
export async function kuboRaw(apiUrl: string, command: string, params: Record<string, string> = {}): Promise<string> {
  const query = new URLSearchParams(params).toString();
  const response = await fetch(`${apiUrl}/api/v0/${command}${query ? `?${query}` : ''}`, { method: 'POST' });
  const text = await response.text();
  if (!response.ok) throw new Error(`kubo ${command} failed with HTTP ${response.status}: ${text.slice(0, 200)}`);
  return text;
}
