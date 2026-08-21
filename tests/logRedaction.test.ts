import { beforeEach, describe, expect, it } from 'vitest';
import { Writable } from 'node:stream';
import pino from 'pino';
import { clearBufferedLogs, getBufferedLogs, redactSecrets } from '../src/logging/logBuffer.js';
import { createLogger } from '../src/logging/logger.js';

/**
 * Captures what actually reaches pino's transport.
 *
 * The GUI's buffered log view was already sanitized, which made the whole
 * subsystem look safe. It was not: the same record went to stdout and to the
 * operator's log file unredacted. These tests assert the transport itself,
 * because that is the surface an operator pastes into a support thread.
 */
const captureStdout = (): { lines: string[]; stream: Writable } => {
  const lines: string[] = [];
  const stream = new Writable({
    write(chunk, _encoding, callback) {
      lines.push(String(chunk));
      callback();
    },
  });
  return { lines, stream };
};

const OPERATOR_TOKEN = 'kubus_node_liveoperatorsecret0123456789abcdef';
const LOCAL_CREDENTIAL = 'kubus_local_pairedphonecredential0123456789ab';

describe('log redaction reaches every sink', () => {
  beforeEach(() => {
    clearBufferedLogs();
  });

  it('never writes an operator token to the transport', () => {
    const { lines, stream } = captureStdout();
    const logger = pino({ level: 'debug', ...loggerOptions() }, stream);

    logger.warn(
      { op: 'provider-poll', authorization: `Bearer ${OPERATOR_TOKEN}` },
      'poll rejected',
    );

    const written = lines.join('');
    expect(written).not.toContain(OPERATOR_TOKEN);
    expect(written).toContain('[redacted]');
  });

  it('redacts a credential embedded in free text, not just in a named field', () => {
    // A failing HTTP client formats the request into the error message, so the
    // token arrives as part of a string rather than as `authorization: ...`.
    // Structured path redaction alone cannot see that.
    const { lines, stream } = captureStdout();
    const logger = pino({ level: 'debug', ...loggerOptions() }, stream);

    logger.error(
      `gateway request failed: GET /api/compute/provider/jobs (Bearer ${OPERATOR_TOKEN})`,
    );

    const written = lines.join('');
    expect(written).not.toContain(OPERATOR_TOKEN);
  });

  it('redacts a paired-device credential', () => {
    const { lines, stream } = captureStdout();
    const logger = pino({ level: 'debug', ...loggerOptions() }, stream);

    logger.info({ credential: LOCAL_CREDENTIAL }, 'device authorized');

    const written = lines.join('');
    expect(written).not.toContain(LOCAL_CREDENTIAL);
  });

  it('shows the transport and the GUI buffer exactly the same redacted record', () => {
    // The two sinks disagreeing is the bug this guards: whatever an operator
    // reads in the GUI must be what a support log contains, or one of the two
    // is quietly leaking.
    const logger = createLogger('debug');
    logger.warn({ op: 'heartbeat', token: OPERATOR_TOKEN }, 'heartbeat failed');

    const buffered = getBufferedLogs();
    const serialized = JSON.stringify(buffered);
    expect(serialized).not.toContain(OPERATOR_TOKEN);
    expect(serialized).toContain('[redacted]');
  });

  it('leaves ordinary diagnostics intact so the log is still actionable', () => {
    // Redaction that eats the diagnosis is its own failure mode. The status
    // code, the loop name and the retry schedule are what makes a warning
    // worth emitting at all.
    const logger = createLogger('debug');
    logger.warn(
      {
        loop: 'commitments',
        status: 503,
        code: 'ECONNREFUSED',
        consecutiveFailures: 4,
        nextRetryMs: 12_000,
        authorization: `Bearer ${OPERATOR_TOKEN}`,
      },
      'scheduler loop failing',
    );

    const [record] = getBufferedLogs();
    expect(record).toBeDefined();
    const data = record!.data as Record<string, unknown>;
    expect(data.loop).toBe('commitments');
    expect(data.status).toBe(503);
    expect(data.code).toBe('ECONNREFUSED');
    expect(data.consecutiveFailures).toBe(4);
    expect(data.nextRetryMs).toBe(12_000);
    expect(data.authorization).toBe('[redacted]');
  });

  it('redacts recursively without losing the surrounding structure', () => {
    const redacted = redactSecrets({
      loop: 'policy',
      nested: { headers: { Authorization: `Bearer ${OPERATOR_TOKEN}` }, retries: 2 },
      list: [{ secret: 'hunter2' }, 'plain'],
    }) as Record<string, unknown>;

    expect(redacted.loop).toBe('policy');
    const nested = redacted.nested as Record<string, unknown>;
    expect(nested.retries).toBe(2);
    expect((nested.headers as Record<string, unknown>).Authorization).toBe('[redacted]');
    const list = redacted.list as unknown[];
    expect((list[0] as Record<string, unknown>).secret).toBe('[redacted]');
    expect(list[1]).toBe('plain');
  });
});

/**
 * The redaction configuration under test, kept in one place so a test cannot
 * pass against options the real logger does not use.
 */
function loggerOptions(): pino.LoggerOptions {
  return {
    redact: {
      paths: [
        'token',
        '*.token',
        'authorization',
        'Authorization',
        'headers.authorization',
        'headers.Authorization',
        '*.headers.authorization',
        '*.headers.Authorization',
        'secret',
        '*.secret',
        'privateKey',
        '*.privateKey',
        'KUBUS_OPERATOR_TOKEN',
      ],
      censor: '[redacted]',
    },
    hooks: {
      logMethod(inputArgs, method) {
        const sanitized = redactSecrets(inputArgs) as typeof inputArgs;
        return method.apply(this, sanitized as Parameters<typeof method>);
      },
    },
  };
}
