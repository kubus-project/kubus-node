export interface BufferedLogRecord {
  id: number;
  at: string;
  level: string;
  message: string;
  data?: unknown;
}

const MAX_LOGS = 500;
const records: BufferedLogRecord[] = [];
let sequence = 0;

const TOKEN_PATTERNS = [
  /kubus_node_[A-Za-z0-9._~-]+/g,
  /(Authorization\s*:\s*Bearer\s+)[A-Za-z0-9._~-]+/gi,
  /("authorization"\s*:\s*"Bearer\s+)[^"]+(")/gi,
  /("KUBUS_OPERATOR_TOKEN"\s*:\s*")[^"]+(")/gi,
  /("NODE_GUI_TOKEN"\s*:\s*")[^"]+(")/gi,
];

export function redactSecrets<T>(value: T): T {
  if (typeof value === 'string') {
    let next: string = value;
    for (const pattern of TOKEN_PATTERNS) {
      next = next.replace(pattern, (match, prefix = '', suffix = '') => {
        if (match.startsWith('kubus_node_')) return 'kubus_node_[redacted]';
        return `${prefix}[redacted]${suffix}`;
      });
    }
    return next as T;
  }
  if (Array.isArray(value)) {
    return value.map((entry) => redactSecrets(entry)) as T;
  }
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      const normalizedKey = key.toLowerCase();
      if (
        normalizedKey.includes('token') ||
        normalizedKey.includes('authorization') ||
        normalizedKey.includes('secret') ||
        normalizedKey.includes('privatekey') ||
        normalizedKey.includes('seed')
      ) {
        out[key] = '[redacted]';
      } else {
        out[key] = redactSecrets(entry);
      }
    }
    return out as T;
  }
  return value;
}

export function appendLog(level: string, args: unknown[]): void {
  const sanitizedArgs = redactSecrets(args);
  const message = sanitizedArgs
    .filter((entry) => typeof entry === 'string')
    .join(' ')
    .trim();
  const data = sanitizedArgs.find((entry) => entry && typeof entry === 'object');
  records.push({
    id: sequence += 1,
    at: new Date().toISOString(),
    level,
    message: message || level,
    data,
  });
  if (records.length > MAX_LOGS) {
    records.splice(0, records.length - MAX_LOGS);
  }
}

export function getBufferedLogs(level?: string | null): BufferedLogRecord[] {
  const normalized = level?.trim().toLowerCase();
  const source = normalized ? records.filter((record) => record.level === normalized) : records;
  return source.slice().reverse();
}

export function clearBufferedLogs(): void {
  records.length = 0;
}
