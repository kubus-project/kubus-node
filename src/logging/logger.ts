import pino from 'pino';
import { appendLog } from './logBuffer.js';

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
      paths: ['token', '*.token', 'authorization', 'headers.authorization', 'KUBUS_OPERATOR_TOKEN'],
      censor: '[redacted]',
    },
    hooks: {
      logMethod(inputArgs, method, levelNumber) {
        appendLog(levelLabels[levelNumber] || 'info', inputArgs);
        return method.apply(this, inputArgs as Parameters<typeof method>);
      },
    },
  });
}

export type Logger = ReturnType<typeof createLogger>;
