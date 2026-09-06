import { afterEach, expect, it, vi } from 'vitest';
import { recoverNetworkStartup } from '../src/runtime/networkStartup.js';
import type { Logger } from '../src/logging/logger.js';

afterEach(() => { vi.useRealTimers(); });
const logger = () => ({ warn: vi.fn() }) as unknown as Logger;

it('recovers transient startup failures and activates the network services once', async () => {
  vi.useFakeTimers();
  const bootstrap = vi.fn().mockRejectedValueOnce(new Error('backend offline')).mockResolvedValue(undefined);
  const activate = vi.fn();
  const pending = recoverNetworkStartup({ bootstrap, activate, signal: new AbortController().signal, logger: logger() });
  await vi.advanceTimersByTimeAsync(4999);
  expect(activate).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1);
  await pending;
  expect(bootstrap).toHaveBeenCalledTimes(2);
  expect(activate).toHaveBeenCalledTimes(1);
});

it.each([{ status: 401 }, { status: 403 }, { code: 'NODE_REGISTRATION_IDENTITY_MISMATCH' }])('stops authorization/identity failures without a retry loop: %j', async (error) => {
  const bootstrap = vi.fn().mockRejectedValue(error);
  const activate = vi.fn();
  await recoverNetworkStartup({ bootstrap, activate, signal: new AbortController().signal, logger: logger() });
  expect(bootstrap).toHaveBeenCalledTimes(1);
  expect(activate).not.toHaveBeenCalled();
});

it('stops an outstanding recovery delay on shutdown', async () => {
  vi.useFakeTimers();
  const controller = new AbortController();
  const bootstrap = vi.fn().mockRejectedValue(new Error('backend offline'));
  const activate = vi.fn();
  const pending = recoverNetworkStartup({ bootstrap, activate, signal: controller.signal, logger: logger() });
  await vi.advanceTimersByTimeAsync(1);
  controller.abort();
  await pending;
  await vi.advanceTimersByTimeAsync(60000);
  expect(bootstrap).toHaveBeenCalledTimes(1);
  expect(activate).not.toHaveBeenCalled();
});

it('never activates services if an in-flight bootstrap finishes after shutdown', async () => {
  const controller = new AbortController();
  let complete!: () => void;
  const bootstrap = () => new Promise<void>((resolve) => { complete = resolve; });
  const activate = vi.fn();
  const pending = recoverNetworkStartup({ bootstrap, activate, signal: controller.signal, logger: logger() });
  controller.abort(); complete();
  await pending;
  expect(activate).not.toHaveBeenCalled();
});

it('does not restart partially activated services when activation fails', async () => {
  const bootstrap = vi.fn().mockResolvedValue(undefined);
  const activate = vi.fn(() => { throw new Error('activation failure'); });
  await recoverNetworkStartup({ bootstrap, activate, signal: new AbortController().signal, logger: logger() });
  expect(bootstrap).toHaveBeenCalledTimes(1);
  expect(activate).toHaveBeenCalledTimes(1);
});
