import { spawnSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mergeEnvText } from '../src/installer/runtimeEnv.js';
import { envUpdatesFor } from '../src/installer/spatialWorker.js';

/**
 * The release Compose file, evaluated by the real `docker compose config`
 * (which needs no daemon). This is where the installer's decision either takes
 * effect or silently does not: whether the profile activates from runtime.env,
 * whether an empty worker URL stays empty, and what the worker is given.
 */

const composeAvailable = spawnSync('docker', ['compose', 'version'], { encoding: 'utf8' }).status === 0;
const template = path.resolve('docker-compose.release.template.yml');

let dir: string;
let composeFile: string;

beforeAll(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'kubus-compose-'));
  composeFile = path.join(dir, 'docker-compose.release.yml');
  const rendered = (await fs.readFile(template, 'utf8'))
    .replaceAll('__KUBUS_NODE_IMAGE__', `ghcr.io/kubus-project/kubus-node@sha256:${'a'.repeat(64)}`)
    .replaceAll('__KUBUS_SPATIAL_WORKER_IMAGE__', `ghcr.io/kubus-project/kubus-spatial-worker@sha256:${'b'.repeat(64)}`);
  await fs.writeFile(composeFile, rendered);
});
afterAll(async () => { await fs.rm(dir, { recursive: true, force: true }); });

interface Rendered {
  services: Record<string, {
    environment?: Record<string, string>;
    deploy?: { resources?: { reservations?: { devices?: Array<{ driver: string; count: number | string; capabilities: string[] }> } } };
    image?: string;
    profiles?: string[];
  }>;
}

async function render(envText: string, extra: string[] = []): Promise<Rendered> {
  const envFile = path.join(dir, `env-${Math.random().toString(36).slice(2)}`);
  await fs.writeFile(envFile, envText);
  const result = spawnSync('docker', ['compose', '--project-name', 'kubus-node', '--env-file', envFile, '-f', composeFile, ...extra, 'config', '--format', 'json'], { encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`docker compose config failed: ${result.stderr}`);
  return JSON.parse(result.stdout) as Rendered;
}

const TOPOLOGY = 'NODE_BIND_ADDRESS=127.0.0.1\nNODE_LAN_URL=\n';

describe.skipIf(!composeAvailable)('the release compose file under the real Compose', () => {
  it('runs the Node and Kubo and no worker on a machine setup found no GPU for', async () => {
    const env = mergeEnvText(TOPOLOGY, envUpdatesFor({ mode: 'auto', start: false, state: 'no_nvidia_gpu' }, TOPOLOGY));
    const config = await render(env);
    expect(Object.keys(config.services).sort()).toEqual(['kubo', 'kubus-node-agent']);
    // Deliberately empty - not the default - so the Node reports "no worker" and says why.
    expect(config.services['kubus-node-agent']!.environment!.SPATIAL_WORKER_URL).toBe('');
    expect(config.services['kubus-node-agent']!.environment!.KUBUS_SPATIAL_WORKER_STATE).toBe('no_nvidia_gpu');
  });

  it('activates the worker from runtime.env alone, with the URL the Node probes', async () => {
    const env = mergeEnvText(TOPOLOGY, envUpdatesFor({ mode: 'auto', start: true, state: 'enabled' }, TOPOLOGY));
    const config = await render(env);
    expect(Object.keys(config.services).sort()).toEqual(['kubo', 'kubus-node-agent', 'kubus-spatial-worker']);
    expect(config.services['kubus-node-agent']!.environment!.SPATIAL_WORKER_URL).toBe('http://kubus-spatial-worker:8790');
    expect(config.services['kubus-node-agent']!.environment!.KUBUS_SPATIAL_WORKER_STATE).toBe('enabled');
  });

  it('gives the worker a GPU: a device reservation, not just environment variables', async () => {
    const env = mergeEnvText(TOPOLOGY, envUpdatesFor({ mode: 'on', start: true, state: 'enabled' }, TOPOLOGY));
    const worker = (await render(env)).services['kubus-spatial-worker']!;
    const devices = worker.deploy?.resources?.reservations?.devices;
    expect(devices).toHaveLength(1);
    expect(devices![0]).toMatchObject({ driver: 'nvidia', capabilities: ['gpu'] });
    expect(Number(devices![0]!.count)).toBe(1);
    expect(worker.image).toMatch(/^ghcr\.io\/kubus-project\/kubus-spatial-worker@sha256:/);
  });

  it('still defines the worker, behind its profile, so teardown can reach it', async () => {
    const plain = await render(TOPOLOGY);
    expect(plain.services['kubus-spatial-worker']).toBeUndefined();
    const everything = await render(TOPOLOGY, ['--profile', '*']);
    expect(everything.services['kubus-spatial-worker']).toBeDefined();
  });

  it('keeps an install made before this release exactly as it was: the old default URL, no worker', async () => {
    // runtime.env of 0.8.0/0.8.1 held only the two topology keys.
    const config = await render(TOPOLOGY);
    expect(config.services['kubus-node-agent']!.environment!.SPATIAL_WORKER_URL).toBe('http://kubus-spatial-worker:8790');
    expect(config.services['kubus-node-agent']!.environment!.KUBUS_SPATIAL_WORKER_STATE).toBe('');
    expect(config.services['kubus-spatial-worker']).toBeUndefined();
  });

  it('reads a file the installer merged into, including one that Windows wrote with CRLF line endings', async () => {
    const legacy = 'NODE_BIND_ADDRESS=0.0.0.0\r\nNODE_LAN_URL=http://192.168.1.20:8787\r\n';
    const merged = mergeEnvText(legacy, envUpdatesFor({ mode: 'auto', start: true, state: 'enabled' }, legacy));
    expect(merged).toContain('\r\n');
    const config = await render(merged);
    expect(config.services['kubus-spatial-worker']).toBeDefined();
    expect(config.services['kubus-node-agent']!.environment!.LOCAL_API_LAN_URL).toBe('http://192.168.1.20:8787');
    expect(config.services['kubus-node-agent']!.environment!.SPATIAL_WORKER_URL).toBe('http://kubus-spatial-worker:8790');
  });

  it('honours the operator\'s own profiles next to ours', async () => {
    const env = mergeEnvText('COMPOSE_PROFILES=monitoring\n', envUpdatesFor({ mode: 'auto', start: true, state: 'enabled' }, 'COMPOSE_PROFILES=monitoring\n'));
    expect(env).toContain('COMPOSE_PROFILES=monitoring,spatial');
    expect(Object.keys((await render(env)).services)).toContain('kubus-spatial-worker');
  });

  it('does not build anything: a release runs images, never source', async () => {
    const text = await fs.readFile(template, 'utf8');
    expect(text).not.toMatch(/^\s+build:/m);
  });
});
