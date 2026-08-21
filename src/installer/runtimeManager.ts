import { existsSync } from 'node:fs';
import { copyFile, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isPlaceholderRelease, parseReleaseManifest, type ReleaseManifest } from './releaseManifest.js';

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
}

export class RuntimeManager {
  readonly packageRoot: string;
  readonly paths: RuntimePaths;
  private readonly packageVersion: string;

  constructor(packageRoot = findPackageRoot(), packageVersion = process.env.npm_package_version ?? '0.0.0') {
    this.packageRoot = packageRoot;
    this.packageVersion = packageVersion;
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
    if (!existsSync(this.paths.environment)) await writeFile(this.paths.environment, `NODE_BIND_ADDRESS=127.0.0.1\nNODE_LAN_URL=\n`, { mode: 0o600 });
    return manifest;
  }

  async setup(options: { check?: boolean; headless?: boolean } = {}): Promise<ReleaseManifest | DoctorReport> {
    if (options.check) return this.doctor();
    await this.preflight();
    const manifest = await this.materialize();
    await this.compose(['pull']);
    await this.compose(['up', '-d', 'kubo', 'kubus-node-agent']);
    await this.waitForBootstrap();
    if (options.headless) {
      console.log('Bootstrap is running at http://127.0.0.1:8787/setup. Use an SSH tunnel or local browser to complete the same setup wizard.');
    } else {
      await this.open('http://127.0.0.1:8787/setup');
    }
    await this.completeSetupTransition();
    return manifest;
  }

  async start(): Promise<void> { await this.preflight(); await this.materialize(); await this.compose(['pull']); await this.compose(['up', '-d']); await this.waitForHealthy(); }
  async stop(): Promise<void> { await this.requireMaterialized(); await this.compose(['stop']); }
  async restart(): Promise<void> { await this.requireMaterialized(); await this.compose(['restart']); }
  async logs(args: string[] = []): Promise<void> { await this.requireMaterialized(); await this.compose(['logs', '--tail', '200', ...args]); }
  async status(): Promise<string> { await this.requireMaterialized(); return this.compose(['ps', '--format', 'json'], true); }

  async update(): Promise<ReleaseManifest> {
    // A CLI package contains exactly one verified release manifest. Operators opt
    // into a desired runtime by running that version via npm/npx, never by asking
    // an installed CLI to fetch mutable Compose YAML from a branch.
    await this.preflight();
    const manifest = await this.materialize();
    await this.compose(['pull']);
    await this.compose(['up', '-d', '--remove-orphans']);
    return manifest;
  }

  async uninstall(deleteData: boolean): Promise<void> {
    await this.requireMaterialized();
    await this.compose(deleteData ? ['down', '--volumes', '--remove-orphans'] : ['down', '--remove-orphans']);
    if (deleteData) await rm(this.paths.root, { recursive: true, force: true });
  }

  async open(url = 'http://127.0.0.1:8787'): Promise<void> {
    const command = process.platform === 'win32' ? 'cmd.exe' : 'xdg-open';
    const args = process.platform === 'win32' ? ['/d', '/s', '/c', 'start', '', url] : [url];
    await run(command, args).catch(() => undefined);
  }

  private async requireMaterialized(): Promise<void> {
    if (!existsSync(this.paths.compose)) throw new Error(`No installed kubus Node runtime was found at ${this.paths.root}. Run kubus-node setup first.`);
    await this.preflight();
  }

  private async dockerStatus(): Promise<DoctorReport['docker']> {
    const engine = await run('docker', ['info']);
    if (engine.code !== 0) return { available: false, compose: false, detail: 'Docker Engine is unavailable. Install and start Docker Desktop (Windows) or Docker Engine (Linux).' };
    const compose = await run('docker', ['compose', 'version']);
    if (compose.code !== 0) return { available: true, compose: false, detail: 'Docker Compose v2 is required. Install the Docker Compose plugin and retry.' };
    return { available: true, compose: true };
  }

  private async compose(args: string[], capture = false): Promise<string> {
    const output = await run('docker', ['compose', '--project-name', 'kubus-node', '--env-file', this.paths.environment, '-f', this.paths.compose, ...args], capture);
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
    const allowLan = await until(async () => {
      const config = await this.readSetupConfig();
      if (/^LOCAL_API_ALLOW_LAN=(?:"?true"?)$/m.test(config)) return true;
      if (/^LOCAL_API_ALLOW_LAN=(?:"?false"?)$/m.test(config)) return false;
      return undefined;
    }, 600, 3000, 'Setup did not complete in time. The bootstrap remains loopback-only; rerun kubus-node setup to continue.');
    await this.writeTopology(allowLan);
    await this.compose(['up', '-d', '--force-recreate']);
    await this.waitForHealthy();
  }

  private async readSetupConfig(): Promise<string> {
    const result = await run('docker', ['compose', '--project-name', 'kubus-node', '--env-file', this.paths.environment, '-f', this.paths.compose, 'exec', '-T', 'kubus-node-agent', 'sh', '-lc', 'test -s /var/lib/kubus-node/config.env && cat /var/lib/kubus-node/config.env']);
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
    await writeFile(this.paths.environment, `NODE_BIND_ADDRESS=${bindAddress}\nNODE_LAN_URL=${lanUrl}\n`, { mode: 0o600 });
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

function run(command: string, args: string[], capture = true): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(command, args, { stdio: capture ? ['ignore', 'pipe', 'pipe'] : 'inherit', windowsHide: true, shell: false });
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
