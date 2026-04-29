import 'dotenv/config';
import path from 'node:path';
import type { LocalStore } from '../state/localStore.js';
import type { AppConfig } from './schema.js';

function requireString(env: NodeJS.ProcessEnv, key: string): string {
  const value = env[key]?.trim();
  if (!value) throw new Error(`Missing required env ${key}`);
  return value;
}

function parseIntEnv(env: NodeJS.ProcessEnv, key: string, min: number): number {
  const raw = requireString(env, key);
  const value = Number.parseInt(raw, 10);
  if (!Number.isFinite(value) || value < min) throw new Error(`Invalid ${key}: must be >= ${min}`);
  return value;
}

function parseUrl(value: string, key: string): string {
  try {
    return new URL(value).toString().replace(/\/$/, '');
  } catch {
    throw new Error(`Invalid ${key}: must be a URL`);
  }
}

function boolEnv(env: NodeJS.ProcessEnv, key: string, fallback: boolean): boolean {
  const raw = env[key]?.trim().toLowerCase();
  if (!raw) return fallback;
  return ['1', 'true', 'yes', 'on'].includes(raw);
}

export function parseEnv(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const nodeEnv = requireString(env, 'NODE_ENV');
  const authMode = (env.KUBUS_AUTH_MODE || 'bearer').trim().toLowerCase();
  if (authMode !== 'bearer') throw new Error('Only KUBUS_AUTH_MODE=bearer is supported in v1');
  const isProduction = nodeEnv === 'production';
  const ipfsRpcUrl = parseUrl(requireString(env, 'IPFS_RPC_URL'), 'IPFS_RPC_URL');
  if (isProduction && !isPrivateRpcUrl(ipfsRpcUrl)) {
    throw new Error('IPFS_RPC_URL must be loopback, private-network, or Docker-internal in production');
  }
  const skipPinning = boolEnv(env, 'KUBUS_SKIP_PINNING', false);
  if (isProduction && skipPinning) {
    throw new Error('KUBUS_SKIP_PINNING is not allowed in production');
  }
  return {
    apiBaseUrl: parseUrl(requireString(env, 'KUBUS_API_BASE_URL'), 'KUBUS_API_BASE_URL'),
    operatorToken: requireString(env, 'KUBUS_OPERATOR_TOKEN'),
    operatorWallet: requireString(env, 'KUBUS_OPERATOR_WALLET'),
    nodeLabel: requireString(env, 'KUBUS_NODE_LABEL'),
    nodeEndpointUrl: parseUrl(requireString(env, 'KUBUS_NODE_ENDPOINT_URL'), 'KUBUS_NODE_ENDPOINT_URL'),
    ipfsRpcUrl,
    ipfsGatewayUrl: parseUrl(requireString(env, 'IPFS_GATEWAY_URL'), 'IPFS_GATEWAY_URL'),
    localStatePath: path.resolve(requireString(env, 'LOCAL_STATE_PATH')),
    logLevel: requireString(env, 'LOG_LEVEL'),
    heartbeatIntervalMs: parseIntEnv(env, 'HEARTBEAT_INTERVAL_MS', 5000),
    cidSyncIntervalMs: parseIntEnv(env, 'CID_SYNC_INTERVAL_MS', 30000),
    commitmentIntervalMs: parseIntEnv(env, 'COMMITMENT_INTERVAL_MS', 30000),
    statusIntervalMs: parseIntEnv(env, 'STATUS_INTERVAL_MS', 10000),
    maxPinnedCids: parseIntEnv(env, 'MAX_PINNED_CIDS', 1),
    cidClassFilters: requireString(env, 'CID_CLASS_FILTERS').split(',').map((v) => v.trim()).filter(Boolean),
    nodeEnv,
    nodeKey: env.KUBUS_NODE_KEY?.trim() || undefined,
    authMode: 'bearer',
    devSeedCid: env.KUBUS_DEV_SEED_CID?.trim() || undefined,
    devAllowEmptyCids: boolEnv(env, 'KUBUS_DEV_ALLOW_EMPTY_CIDS', false),
    skipPinning,
    verifierEndpointUrl: env.KUBUS_VERIFIER_ENDPOINT_URL?.trim() || undefined,
    isProduction,
  };
}

export async function resolveNodeKey(config: AppConfig, store: LocalStore): Promise<string> {
  if (config.isProduction && config.devSeedCid) {
    throw new Error('KUBUS_DEV_SEED_CID is not allowed in production');
  }
  if (config.isProduction && config.devAllowEmptyCids) {
    throw new Error('KUBUS_DEV_ALLOW_EMPTY_CIDS is not allowed in production');
  }
  return store.getOrCreateNodeKey(config.nodeKey);
}

function isPrivateRpcUrl(raw: string): boolean {
  const host = new URL(raw).hostname.toLowerCase();
  if (['localhost', '127.0.0.1', '::1', 'kubo', 'ipfs'].includes(host)) return true;
  if (host.endsWith('.local') || host.endsWith('.internal')) return true;
  if (/^10\./.test(host)) return true;
  if (/^192\.168\./.test(host)) return true;
  const match172 = host.match(/^172\.(\d+)\./);
  return Boolean(match172 && Number(match172[1]) >= 16 && Number(match172[1]) <= 31);
}
