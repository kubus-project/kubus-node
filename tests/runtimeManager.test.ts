import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RuntimeManager, type CommandRunner } from '../src/installer/runtimeManager.js';
import { readEnvValue } from '../src/installer/runtimeEnv.js';

/**
 * The installer's flows - setup, start, update, teardown - against a fake Docker
 * and a real runtime directory. What is under test is the decision about the
 * GPU worker and the one file that records it, because the failures this
 * guards against were quiet: finishing setup rewrote runtime.env whole (erasing
 * the decision and anything the operator had added), and nothing ever started
 * the worker or told the operator why it was not running.
 */

const supported = process.arch === 'x64' && (process.platform === 'linux' || process.platform === 'win32');

const COMPOSE = 'services:\n  kubo:\n    image: ipfs/kubo\n';
const DIGEST = (letter: string) => `sha256:${letter.repeat(64)}`;
const RTX_LINE = 'NVIDIA GeForce RTX 3080 Ti, 12288, 566.36\n';
const NVIDIA_RUNTIMES = '{"io.containerd.runc.v2":{"path":"runc"},"nvidia":{"path":"nvidia-container-runtime"},"runc":{"path":"runc"}}\n';
const PLAIN_RUNTIMES = '{"io.containerd.runc.v2":{"path":"runc"},"runc":{"path":"runc"}}\n';

interface Call { command: string; args: string[] }
interface Machine {
  /** nvidia-smi output, or undefined when the tool is not installed. */
  smi?: string;
  runtimes?: string;
  /** Compose sub-commands (the part after the global flags) that should fail. */
  failing: Array<(compose: string[]) => boolean>;
  setupConfig: string;
}

function userArgs(call: Call): string[] {
  const index = call.args.indexOf('-f');
  return call.args.slice(index + 2);
}

function fakeDocker(machine: Machine): { run: CommandRunner; calls: Call[]; compose: () => string[][]; ran: (command: string) => boolean } {
  const calls: Call[] = [];
  const run = (async (command: string, args: string[]) => {
    calls.push({ command, args });
    const ok = { code: 0, stdout: '', stderr: '' };
    if (command === 'nvidia-smi') return machine.smi === undefined ? { code: 1, stdout: '', stderr: 'spawn nvidia-smi ENOENT' } : { code: 0, stdout: machine.smi, stderr: '' };
    if (command !== 'docker') return ok;
    if (args[0] === 'info' && args[1] === '--format') return { code: 0, stdout: machine.runtimes ?? PLAIN_RUNTIMES, stderr: '' };
    if (args[0] !== 'compose' || args[1] === 'version') return ok;
    const compose = userArgs({ command, args });
    if (machine.failing.some((matches) => matches(compose))) return { code: 1, stdout: '', stderr: `failing: ${compose.join(' ')}` };
    if (compose.includes('exec')) return { code: 0, stdout: machine.setupConfig, stderr: '' };
    if (compose.includes('ps')) return { code: 0, stdout: '{"Health":"healthy"}', stderr: '' };
    return ok;
  }) as CommandRunner;
  return {
    run, calls,
    compose: () => calls.filter((call) => call.command === 'docker' && call.args[0] === 'compose' && call.args[1] === '--project-name').map(userArgs),
    ran: (command) => calls.some((call) => call.command === command),
  };
}

const dirs: string[] = [];
const savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const key of ['XDG_DATA_HOME', 'LOCALAPPDATA', 'KUBUS_SPATIAL_WORKER']) savedEnv[key] = process.env[key];
  delete process.env.KUBUS_SPATIAL_WORKER;
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('ok', { status: 200 }));
});
afterEach(async () => {
  vi.restoreAllMocks();
  for (const [key, value] of Object.entries(savedEnv)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  await Promise.all(dirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

async function install(machine: Partial<Machine> = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'kubus-installer-'));
  dirs.push(root);
  process.env.XDG_DATA_HOME = path.join(root, 'data');
  process.env.LOCALAPPDATA = path.join(root, 'data');
  const packageRoot = path.join(root, 'package');
  await fs.mkdir(path.join(packageRoot, 'runtime'), { recursive: true });
  await fs.writeFile(path.join(packageRoot, 'runtime', 'docker-compose.release.yml'), COMPOSE);
  await fs.writeFile(path.join(packageRoot, 'runtime', 'release-manifest.json'), JSON.stringify({
    schemaVersion: 1, version: '0.8.1', channel: 'stable', sourceSha: 'a'.repeat(40),
    nodeImage: `ghcr.io/kubus-project/kubus-node@${DIGEST('a')}`, workerImage: `ghcr.io/kubus-project/kubus-spatial-worker@${DIGEST('b')}`,
    composeSha256: createHash('sha256').update(COMPOSE).digest('hex'), minimumCliVersion: '0.8.1', protocolVersion: 3,
  }));
  const docker = fakeDocker({ failing: [], setupConfig: 'LOCAL_API_ALLOW_LAN=false\n', ...machine });
  const manager = new RuntimeManager(packageRoot, '0.8.1', { run: docker.run });
  const readEnv = () => fs.readFile(manager.paths.environment, 'utf8');
  return { manager, docker, readEnv, root };
}

const index = (calls: string[][], predicate: (args: string[]) => boolean) => calls.findIndex(predicate);
const is = (...expected: string[]) => (args: string[]) => expected.every((word, position) => args[position] === word);

describe.skipIf(!supported)('a machine with no GPU', () => {
  it('starts the Node and the archive, and never touches the worker', async () => {
    const { manager, docker, readEnv } = await install();
    await manager.start();
    const compose = docker.compose();
    expect(compose.find(is('pull'))).toEqual(['pull', 'kubo', 'kubus-node-agent']);
    expect(compose.find(is('up'))).toEqual(['up', '-d', 'kubo', 'kubus-node-agent']);
    expect(compose.some((args) => args.includes('kubus-spatial-worker') && (args[0] === 'pull' || args[0] === 'up'))).toBe(false);
    const env = await readEnv();
    expect(readEnvValue(env, 'KUBUS_SPATIAL_WORKER')).toBe('auto');
    expect(readEnvValue(env, 'KUBUS_SPATIAL_WORKER_STATE')).toBe('no_nvidia_gpu');
    expect(readEnvValue(env, 'SPATIAL_WORKER_URL')).toBe('');
    expect(readEnvValue(env, 'COMPOSE_PROFILES')).toBeUndefined();
  });

  it('completes setup with the Node configured and the worker still absent', async () => {
    const { manager, docker, readEnv } = await install();
    await manager.setup({ headless: true });
    expect(readEnvValue(await readEnv(), 'KUBUS_SPATIAL_WORKER_STATE')).toBe('no_nvidia_gpu');
    expect(docker.compose().some((args) => args[0] === 'up' && args.includes('kubus-spatial-worker'))).toBe(false);
    expect(docker.compose().filter(is('up', '-d', '--force-recreate', 'kubo', 'kubus-node-agent'))).toHaveLength(1);
  });
});

describe.skipIf(!supported)('a GPU that Docker can give a container', () => {
  const gpu = { smi: RTX_LINE, runtimes: NVIDIA_RUNTIMES };

  it('starts the worker after the Node, with the profile and its URL recorded', async () => {
    const { manager, docker, readEnv } = await install(gpu);
    await manager.start();
    const compose = docker.compose();
    const baseUp = index(compose, is('up', '-d', 'kubo', 'kubus-node-agent'));
    const workerPull = index(compose, is('pull', 'kubus-spatial-worker'));
    const workerUp = index(compose, is('up', '-d', 'kubus-spatial-worker'));
    expect(baseUp).toBeGreaterThan(-1);
    expect(workerPull).toBeGreaterThan(baseUp);
    expect(workerUp).toBeGreaterThan(workerPull);
    const env = await readEnv();
    expect(readEnvValue(env, 'COMPOSE_PROFILES')).toBe('spatial');
    expect(readEnvValue(env, 'SPATIAL_WORKER_URL')).toBe('http://kubus-spatial-worker:8790');
    expect(readEnvValue(env, 'KUBUS_SPATIAL_WORKER_STATE')).toBe('enabled');
  });

  it('starts it at the end of setup too, after the Node has been recreated into its configured form', async () => {
    const { manager, docker } = await install(gpu);
    await manager.setup({ headless: true });
    const compose = docker.compose();
    const recreated = index(compose, is('up', '-d', '--force-recreate', 'kubo', 'kubus-node-agent'));
    const workerUp = index(compose, is('up', '-d', 'kubus-spatial-worker'));
    expect(recreated).toBeGreaterThan(-1);
    expect(workerUp).toBeGreaterThan(recreated);
  });

  it('does not pull or start the worker during the first, loopback-only bootstrap', async () => {
    const { manager, docker } = await install(gpu);
    await manager.setup({ headless: true });
    const compose = docker.compose();
    const bootstrapUp = index(compose, is('up', '-d', 'kubo', 'kubus-node-agent'));
    const workerPull = index(compose, is('pull', 'kubus-spatial-worker'));
    expect(workerPull).toBeGreaterThan(bootstrapUp);
  });

  it('keeps the worker decision and everything else in runtime.env when setup finishes', async () => {
    // The defect: finishing setup wrote the file whole, erasing every other key.
    const { manager, readEnv } = await install(gpu);
    await manager.setup({ headless: true });
    const env = await readEnv();
    expect(readEnvValue(env, 'NODE_BIND_ADDRESS')).toBe('127.0.0.1');
    expect(readEnvValue(env, 'COMPOSE_PROFILES')).toBe('spatial');
    expect(readEnvValue(env, 'SPATIAL_WORKER_URL')).toBe('http://kubus-spatial-worker:8790');
    expect(readEnvValue(env, 'KUBUS_SPATIAL_WORKER_STATE')).toBe('enabled');
  });

  it('records a LAN topology without losing the worker decision either', async () => {
    vi.spyOn(os, 'networkInterfaces').mockReturnValue({ eth0: [{ address: '192.168.1.40', family: 'IPv4', internal: false, netmask: '255.255.255.0', mac: '', cidr: null }] } as never);
    const { manager, readEnv } = await install({ ...gpu, setupConfig: 'LOCAL_API_ALLOW_LAN=true\n' });
    await manager.setup({ headless: true });
    const env = await readEnv();
    expect(readEnvValue(env, 'NODE_BIND_ADDRESS')).toBe('0.0.0.0');
    expect(readEnvValue(env, 'NODE_LAN_URL')).toBe('http://192.168.1.40:8787');
    expect(readEnvValue(env, 'COMPOSE_PROFILES')).toBe('spatial');
  });

  it('update() re-plans and starts it as start() does, removing orphans from the Node services only', async () => {
    const { manager, docker } = await install(gpu);
    await manager.update();
    const compose = docker.compose();
    expect(compose.find(is('up', '-d', '--remove-orphans'))).toEqual(['up', '-d', '--remove-orphans', 'kubo', 'kubus-node-agent']);
    expect(index(compose, is('up', '-d', 'kubus-spatial-worker'))).toBeGreaterThan(-1);
  });
});

describe.skipIf(!supported)('a GPU Docker cannot give a container', () => {
  it('does not start the worker on a guess, and says why', async () => {
    const { manager, docker, readEnv } = await install({ smi: RTX_LINE, runtimes: PLAIN_RUNTIMES });
    await manager.start();
    expect(docker.compose().some((args) => args.includes('kubus-spatial-worker') && (args[0] === 'pull' || args[0] === 'up'))).toBe(false);
    expect(readEnvValue(await readEnv(), 'KUBUS_SPATIAL_WORKER_STATE')).toBe('docker_gpu_unconfirmed');
  });

  it('starts it anyway when the operator sets KUBUS_SPATIAL_WORKER=on, and remembers the choice', async () => {
    const { manager, docker, readEnv } = await install({ smi: RTX_LINE, runtimes: PLAIN_RUNTIMES });
    process.env.KUBUS_SPATIAL_WORKER = 'on';
    await manager.start();
    expect(docker.compose().some(is('up', '-d', 'kubus-spatial-worker'))).toBe(true);
    expect(readEnvValue(await readEnv(), 'KUBUS_SPATIAL_WORKER')).toBe('on');
    // Next time, without the variable, the persisted choice still holds.
    delete process.env.KUBUS_SPATIAL_WORKER;
    const second = fakeDocker({ failing: [], setupConfig: '', smi: RTX_LINE, runtimes: PLAIN_RUNTIMES });
    const again = new RuntimeManager(manager.packageRoot, '0.8.1', { run: second.run });
    await again.start();
    expect(second.compose().some(is('up', '-d', 'kubus-spatial-worker'))).toBe(true);
  });
});

describe.skipIf(!supported)('turning the worker off', () => {
  it('runs no GPU probe at all, removes any worker already there, and drops its profile', async () => {
    const { manager, docker, readEnv } = await install({ smi: RTX_LINE, runtimes: NVIDIA_RUNTIMES });
    await manager.start();
    expect(readEnvValue(await readEnv(), 'COMPOSE_PROFILES')).toBe('spatial');

    process.env.KUBUS_SPATIAL_WORKER = 'off';
    docker.calls.length = 0;
    await manager.start();
    expect(docker.ran('nvidia-smi')).toBe(false);
    expect(docker.calls.some((call) => call.args.includes('--format') && call.args.includes('{{json .Runtimes}}'))).toBe(false);
    const compose = docker.compose();
    expect(compose.some((args) => args.join(' ') === ['--profile', '*', 'rm', '-sf', 'kubus-spatial-worker'].join(' '))).toBe(true);
    expect(compose.some((args) => args.includes('kubus-spatial-worker') && (args[0] === 'pull' || args[0] === 'up'))).toBe(false);
    const env = await readEnv();
    expect(readEnvValue(env, 'COMPOSE_PROFILES')).toBeUndefined();
    expect(readEnvValue(env, 'SPATIAL_WORKER_URL')).toBe('');
    expect(readEnvValue(env, 'KUBUS_SPATIAL_WORKER_STATE')).toBe('operator_off');
  });

  it('refuses a setting it does not understand before it starts anything', async () => {
    const { manager, docker } = await install({ smi: RTX_LINE, runtimes: NVIDIA_RUNTIMES });
    process.env.KUBUS_SPATIAL_WORKER = 'maybe';
    await expect(manager.start()).rejects.toThrow('KUBUS_SPATIAL_WORKER must be auto, on or off');
    expect(docker.compose()).toEqual([]);
  });
});

describe.skipIf(!supported)('a worker that cannot start', () => {
  const gpu = { smi: RTX_LINE, runtimes: NVIDIA_RUNTIMES };

  it('does not stop the Node starting, and records why the worker is not there', async () => {
    const { manager, docker, readEnv } = await install({ ...gpu, failing: [(compose) => compose[0] === 'up' && compose.includes('kubus-spatial-worker')] });
    await expect(manager.start()).resolves.toBeUndefined();
    const env = await readEnv();
    expect(readEnvValue(env, 'KUBUS_SPATIAL_WORKER_STATE')).toBe('worker_start_failed');
    // Turned off until the next setup, start or update tries again, so a later plain
    // `docker compose up` cannot trip over it either.
    expect(readEnvValue(env, 'COMPOSE_PROFILES')).toBeUndefined();
    expect(readEnvValue(env, 'SPATIAL_WORKER_URL')).toBe('');
    expect(readEnvValue(env, 'KUBUS_SPATIAL_WORKER')).toBe('auto');
    expect(docker.compose().some((args) => args.join(' ') === ['--profile', '*', 'rm', '-sf', 'kubus-spatial-worker'].join(' '))).toBe(true);
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('The Spatial worker could not be started'));
  });

  it('does the same when the worker image cannot be pulled', async () => {
    const { manager, readEnv } = await install({ ...gpu, failing: [(compose) => compose[0] === 'pull' && compose.includes('kubus-spatial-worker')] });
    await expect(manager.start()).resolves.toBeUndefined();
    expect(readEnvValue(await readEnv(), 'KUBUS_SPATIAL_WORKER_STATE')).toBe('worker_start_failed');
  });

  it('tries again on the next start', async () => {
    const fail = { current: true };
    const { manager, docker, readEnv } = await install({ ...gpu, failing: [(compose) => fail.current && compose[0] === 'up' && compose.includes('kubus-spatial-worker')] });
    await manager.start();
    expect(readEnvValue(await readEnv(), 'KUBUS_SPATIAL_WORKER_STATE')).toBe('worker_start_failed');
    fail.current = false;
    docker.calls.length = 0;
    await manager.start();
    expect(readEnvValue(await readEnv(), 'KUBUS_SPATIAL_WORKER_STATE')).toBe('enabled');
    expect(docker.compose().some(is('up', '-d', 'kubus-spatial-worker'))).toBe(true);
  });

  it('still fails the whole start when the Node itself cannot start', async () => {
    const { manager } = await install({ ...gpu, failing: [(compose) => compose[0] === 'up' && compose.includes('kubo')] });
    await expect(manager.start()).rejects.toThrow(/Docker Compose failed/);
  });
});

describe.skipIf(!supported)('what the operator already put in runtime.env', () => {
  it('survives start, setup and a change of worker mode', async () => {
    const { manager, readEnv } = await install({ smi: RTX_LINE, runtimes: NVIDIA_RUNTIMES });
    await fs.mkdir(path.dirname(manager.paths.environment), { recursive: true });
    await fs.writeFile(manager.paths.environment, [
      '# my tuning', 'NODE_BIND_ADDRESS=0.0.0.0', 'NODE_LAN_URL=http://192.168.1.99:8787', 'KUBUS_SPATIAL_MAX_ITERATIONS=30000',
      'MY_SECRET=do-not-lose=this', 'COMPOSE_PROFILES=monitoring', '',
    ].join('\r\n'));
    await manager.start();
    process.env.KUBUS_SPATIAL_WORKER = 'off';
    await manager.start();
    await manager.setup({ headless: true });
    const env = await readEnv();
    expect(env).toContain('# my tuning');
    expect(readEnvValue(env, 'KUBUS_SPATIAL_MAX_ITERATIONS')).toBe('30000');
    expect(readEnvValue(env, 'MY_SECRET')).toBe('do-not-lose=this');
    expect(readEnvValue(env, 'COMPOSE_PROFILES')).toBe('monitoring');
    // Setup's own topology keys are the operator's to change, and setup does change them.
    expect(readEnvValue(env, 'NODE_BIND_ADDRESS')).toBe('127.0.0.1');
    expect(env).not.toMatch(/(?<!\r)\n/);
  });

  it('is not reset by materialising a release over an existing install', async () => {
    const { manager, readEnv } = await install();
    await fs.mkdir(path.dirname(manager.paths.environment), { recursive: true });
    await fs.writeFile(manager.paths.environment, 'NODE_BIND_ADDRESS=0.0.0.0\nNODE_LAN_URL=http://10.0.0.7:8787\n');
    await manager.materialize();
    expect(await readEnv()).toBe('NODE_BIND_ADDRESS=0.0.0.0\nNODE_LAN_URL=http://10.0.0.7:8787\n');
  });

  it('adds only the defaults an upgraded install lacks', async () => {
    const { manager, readEnv } = await install();
    await fs.mkdir(path.dirname(manager.paths.environment), { recursive: true });
    await fs.writeFile(manager.paths.environment, 'NODE_BIND_ADDRESS=0.0.0.0\n');
    await manager.materialize();
    expect(await readEnv()).toBe('NODE_BIND_ADDRESS=0.0.0.0\nNODE_LAN_URL=\n');
  });
});

describe.skipIf(!supported)('teardown and inspection see the worker whatever its profile', () => {
  it.each([
    ['stop', (m: RuntimeManager) => m.stop(), 'stop'],
    ['restart', (m: RuntimeManager) => m.restart(), 'restart'],
    ['logs', (m: RuntimeManager) => m.logs(), 'logs'],
    ['status', (m: RuntimeManager) => m.status(), 'ps'],
    ['uninstall', (m: RuntimeManager) => m.uninstall(false), 'down'],
  ])('%s addresses every profile', async (_name, act, subcommand) => {
    const { manager, docker } = await install({ smi: RTX_LINE, runtimes: NVIDIA_RUNTIMES });
    await manager.materialize();
    docker.calls.length = 0;
    await act(manager);
    const used = docker.compose().find((args) => args.includes(subcommand))!;
    expect(used.slice(0, 2)).toEqual(['--profile', '*']);
  });

  it('removes the volumes and the whole runtime directory when asked to delete data', async () => {
    const { manager, docker } = await install();
    await manager.materialize();
    await manager.uninstall(true);
    expect(docker.compose().find((args) => args.includes('down'))).toEqual(['--profile', '*', 'down', '--volumes', '--remove-orphans']);
    await expect(fs.access(manager.paths.root)).rejects.toThrow();
  });
});

describe.skipIf(!supported)('asking without changing anything', () => {
  it('reports what would happen to the worker and why, and writes nothing', async () => {
    const { manager, docker } = await install({ smi: RTX_LINE, runtimes: PLAIN_RUNTIMES });
    await fs.mkdir(path.dirname(manager.paths.environment), { recursive: true });
    await fs.writeFile(manager.paths.environment, 'NODE_BIND_ADDRESS=127.0.0.1\n');
    const report = await manager.setup({ check: true }) as Awaited<ReturnType<RuntimeManager['doctor']>>;
    expect(report.spatialWorker).toMatchObject({ mode: 'auto', start: false, state: 'docker_gpu_unconfirmed', dockerNvidiaRuntime: false });
    expect(report.spatialWorker.gpus).toEqual([{ name: 'NVIDIA GeForce RTX 3080 Ti', vramMb: 12288, driver: '566.36' }]);
    expect(await fs.readFile(manager.paths.environment, 'utf8')).toBe('NODE_BIND_ADDRESS=127.0.0.1\n');
    expect(docker.compose()).toEqual([]);
  });

  it('reports a CPU-only machine as such', async () => {
    const { manager } = await install();
    const report = await manager.doctor();
    expect(report.spatialWorker).toMatchObject({ start: false, state: 'no_nvidia_gpu', gpus: [] });
  });
});
