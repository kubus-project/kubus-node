import type { Logger } from '../logging/logger.js';

function pause(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const done = () => { clearTimeout(timer); signal.removeEventListener('abort', done); resolve(); };
    const timer = setTimeout(done, ms);
    signal.addEventListener('abort', done, { once: true });
  });
}

/** Recover coordination after a cold-start outage without restarting local services. */
export async function recoverNetworkStartup(options: {
  bootstrap: () => Promise<void>;
  activate: () => void;
  signal: AbortSignal;
  logger: Logger;
}): Promise<void> {
  let failures = 0;
  let lastLoggedAt = 0;
  while (!options.signal.aborted) {
    let bootstrapped = false;
    try {
      await options.bootstrap();
      if (options.signal.aborted) return;
      bootstrapped = true;
      options.activate();
      return;
    } catch (error) {
      const failure = error as { status?: number; statusCode?: number; code?: string };
      const status = failure.status ?? failure.statusCode;
      if (bootstrapped) {
        // Activation may have started some services already. Retrying it could
        // start duplicate schedulers; preserve local access and stop here.
        options.logger.warn({ status, code: failure.code }, 'network service activation failed; local services remain available');
        return;
      }
      if (status === 401 || status === 403 || failure.code === 'NODE_REGISTRATION_IDENTITY_MISMATCH') {
        options.logger.warn({ status, code: failure.code }, 'network startup requires authorization or identity repair; local services remain available');
        return;
      }
      failures++;
      const retryMs = Math.min(5000 * 2 ** Math.min(failures - 1, 4), 60000);
      if (failures === 1 || Date.now() - lastLoggedAt >= 60000) {
        options.logger.warn({ status, code: failure.code, retryMs }, 'network startup unavailable; retrying while local services remain available');
        lastLoggedAt = Date.now();
      }
      await pause(retryMs, options.signal);
    }
  }
}
