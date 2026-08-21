import pino from 'pino';
import { appendLog, redactSecrets } from './logBuffer.js';

const levelLabels: Record<number, string> = {
  10: 'trace',
  20: 'debug',
  30: 'info',
  40: 'warn',
  50: 'error',
  60: 'fatal',
};

export function createLogger(level = 'info') {
  return pino({
    level,
    redact: {
      // Header casing is not normalised anywhere before logging, and the
      // node's own requests send `Authorization` with a capital A, so a
      // lowercase-only path would silently miss the one header that matters.
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
      logMethod(inputArgs, method, levelNumber) {
        // Redact once, then use the same sanitized arguments for both sinks.
        // The GUI's buffered view used to be the only protected surface, so a
        // credential embedded in an error message reached stdout and the
        // operator's log file unredacted while appearing safe in the UI. The
        // structured `redact.paths` above only covers known field names; this
        // also catches a token pasted into free text, which is the shape a
        // failing HTTP client actually produces.
        const sanitized = redactSecrets(inputArgs) as typeof inputArgs;
        appendLog(levelLabels[levelNumber] || 'info', sanitized);
        return method.apply(this, sanitized as Parameters<typeof method>);
      },
    },
  });
}

export type Logger = ReturnType<typeof createLogger>;
