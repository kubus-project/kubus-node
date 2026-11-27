import { afterEach, describe, expect, it, vi } from 'vitest';
import { existsSync, promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { acquireRuntimeLease } from '../src/runtime/runtimeLease.js';
import { SHUTDOWN_DEADLINE_MS, SHUTDOWN_STEP_BUDGET_MS, STARTUP_ABORT_GRACE_MS, waitForShutdown } from '../src/cli/commands.js';

// The Node agent was SIGKILLed on every stop (exit 137) because shutdown never
// completed and nothing bounded it. Docker's default grace period is 10s, so a
// stop that hangs is force-killed mid-write, which can truncate state.json.
// These tests exercise the real function rather than asserting on its text: the
// previous installer defect passed a text-matching test and still failed at
// runtime.

const never = () => new Promise<void>(() => {});

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

  it('a real forced process.exit with a stalled step leaves no lease file behind', async () => {
    const { state, leaseFile, lease } = await leased();
    await lease.release();
    const commands = pathToFileURL(path.resolve('src/cli/commands.ts')).href;
    const leaseModule = pathToFileURL(path.resolve('src/runtime/runtimeLease.ts')).href;
    const code = `import { waitForShutdown } from ${JSON.stringify(commands)}; import { acquireRuntimeLease } from ${JSON.stringify(leaseModule)};
const lease = await acquireRuntimeLease(${JSON.stringify(state)});
process.once('exit', lease.releaseSync);
const done = waitForShutdown({ stop: () => new Promise(() => {}) }, null, undefined, null, undefined, { deadlineMs: 200, stepBudgetMs: 40, releaseLease: lease.releaseSync });
setImmediate(() => process.emit('SIGTERM'));
void done;
setInterval(() => {}, 1000);`;
    const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', code], { stdio: ['ignore', 'pipe', 'pipe'] });
    let error = '';
    child.stderr.on('data', (chunk) => { error += String(chunk); });
    const status = await new Promise<number | null>((resolve) => { child.once('exit', (value) => resolve(value)); });
    expect(error).toBe('');
    expect(status).toBe(0);
    expect(await exists(leaseFile)).toBe(false);
    const next = await acquireRuntimeLease(state);
    await next.release();
  }, 20000);
});
