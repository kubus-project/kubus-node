import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { afterEach, expect, it, vi } from 'vitest';
import { acquireRuntimeLease } from '../src/runtime/runtimeLease.js';
import { LocalStore } from '../src/state/localStore.js';
import { runCli } from '../src/cli/commands.js';

const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});
async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'kubus-runtime-lease-'));
  roots.push(root);
  return { root, file: path.join(root, 'state.json') };
}
it('allows only one writer and releases only its own lease', async () => {
  const { file } = await fixture();
  const first = await acquireRuntimeLease(file);
  await expect(acquireRuntimeLease(file)).rejects.toThrow('runtime_writer_already_active_or_unverified');
  await first.release();
  const second = await acquireRuntimeLease(file);
  await first.release();
  await expect(acquireRuntimeLease(file)).rejects.toThrow('runtime_writer_already_active_or_unverified');
  await second.release();
});
it('does not replace an unverifiable host or malformed ownership record', async () => {
  const { file } = await fixture();
  const lease = await acquireRuntimeLease(file);
  const leaseFile = `${file}.runtime-lease`;
  const owner = JSON.parse(await fs.readFile(leaseFile, 'utf8'));
  await fs.writeFile(leaseFile, JSON.stringify({ ...owner, host: `${owner.host}-unobservable` }));
  await expect(acquireRuntimeLease(file)).rejects.toThrow('runtime_writer_already_active_or_unverified');
  expect(JSON.parse(await fs.readFile(leaseFile, 'utf8')).host).toContain('unobservable');
  await fs.writeFile(leaseFile, '{broken');
  await expect(acquireRuntimeLease(file)).rejects.toThrow();
  expect(await fs.readFile(leaseFile, 'utf8')).toBe('{broken');
  await lease.release();
});
const linuxOnly = it.skipIf(process.platform !== 'linux');
linuxOnly('reclaims a lease left by a previous boot even from another PID namespace', async () => {
  const { file } = await fixture();
  const lease = await acquireRuntimeLease(file);
  const leaseFile = `${file}.runtime-lease`;
  const owner = JSON.parse(await fs.readFile(leaseFile, 'utf8'));
  await fs.writeFile(leaseFile, JSON.stringify({ ...owner, boot: 'previous-boot-id', namespace: 'pid:[4026539999]' }));
  const recovered = await acquireRuntimeLease(file);
  await recovered.release();
  await lease.release();
});
linuxOnly('keeps a lease from another PID namespace on the same boot for operator review', async () => {
  const { file } = await fixture();
  const lease = await acquireRuntimeLease(file);
  const leaseFile = `${file}.runtime-lease`;
  const owner = JSON.parse(await fs.readFile(leaseFile, 'utf8'));
  await fs.writeFile(leaseFile, JSON.stringify({ ...owner, namespace: 'pid:[4026539999]' }));
  await expect(acquireRuntimeLease(file)).rejects.toThrow('runtime_writer_already_active_or_unverified');
  await lease.release();
});
it('rejects a second process while its owner is alive and recovers after verified exit', async () => {
  const { file } = await fixture();
  const module = pathToFileURL(path.resolve('src/runtime/runtimeLease.ts')).href;
  const code = `import { acquireRuntimeLease } from ${JSON.stringify(module)}; await acquireRuntimeLease(${JSON.stringify(file)}); console.log('ready'); setInterval(() => {}, 1000);`;
  const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', code], { stdio: ['ignore', 'pipe', 'pipe'] });
  const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));
  try {
    await new Promise<void>((resolve, reject) => {
      let error = '';
      const timer = setTimeout(() => reject(new Error(`synthetic child readiness timeout: ${error}`)), 8000);
      child.stderr.on('data', (chunk) => { error += String(chunk); });
      child.stdout.once('data', () => { clearTimeout(timer); resolve(); });
      child.once('error', (failure) => { clearTimeout(timer); reject(failure); });
      child.once('exit', () => { clearTimeout(timer); reject(new Error(`synthetic child exited early: ${error}`)); });
    });
    await expect(acquireRuntimeLease(file)).rejects.toThrow('runtime_writer_already_active_or_unverified');
  } finally {
    child.kill();
    await exited;
  }
  const recovered = await acquireRuntimeLease(file);
  await recovered.release();
}, 15000);
it('read-only loading never creates directories, repairs corrupt files or permits updates', async () => {
  const { root } = await fixture();
  const directory = path.join(root, 'missing');
  const reader = new LocalStore(path.join(directory, 'state.json'));
  await reader.load({ readOnly: true });
  await expect(fs.stat(directory)).rejects.toMatchObject({ code: 'ENOENT' });
  await expect(reader.update((state) => { state.nodeId = 'must-not-write'; })).rejects.toThrow('state_store_read_only');
  await fs.mkdir(directory);
  await fs.writeFile(path.join(directory, 'state.json'), '{broken');
  await expect(reader.load({ readOnly: true })).rejects.toThrow('state_snapshot_unavailable');
  expect(await fs.readdir(directory)).toEqual(['state.json']);
  expect(await fs.readFile(path.join(directory, 'state.json'), 'utf8')).toBe('{broken');
});
it.each(['status', 'doctor'])('%s remains read-only while the runtime writer is active', async (command) => {
  const { root, file } = await fixture();
  const store = new LocalStore(file);
  await store.load();
  await store.update((state) => { state.nodeId = 'synthetic-node'; });
  const lease = await acquireRuntimeLease(file);
  const before = await fs.readFile(file, 'utf8');
  const files = await fs.readdir(root);
  for (const [key, value] of Object.entries({
    KUBUS_NODE_CONFIG_PATH: path.join(root, 'missing-config.env'),
    KUBUS_API_BASE_URL: 'http://127.0.0.1:1', KUBUS_OPERATOR_TOKEN: 'synthetic-token',
    KUBUS_OPERATOR_WALLET: 'synthetic-wallet', KUBUS_NODE_LABEL: 'synthetic',
    KUBUS_NODE_ENDPOINT_URL: 'http://127.0.0.1:1', IPFS_RPC_URL: 'http://127.0.0.1:1',
    IPFS_GATEWAY_URL: 'http://127.0.0.1:1', LOCAL_STATE_PATH: file, NODE_ENV: 'test', LOG_LEVEL: 'silent',
    HEARTBEAT_INTERVAL_MS: '5000', CID_SYNC_INTERVAL_MS: '30000', COMMITMENT_INTERVAL_MS: '30000',
    STATUS_INTERVAL_MS: '10000', MAX_PINNED_CIDS: '10', CID_CLASS_FILTERS: 'hot,warm',
  })) vi.stubEnv(key, value);
  vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 503 })));
  const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
  await runCli([command]);
  expect(log).toHaveBeenCalled();
  expect(await fs.readFile(file, 'utf8')).toBe(before);
  expect(await fs.readdir(root)).toEqual(files);
  await expect(acquireRuntimeLease(file)).rejects.toThrow('runtime_writer_already_active_or_unverified');
  await lease.release();
});
