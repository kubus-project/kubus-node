import { afterEach, describe, expect, it, vi } from 'vitest';
import { existsSync, promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { acquireRuntimeLease } from '../src/runtime/runtimeLease.js';
import { SHUTDOWN_DEADLINE_MS, SHUTDOWN_STEP_BUDGET_MS, STARTUP_ABORT_GRACE_MS, exitOnEarlySignal, waitForShutdown } from '../src/cli/commands.js';

// The Node agent was SIGKILLed on every stop (exit 137) because shutdown never
// completed and nothing bounded it. Docker's default grace period is 10s, so a
// stop that hangs is force-killed mid-write, which can truncate state.json.
// These tests exercise the real function rather than asserting on its text: the
// previous installer defect passed a text-matching test and still failed at
// runtime.

const never = () => new Promise<void>(() => {});

// The child-process tests below must not depend on the directory vitest was started from.
const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const sourceUrl = (relative: string) => pathToFileURL(path.join(repoRoot, relative)).href;
const tsxLoader = pathToFileURL(createRequire(import.meta.url).resolve('tsx')).href;

describe('shutdown', () => {
  it('finishes inside Docker default grace period even when a step hangs forever', async () => {
    const forceExit = vi.fn();
    const pending = waitForShutdown(
      { stop: never },
      null,
      undefined,
      null,
      undefined,
      { deadlineMs: 200, stepBudgetMs: 40, forceExit },
    );
    process.emit('SIGTERM');
    const started = Date.now();
    await expect(pending).resolves.toBeUndefined();
    // Resolving at all is the point: before the deadline this never returned.
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it('still closes the GUI when the scheduler is the step that hangs', async () => {
    // A single race over the whole teardown let one stuck step skip the rest,
    // which left the listening socket open on the way out.
    let guiClosed = false;
    const pending = waitForShutdown(
      { stop: never },
      { close: async () => { guiClosed = true; } } as never,
      undefined,
      null,
      undefined,
      { deadlineMs: 400, stepBudgetMs: 40, forceExit: vi.fn() },
    );
    process.emit('SIGTERM');
    await pending;
    expect(guiClosed).toBe(true);
  });

  it('names the step that stalled', async () => {
    const warn = vi.fn();
    const pending = waitForShutdown(
      { stop: never },
      null,
      undefined,
      null,
      { info: vi.fn(), warn },
      { deadlineMs: 400, stepBudgetMs: 40, forceExit: vi.fn() },
    );
    process.emit('SIGTERM');
    await pending;
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ step: 'scheduler' }),
      'shutdown step did not finish in time',
    );
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ stalled: expect.arrayContaining(['scheduler']) }),
      'shutdown completed with stalled steps; exiting anyway',
    );
  });

  it('still runs every teardown step when they all complete', async () => {
    const order: string[] = [];
    const forceExit = vi.fn();
    const pending = waitForShutdown(
      { stop: async () => { order.push('scheduler'); } },
      { close: async () => { order.push('gui'); } } as never,
      { stop: () => { order.push('remoteCompute'); } } as never,
      { stop: async () => { order.push('signaling'); } } as never,
      undefined,
      { deadlineMs: 2000, forceExit },
    );
    process.emit('SIGTERM');
    await pending;
    expect(order).toEqual(['scheduler', 'remoteCompute', 'signaling', 'gui']);
  });

  it('does not hang when a teardown step rejects', async () => {
    const forceExit = vi.fn();
    const pending = waitForShutdown(
      { stop: async () => { throw new Error('scheduler exploded'); } },
      null,
      undefined,
      null,
      undefined,
      { deadlineMs: 2000, forceExit },
    );
    process.emit('SIGTERM');
    await expect(pending).resolves.toBeUndefined();
  });

  it('reports the deadline it gave up on, so a hang is diagnosable', async () => {
    const warn = vi.fn();
    const info = vi.fn();
    const pending = waitForShutdown(
      { stop: never },
      null,
      undefined,
      null,
      { info, warn },
      { deadlineMs: 400, stepBudgetMs: 40, forceExit: vi.fn() },
    );
    process.emit('SIGTERM');
    await pending;
    // A shutdown that goes wrong must say so; the runtime previously logged
    // nothing at all between the signal and the SIGKILL.
    expect(info).toHaveBeenCalledWith(expect.objectContaining({ signal: 'SIGTERM' }), 'shutdown requested');
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ stalled: ['scheduler'] }),
      'shutdown completed with stalled steps; exiting anyway',
    );
  });

  it('does not wait out the whole grace period for an aborted startup', () => {
    // This was 10000ms: Docker's entire default stop_grace_period spent inside
    // one teardown step, which is why every stop ended in SIGKILL.
    expect(STARTUP_ABORT_GRACE_MS).toBeLessThanOrEqual(SHUTDOWN_STEP_BUDGET_MS);
  });

  it('leaves real margin under the grace period it is protecting', () => {
    // 10s is Docker's default stop_grace_period. An 8s budget measured 9.8s
    // end to end against that limit, which is not margin, it is luck.
    expect(SHUTDOWN_DEADLINE_MS).toBeLessThanOrEqual(6000);
    expect(SHUTDOWN_STEP_BUDGET_MS).toBeLessThan(SHUTDOWN_DEADLINE_MS);
  });
});

describe('shutdown releases the runtime writer lease', () => {
  const roots: string[] = [];
  afterEach(async () => { for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true }); });
  async function leased() {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'kubus-shutdown-lease-')); roots.push(root);
    const state = path.join(root, 'state.json');
    const lease = await acquireRuntimeLease(state);
    return { state, leaseFile: `${state}.runtime-lease`, lease };
  }
  const exists = (file: string) => fs.stat(file).then(() => true, () => false);

  it('releases on the normal SIGTERM path, in the same step as the exit', async () => {
    const { leaseFile, lease } = await leased();
    let goneAtExit = false;
    const forceExit = vi.fn(() => { goneAtExit = !existsSync(leaseFile); });
    const pending = waitForShutdown({ stop: async () => undefined }, null, undefined, null, undefined,
      { deadlineMs: 2000, forceExit, releaseLease: lease.releaseSync });
    process.emit('SIGTERM');
    await pending;
    // Teardown finished, but the process has not exited yet, so the lease is still held: no early release.
    expect(await exists(leaseFile)).toBe(true);
    await vi.waitFor(() => expect(forceExit).toHaveBeenCalledTimes(1), { timeout: 3000 });
    expect(goneAtExit).toBe(true);
    expect(await exists(leaseFile)).toBe(false);
  });

  it('releases when a shutdown step stalls and the forced exit fires', async () => {
    const { leaseFile, lease } = await leased();
    let goneAtExit = false;
    const forceExit = vi.fn(() => { goneAtExit = !existsSync(leaseFile); });
    const pending = waitForShutdown({ stop: never }, null, undefined, null, undefined,
      { deadlineMs: 200, stepBudgetMs: 40, forceExit, releaseLease: lease.releaseSync });
    process.emit('SIGTERM');
    await pending;
    // The stalled scheduler may still be running, so the lease stays until the exit itself.
    expect(await exists(leaseFile)).toBe(true);
    await vi.waitFor(() => expect(forceExit).toHaveBeenCalledTimes(1), { timeout: 3000 });
    expect(goneAtExit).toBe(true);
    expect(await exists(leaseFile)).toBe(false);
  });

  it('still exits when releasing the lease throws', async () => {
    const forceExit = vi.fn();
    const pending = waitForShutdown(null, null, undefined, null, undefined,
      { deadlineMs: 200, forceExit, releaseLease: () => { throw new Error('EPERM'); } });
    process.emit('SIGTERM');
    await pending;
    await vi.waitFor(() => expect(forceExit).toHaveBeenCalledTimes(1), { timeout: 3000 });
  });

  it('a real forced process.exit with a stalled step leaves no lease file behind (the forced-exit wrapper alone releases it)', async () => {
    const { state, leaseFile, lease } = await leased();
    await lease.release();
    const commands = sourceUrl('src/cli/commands.ts');
    const leaseModule = sourceUrl('src/runtime/runtimeLease.ts');
    const code = `import { waitForShutdown } from ${JSON.stringify(commands)}; import { acquireRuntimeLease } from ${JSON.stringify(leaseModule)};
const lease = await acquireRuntimeLease(${JSON.stringify(state)});
// No 'exit' hook here: only the release inside the forced-exit wrapper can remove the lease.
const done = waitForShutdown({ stop: () => new Promise(() => {}) }, null, undefined, null, undefined, { deadlineMs: 200, stepBudgetMs: 40, releaseLease: lease.releaseSync });
setImmediate(() => process.emit('SIGTERM'));
void done;
setInterval(() => {}, 1000);`;
    const child = spawn(process.execPath, ['--import', tsxLoader, '--input-type=module', '-e', code], { cwd: repoRoot, stdio: ['ignore', 'pipe', 'pipe'] });
    let error = '';
    child.stderr.on('data', (chunk) => { error += String(chunk); });
    const status = await new Promise<number | null>((resolve) => { child.once('exit', (value) => resolve(value)); });
    expect(error).toBe('');
    expect(status).toBe(0);
    expect(await exists(leaseFile)).toBe(false);
    const next = await acquireRuntimeLease(state);
    await next.release();
  }, 20000);

  // runCli itself must arm the exit hook for the long-running commands: a startup that fails after the lease was
  // taken, and an explicit process.exit(75), both end without the waitForShutdown path.
  it.each([
    ['a start that fails after taking the lease (natural exit)', 'start', ''],
    ['a gui command that ends in process.exit(75)', 'gui', 'process.exitCode = 75; setTimeout(() => process.exit(75), 0);'],
  ])('runCli leaves no lease file behind after %s', async (_name, command, tail) => {
    const { state, leaseFile, lease } = await leased();
    await lease.release();
    // A state file the runtime cannot read: runCli takes the lease, then fails loading it.
    await fs.writeFile(state, '{broken');
    const env = {
      ...process.env,
      KUBUS_NODE_CONFIG_PATH: path.join(path.dirname(state), 'missing-config.env'),
      KUBUS_API_BASE_URL: 'http://127.0.0.1:1', KUBUS_OPERATOR_TOKEN: 'synthetic-token', KUBUS_OPERATOR_WALLET: 'synthetic-wallet',
      KUBUS_NODE_LABEL: 'synthetic', KUBUS_NODE_ENDPOINT_URL: 'http://127.0.0.1:1', IPFS_RPC_URL: 'http://127.0.0.1:1',
      IPFS_GATEWAY_URL: 'http://127.0.0.1:1', LOCAL_STATE_PATH: state, NODE_ENV: 'test', LOG_LEVEL: 'silent',
      HEARTBEAT_INTERVAL_MS: '5000', CID_SYNC_INTERVAL_MS: '30000', COMMITMENT_INTERVAL_MS: '30000',
      STATUS_INTERVAL_MS: '10000', MAX_PINNED_CIDS: '10', CID_CLASS_FILTERS: 'hot,warm',
    };
    const code = `import { runCli } from ${JSON.stringify(sourceUrl('src/cli/commands.ts'))};
import { promises as fs } from 'node:fs';
const leaseFile = ${JSON.stringify(leaseFile)};
let heldWhileRunning = false;
try { await runCli([${JSON.stringify(command)}]); } catch (error) { heldWhileRunning = await fs.stat(leaseFile).then(() => true, () => false); console.log('RUNCLI_ERROR ' + (error && error.message)); }
console.log('LEASE_HELD_AFTER_FAILURE ' + heldWhileRunning);
${tail}`;
    const child = spawn(process.execPath, ['--import', tsxLoader, '--input-type=module', '-e', code], { cwd: repoRoot, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = ''; let error = '';
    child.stdout.on('data', (chunk) => { output += String(chunk); });
    child.stderr.on('data', (chunk) => { error += String(chunk); });
    const status = await new Promise<number | null>((resolve) => { child.once('exit', (value) => resolve(value)); });
    // The lease really was taken before the failure (otherwise the test proves nothing)...
    expect(output).toContain('LEASE_HELD_AFTER_FAILURE true');
    expect(status).toBe(tail ? 75 : 0);
    // ...and the exit hook runCli armed removed it.
    expect(await exists(leaseFile), error).toBe(false);
  }, 30000);

  // Startup runs before waitForShutdown installs its handlers. A SIGTERM then (docker stop while the journal is being
  // cleaned against a restarting worker) used to kill the process without an 'exit' event, leaving the lease behind.
  it('the early-signal exit ends the process through process.exit with the conventional codes, and can be removed', () => {
    const exit = vi.fn();
    const before: [number, number] = [process.listenerCount('SIGTERM'), process.listenerCount('SIGINT')];
    const dispose = exitOnEarlySignal(exit);
    expect([process.listenerCount('SIGTERM'), process.listenerCount('SIGINT')]).toEqual([before[0] + 1, before[1] + 1]);
    // Call the handlers directly: emitting a signal here would also consume other tests' once() listeners.
    (process.listeners('SIGTERM').at(-1) as () => void)();
    (process.listeners('SIGINT').at(-1) as () => void)();
    expect(exit.mock.calls).toEqual([[143], [130]]);
    dispose();
    expect([process.listenerCount('SIGTERM'), process.listenerCount('SIGINT')]).toEqual(before);
  });

  it('runCli leaves no lease file behind when SIGTERM arrives while startup is still cleaning up against a worker that never answers', async () => {
    const { state, leaseFile, lease } = await leased();
    await lease.release();
    const env = {
      ...process.env,
      KUBUS_NODE_CONFIG_PATH: path.join(path.dirname(state), 'missing-config.env'),
      KUBUS_API_BASE_URL: 'http://127.0.0.1:1', KUBUS_OPERATOR_TOKEN: 'synthetic-token', KUBUS_OPERATOR_WALLET: 'synthetic-wallet',
      KUBUS_NODE_LABEL: 'synthetic', KUBUS_NODE_ENDPOINT_URL: 'http://127.0.0.1:1', IPFS_RPC_URL: 'http://127.0.0.1:1',
      IPFS_GATEWAY_URL: 'http://127.0.0.1:1', LOCAL_STATE_PATH: state, NODE_ENV: 'test', LOG_LEVEL: 'silent',
      HEARTBEAT_INTERVAL_MS: '5000', CID_SYNC_INTERVAL_MS: '30000', COMMITMENT_INTERVAL_MS: '30000',
      STATUS_INTERVAL_MS: '10000', MAX_PINNED_CIDS: '10', CID_CLASS_FILTERS: 'hot,warm',
      SPATIAL_WORKER_URL: 'http://127.0.0.1:1',
    };
    // A journal record whose job reached the worker, and a worker that accepts the connection and never answers: the
    // cleanup inside jobs.start() is blocked on it. The signal is raised from inside the child once that is certain
    // (a real signal cannot be sent to a Windows process without killing it).
    const code = `import net from 'node:net';
import { LocalStore } from ${JSON.stringify(sourceUrl('src/state/localStore.ts'))};
import { runCli } from ${JSON.stringify(sourceUrl('src/cli/commands.ts'))};
const id = '11111111-1111-4111-8111-111111111111';
const store = new LocalStore(${JSON.stringify(state)}); await store.load();
await store.update((s) => { (s.jobCleanup ??= {})[id] = { version: 1, jobId: id, type: 'spatial.reconstruct', state: 'pending', workerAttempted: true,
  workerInstanceId: '22222222-2222-4222-8222-222222222222', updatedAt: new Date().toISOString() }; });
const server = net.createServer((socket) => { socket.on('error', () => {}); console.log('WORKER_HIT'); setTimeout(() => process.emit('SIGTERM'), 150); });
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
process.env.SPATIAL_WORKER_URL = 'http://127.0.0.1:' + server.address().port;
runCli(['start']).then(() => console.log('RUNCLI_RETURNED'), (error) => console.log('RUNCLI_ERROR ' + (error && error.message)));`;
    const child = spawn(process.execPath, ['--import', tsxLoader, '--input-type=module', '-e', code], { cwd: repoRoot, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = ''; let error = '';
    child.stdout.on('data', (chunk) => { output += String(chunk); });
    child.stderr.on('data', (chunk) => { error += String(chunk); });
    // Without the early handler nothing reacts to the signal and the 20 s cancel timeout runs; fail well before that.
    const watchdog = setTimeout(() => child.kill('SIGKILL'), 15000);
    const status = await new Promise<number | null>((resolve) => { child.once('exit', (value) => resolve(value)); });
    clearTimeout(watchdog);
    expect(output, error).toContain('WORKER_HIT');
    expect(status, `${output}\n${error}`).toBe(143);
    expect(await exists(leaseFile)).toBe(false);
    const next = await acquireRuntimeLease(state);
    await next.release();
  }, 40000);
});
