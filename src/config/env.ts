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

function parseOptionalIntEnv(env: NodeJS.ProcessEnv, key: string, fallback: number, min: number): number {
  const raw = env[key]?.trim();
  if (!raw) return fallback;
  const value = Number.parseInt(raw, 10);
  if (!Number.isFinite(value) || value < min) throw new Error(`Invalid ${key}: must be >= ${min}`);
  return value;
}

function parseOptionalBytesEnv(env: NodeJS.ProcessEnv, key: string, fallback: number): number {
  const raw = env[key]?.trim();
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`Invalid ${key}: must be a non-negative safe integer`);
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
  const guiEnabled = boolEnv(env, 'NODE_GUI_ENABLED', false);
  const guiHost = (env.NODE_GUI_HOST || '127.0.0.1').trim() || '127.0.0.1';
  const guiPort = parseOptionalIntEnv(env, 'NODE_GUI_PORT', 8787, 1);
  const guiToken = env.NODE_GUI_TOKEN?.trim() || undefined;
  const guiAllowRemote = boolEnv(env, 'NODE_GUI_ALLOW_REMOTE', false);
  const guiDisplayUrl = (env.NODE_GUI_DISPLAY_URL || 'http://my.node.kubus.site:8787/gui').trim();
  const guiFallbackUrl = `http://127.0.0.1:${guiPort}/gui`;
  const guiRemoteMode = guiAllowRemote || !isLoopbackHost(guiHost);
  if (guiEnabled && guiRemoteMode && !guiToken) {
    throw new Error('NODE_GUI_TOKEN is required when NODE_GUI_HOST is remote or NODE_GUI_ALLOW_REMOTE=true');
  }
  const localApiEnabled = boolEnv(env, 'LOCAL_API_ENABLED', true);
  const localApiHost = (env.LOCAL_API_HOST || guiHost).trim() || guiHost;
  const localApiPort = parseOptionalIntEnv(env, 'LOCAL_API_PORT', guiPort, 1);
  const localApiAllowLan = boolEnv(env, 'LOCAL_API_ALLOW_LAN', false);
  const localApiPublicUrl = env.LOCAL_API_PUBLIC_URL?.trim()
    ? parseUrl(env.LOCAL_API_PUBLIC_URL.trim(), 'LOCAL_API_PUBLIC_URL')
    : undefined;
  if (guiEnabled && localApiEnabled && (localApiPort !== guiPort || localApiHost !== guiHost)) {
    throw new Error('LOCAL_API_HOST/PORT must match NODE_GUI_HOST/PORT when both services are enabled');
  }
  if (localApiEnabled && !isLoopbackHost(localApiHost) && !localApiAllowLan && localApiPort !== guiPort) {
    throw new Error('LOCAL_API_ALLOW_LAN=true is required when LOCAL_API_HOST is not loopback');
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
    maxPinnedBytes: parseOptionalBytesEnv(env, 'MAX_PINNED_BYTES', 50 * 1024 * 1024 * 1024),
    cidClassFilters: requireString(env, 'CID_CLASS_FILTERS').split(',').map((v) => v.trim()).filter(Boolean),
    nodeEnv,
    nodeKey: env.KUBUS_NODE_KEY?.trim() || undefined,
    authMode: 'bearer',
    devSeedCid: env.KUBUS_DEV_SEED_CID?.trim() || undefined,
    devAllowEmptyCids: boolEnv(env, 'KUBUS_DEV_ALLOW_EMPTY_CIDS', false),
    skipPinning,
    verifierEndpointUrl: env.KUBUS_VERIFIER_ENDPOINT_URL?.trim() || undefined,
    isProduction,
    guiEnabled,
    guiHost,
    guiPort,
    guiToken,
    guiAllowRemote,
    guiDisplayUrl,
    guiFallbackUrl,
    localApiEnabled,
    localApiHost,
    localApiPort,
    localApiAllowLan,
    localApiPublicUrl,
    pairingSessionTtlMs: parseOptionalIntEnv(env, 'PAIRING_SESSION_TTL_MS', 5 * 60 * 1000, 30000),
    localDataPath: path.resolve(env.LOCAL_DATA_PATH?.trim() || path.join(path.dirname(requireString(env, 'LOCAL_STATE_PATH')), 'data')),
    jobConcurrency: parseOptionalIntEnv(env, 'JOB_CONCURRENCY', 1, 1),
    spatialWorkerUrl: env.SPATIAL_WORKER_URL?.trim() ? parseUrl(env.SPATIAL_WORKER_URL.trim(), 'SPATIAL_WORKER_URL') : undefined,
    offerRemoteCompute: boolEnv(env, 'OFFER_REMOTE_COMPUTE', false),
    remoteComputePaused: boolEnv(env, 'REMOTE_COMPUTE_PAUSED', false),
    remoteComputeMaxConcurrency: parseOptionalIntEnv(env, 'REMOTE_COMPUTE_MAX_CONCURRENCY', 1, 1),
    remoteComputeMaxQueueDepth: parseOptionalIntEnv(env, 'REMOTE_COMPUTE_MAX_QUEUE_DEPTH', 2, 1),
    remoteComputeMaxInputBytes: parseOptionalBytesEnv(env, 'REMOTE_COMPUTE_MAX_INPUT_BYTES', 20 * 1024 * 1024 * 1024),
    remoteComputeMinimumFreeVramBytes: parseOptionalBytesEnv(env, 'REMOTE_COMPUTE_MINIMUM_FREE_VRAM_BYTES', 2 * 1024 * 1024 * 1024),
    participationGraceMs: parseOptionalIntEnv(env, 'PARTICIPATION_GRACE_MS', 15 * 60 * 1000, 60000),
    workerAuthKeyPath: path.resolve(env.WORKER_AUTH_KEY_PATH?.trim() || path.join(path.dirname(requireString(env, 'LOCAL_STATE_PATH')), 'worker-auth.key')),
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

export function isLoopbackHost(host: string): boolean {
  const normalized = host.trim().toLowerCase();
  return ['localhost', '127.0.0.1', '::1'].includes(normalized);
}
