import pino from 'pino';

export function createLogger(level = 'info') {
  return pino({
    level,
    redact: {
      paths: ['token', '*.token', 'authorization', 'headers.authorization', 'KUBUS_OPERATOR_TOKEN'],
      censor: '[redacted]',
    },
  });
}

export type Logger = ReturnType<typeof createLogger>;
