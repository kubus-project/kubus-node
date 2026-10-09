import { existsSync } from 'node:fs';
import { copyFile, mkdir, readFile, rm } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isPlaceholderRelease, parseReleaseManifest, type ReleaseManifest } from './releaseManifest.js';
import { readEnvValue, updateEnvFile } from './runtimeEnv.js';
import {
  dockerHasNvidiaRuntime,
  envUpdatesFor,
  parseNvidiaSmi,
  parseSpatialWorkerMode,
  planSpatialWorker,
  type SpatialWorkerPlan,
} from './spatialWorker.js';

export interface RuntimePaths {
  root: string;
  compose: string;
  manifest: string;
  environment: string;
}

export interface DoctorReport {
  cliVersion: string;
  platform: string;
  architecture: string;
  supported: boolean;
  docker: { available: boolean; compose: boolean; detail?: string };
  release: { version: string; nodeImage: string; workerImage: string; placeholder: boolean };
  runtimeConfigured: boolean;
  /** What would happen to the GPU Spatial worker on this machine, and why. Read-only: nothing is started or written. */
  spatialWorker: Pick<SpatialWorkerPlan, 'mode' | 'start' | 'state' | 'gpus' | 'dockerNvidiaRuntime'>;
}

export type CommandRunner = typeof run;

/** Compose commands that must see every service, including one whose profile is no longer active. */
const ALL_PROFILES = ['--profile', '*'];
/** The services that make a Node. The Spatial worker is optional and is handled on its own. */
const BASE_SERVICES = ['kubo', 'kubus-node-agent'];
const WORKER_SERVICE = 'kubus-spatial-worker';

export class RuntimeManager {
  readonly packageRoot: string;
  readonly paths: RuntimePaths;
  private readonly packageVersion: string;

  private readonly exec: CommandRunner;

  constructor(packageRoot = findPackageRoot(), packageVersion = process.env.npm_package_version ?? '0.0.0', deps: { run?: CommandRunner } = {}) {
    this.packageRoot = packageRoot;
    this.packageVersion = packageVersion;
    this.exec = deps.run ?? run;
    const root = runtimeRoot();
    this.paths = { root, compose: path.join(root, 'docker-compose.release.yml'), manifest: path.join(root, 'release-manifest.json'), environment: path.join(root, 'runtime.env') };
  }

  async release(): Promise<ReleaseManifest> {
    const [manifest, compose] = await Promise.all([
      readFile(path.join(this.packageRoot, 'runtime', 'release-manifest.json'), 'utf8'),
      readFile(path.join(this.packageRoot, 'runtime', 'docker-compose.release.yml'), 'utf8'),
    ]);
    return parseReleaseManifest(JSON.parse(manifest) as unknown, compose);
  }

  async doctor(): Promise<DoctorReport> {
    const release = await this.release();
    const docker = await this.dockerStatus();
    return {
      cliVersion: this.packageVersion,
      platform: process.platform,
      architecture: process.arch,
      supported: this.supportedPlatform(),
      docker,
      release: { version: release.version, nodeImage: release.nodeImage, workerImage: release.workerImage, placeholder: isPlaceholderRelease(release) },
      runtimeConfigured: existsSync(this.paths.compose),
      spatialWorker: await this.planSpatialWorker(docker.available),
    };
  }

  supportedPlatform(): boolean {
    return process.arch === 'x64' && (process.platform === 'linux' || process.platform === 'win32');
  }

  async preflight(): Promise<void> {
    if (!this.supportedPlatform()) throw new Error(`Unsupported npm CLI platform: ${process.platform}/${process.arch}. Supported platforms are Linux x64 and Windows x64.`);
    const release = await this.release();
    if (isPlaceholderRelease(release)) throw new Error('This is a CI package candidate with placeholder image digests; it cannot start a runtime.');
    const docker = await this.dockerStatus();
    if (!docker.available || !docker.compose) throw new Error(docker.detail ?? 'Docker Engine and Docker Compose v2 are required. Install and start Docker, then run kubus-node setup again.');
  }

  async materialize(): Promise<ReleaseManifest> {
    const manifest = await this.release();
    if (isPlaceholderRelease(manifest)) throw new Error('Refusing to materialize a placeholder release manifest.');
    await mkdir(this.paths.root, { recursive: true });
    await copyFile(path.join(this.packageRoot, 'runtime', 'docker-compose.release.yml'), this.paths.compose);
    await copyFile(path.join(this.packageRoot, 'runtime', 'release-manifest.json'), this.paths.manifest);
    // runtime.env belongs to the operator: only keys it lacks are added, and
    // nothing that is already there is touched.
    const existing = await this.readEnvText();
    const defaults: Record<string, string> = { NODE_BIND_ADDRESS: '127.0.0.1', NODE_LAN_URL: '' };
    const missing = Object.fromEntries(Object.entries(defaults).filter(([key]) => readEnvValue(existing, key) === undefined));
    if (Object.keys(missing).length > 0 || !existsSync(this.paths.environment)) await updateEnvFile(this.paths.environment, missing);
    return manifest;
  }

  async setup(options: { check?: boolean; headless?: boolean } = {}): Promise<ReleaseManifest | DoctorReport> {
    if (options.check) return this.doctor();
    await this.preflight();
    const manifest = await this.materialize();
    await this.prepareSpatialWorker();
    await this.compose(['pull', ...BASE_SERVICES]);
    await this.compose(['up', '-d', ...BASE_SERVICES]);
    await this.waitForBootstrap();
    if (options.headless) {
      console.log('Bootstrap is running at http://127.0.0.1:8787/setup. Use an SSH tunnel or local browser to complete the same setup wizard.');
    } else {
      await this.open('http://127.0.0.1:8787/setup');
    }
    await this.completeSetupTransition();
    return manifest;
  }

  async start(): Promise<void> {
    await this.preflight();
    await this.materialize();
    await this.prepareSpatialWorker();
    await this.compose(['pull', ...BASE_SERVICES]);
    await this.compose(['up', '-d', ...BASE_SERVICES]);
    await this.startSpatialWorker();
    await this.waitForHealthy();
  }

  // Teardown and inspection address every service, including a Spatial worker
  // whose profile has since been switched off: `down` without this would leave
  // that container running with nothing left that knows about it.
  async stop(): Promise<void> { await this.requireMaterialized(); await this.compose([...ALL_PROFILES, 'stop']); }
  async restart(): Promise<void> { await this.requireMaterialized(); await this.compose([...ALL_PROFILES, 'restart']); }
  async logs(args: string[] = []): Promise<void> { await this.requireMaterialized(); await this.compose([...ALL_PROFILES, 'logs', '--tail', '200', ...args]); }
  async status(): Promise<string> { await this.requireMaterialized(); return this.compose([...ALL_PROFILES, 'ps', '--format', 'json'], true); }

  async update(): Promise<ReleaseManifest> {
    // A CLI package contains exactly one verified release manifest. Operators opt
    // into a desired runtime by running that version via npm/npx, never by asking
    // an installed CLI to fetch mutable Compose YAML from a branch.
    await this.preflight();
    const manifest = await this.materialize();
    await this.prepareSpatialWorker();
    await this.compose(['pull', ...BASE_SERVICES]);
    await this.compose(['up', '-d', '--remove-orphans', ...BASE_SERVICES]);
    await this.startSpatialWorker();
    return manifest;
  }

  async uninstall(deleteData: boolean): Promise<void> {
    await this.requireMaterialized();
    await this.compose([...ALL_PROFILES, ...(deleteData ? ['down', '--volumes', '--remove-orphans'] : ['down', '--remove-orphans'])]);
    if (deleteData) await rm(this.paths.root, { recursive: true, force: true });
  }

  async open(url = 'http://127.0.0.1:8787'): Promise<void> {
    const command = process.platform === 'win32' ? 'cmd.exe' : 'xdg-open';
    const args = process.platform === 'win32' ? ['/d', '/s', '/c', 'start', '', url] : [url];
    await this.exec(command, args).catch(() => undefined);
  }

  private async requireMaterialized(): Promise<void> {
    if (!existsSync(this.paths.compose)) throw new Error(`No installed kubus Node runtime was found at ${this.paths.root}. Run kubus-node setup first.`);
    await this.preflight();
  }

  private async dockerStatus(): Promise<DoctorReport['docker']> {
    const engine = await this.exec('docker', ['info'], true, 15000);
    if (engine.code !== 0) return { available: false, compose: false, detail: 'Docker Engine is unavailable. Install and start Docker Desktop (Windows) or Docker Engine (Linux).' };
    const compose = await this.exec('docker', ['compose', 'version'], true, 15000);
    if (compose.code !== 0) return { available: true, compose: false, detail: 'Docker Compose v2 is required. Install the Docker Compose plugin and retry.' };
    return { available: true, compose: true };
  }

  private async compose(args: string[], capture = false): Promise<string> {
    const output = await this.exec('docker', ['compose', '--project-name', 'kubus-node', '--env-file', this.paths.environment, '-f', this.paths.compose, ...args], capture);
    if (output.code !== 0) throw new Error(`Docker Compose failed: ${output.stderr || output.stdout}`.trim());
    return output.stdout;
  }

  private async waitForBootstrap(): Promise<void> {
    await until(async () => {
      try {
        const response = await fetch('http://127.0.0.1:8787/setup', { signal: AbortSignal.timeout(3000) });
        return response.ok;
      } catch { return false; }
    }, 120, 3000, 'kubus Node bootstrap did not become ready in time.');
  }

  private async completeSetupTransition(): Promise<void> {
    // The setup server writes this durable file only after validated setup
    // completes. Until then the host port is loopback-only, so an unfinished
    // bootstrap UI can never be exposed to the LAN.
    const completed = await until(async () => {
      const config = await this.readSetupConfig();
      if (/^LOCAL_API_ALLOW_LAN=(?:"?true"?)$/m.test(config)) return { allowLan: true };
      if (/^LOCAL_API_ALLOW_LAN=(?:"?false"?)$/m.test(config)) return { allowLan: false };
      return undefined;
    }, 600, 3000, 'Setup did not complete in time. The bootstrap remains loopback-only; rerun kubus-node setup to continue.');
    await this.writeTopology(completed.allowLan);
    await this.compose(['up', '-d', '--force-recreate', ...BASE_SERVICES]);
    await this.startSpatialWorker();
    await this.waitForHealthy();
  }

  private async readSetupConfig(): Promise<string> {
    const result = await this.exec('docker', ['compose', '--project-name', 'kubus-node', '--env-file', this.paths.environment, '-f', this.paths.compose, 'exec', '-T', 'kubus-node-agent', 'sh', '-lc', 'test -s /var/lib/kubus-node/config.env && cat /var/lib/kubus-node/config.env']);
    return result.code === 0 ? result.stdout : '';
  }

  private async writeTopology(allowLan: boolean): Promise<void> {
    let bindAddress = '127.0.0.1';
    let lanUrl = '';
    if (allowLan) {
      const address = Object.values(os.networkInterfaces()).flat().find((item) => item && item.family === 'IPv4' && !item.internal && isPrivateIpv4(item.address))?.address;
      if (!address) throw new Error('LAN access was selected, but no private IPv4 address is available. Connect this host to the intended network and rerun setup.');
      bindAddress = '0.0.0.0';
      lanUrl = `http://${address}:8787`;
    }
    // Only the two topology keys change. This used to write the whole file, so
    // finishing setup erased every other key in it - including the Spatial
    // worker decision made a moment earlier.
    await updateEnvFile(this.paths.environment, { NODE_BIND_ADDRESS: bindAddress, NODE_LAN_URL: lanUrl });
  }

  private async readEnvText(): Promise<string> {
    return readFile(this.paths.environment, 'utf8').catch(() => '');
  }

  /** Asks the host and Docker what a GPU container could use. Read-only. */
  private async probeSpatialWorker(dockerAvailable: boolean): Promise<Parameters<typeof planSpatialWorker>[1]> {
    const smi = await this.exec('nvidia-smi', ['--query-gpu=name,memory.total,driver_version', '--format=csv,noheader,nounits'], true, 10000);
    // A machine without the tool fails to spawn it; that is "no GPU", not an error.
    const gpus = smi.code === 0 ? parseNvidiaSmi(smi.stdout) : [];
    let dockerNvidiaRuntime: boolean | null = null;
    if (dockerAvailable) {
      const info = await this.exec('docker', ['info', '--format', '{{json .Runtimes}}'], true, 15000);
      dockerNvidiaRuntime = info.code === 0 ? dockerHasNvidiaRuntime(info.stdout) : null;
    }
    return { platformSupported: this.supportedPlatform(), gpus, dockerNvidiaRuntime };
  }

  /**
   * What the operator's `KUBUS_SPATIAL_WORKER` setting means on this machine.
   * The environment of this invocation wins over the persisted choice, so
   * `KUBUS_SPATIAL_WORKER=on kubus-node start` is a deliberate override that
   * is then remembered.
   */
  private async planSpatialWorker(dockerAvailable: boolean): Promise<SpatialWorkerPlan> {
    const mode = parseSpatialWorkerMode(process.env.KUBUS_SPATIAL_WORKER ?? readEnvValue(await this.readEnvText(), 'KUBUS_SPATIAL_WORKER'));
    // `off` needs no probe at all: it must work on a machine where nvidia-smi hangs.
    const probe = mode === 'off'
      ? { platformSupported: this.supportedPlatform(), gpus: [], dockerNvidiaRuntime: null }
      : await this.probeSpatialWorker(dockerAvailable);
    return planSpatialWorker(mode, probe);
  }

  /** Decides, records the decision in runtime.env, and clears away a worker that is no longer wanted. */
  private async prepareSpatialWorker(): Promise<SpatialWorkerPlan> {
    const plan = await this.planSpatialWorker(true);
    await updateEnvFile(this.paths.environment, envUpdatesFor(plan, await this.readEnvText()));
    if (!plan.start) {
      // Switched off, or no longer possible: a container from an earlier run must not linger.
      await this.compose([...ALL_PROFILES, 'rm', '-sf', WORKER_SERVICE]).catch(() => undefined);
    }
    return plan;
  }

  /**
   * Starts the worker if the recorded decision says to. Never throws: a Node
   * must not fail to start because its optional GPU worker could not. A failure
   * is recorded (so the Node can say why) and turns the worker off until the
   * next setup, start or update tries again.
   */
  private async startSpatialWorker(): Promise<'started' | 'skipped' | 'failed'> {
    const profiles = readEnvValue(await this.readEnvText(), 'COMPOSE_PROFILES') ?? '';
    if (!profiles.split(',').map((entry) => entry.trim()).includes('spatial')) return 'skipped';
    try {
      await this.compose(['pull', WORKER_SERVICE]);
      await this.compose(['up', '-d', WORKER_SERVICE]);
      return 'started';
    } catch (error) {
      console.warn(`The Spatial worker could not be started; the Node is running without it. ${String((error as Error).message || error).slice(0, 400)}`);
      await updateEnvFile(this.paths.environment, envUpdatesFor({ mode: parseSpatialWorkerMode(readEnvValue(await this.readEnvText(), 'KUBUS_SPATIAL_WORKER')), start: false, state: 'worker_start_failed' }, await this.readEnvText()));
      await this.compose([...ALL_PROFILES, 'rm', '-sf', WORKER_SERVICE]).catch(() => undefined);
      return 'failed';
    }
  }

  private async waitForHealthy(): Promise<void> {
    await until(async () => (await this.compose(['ps', '--format', 'json'], true)).includes('healthy'), 40, 3000, 'kubus Node did not become healthy in time. Its identity and data remain preserved; inspect kubus-node logs.');
  }
}

function runtimeRoot(): string {
  if (process.platform === 'win32') return path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'kubus-node');
  return path.join(process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share'), 'kubus-node');
}

export function findPackageRoot(from = path.dirname(fileURLToPath(import.meta.url))): string {
  let directory = from;
  while (true) {
    if (existsSync(path.join(directory, 'package.json'))) return directory;
    const parent = path.dirname(directory);
    if (parent === directory) throw new Error('Could not locate the kubus Node package root.');
    directory = parent;
  }
}

function run(command: string, args: string[], capture = true, timeout = 0): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(command, args, { stdio: capture ? ['ignore', 'pipe', 'pipe'] : 'inherit', windowsHide: true, shell: false, timeout, killSignal: 'SIGKILL' });
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
    child.stderr?.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
    child.once('error', (error) => resolve({ code: 1, stdout, stderr: error.message }));
    child.once('close', (code) => resolve({ code: code ?? 1, stdout, stderr }));
  });
}

function isPrivateIpv4(address: string): boolean {
  return /^10\./.test(address) || /^192\.168\./.test(address) || /^172\.(1[6-9]|2\d|3[01])\./.test(address);
}

async function until<T>(check: () => Promise<T | undefined | false>, attempts: number, intervalMs: number, failure: string): Promise<T> {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const result = await check();
    if (result !== undefined && result !== false) return result;
    await new Promise<void>((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error(failure);
}
