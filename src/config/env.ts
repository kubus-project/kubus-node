import dotenv from 'dotenv';
import { existsSync as fsExistsSync, readFileSync } from 'node:fs';
import { isIP } from 'node:net';
import os from 'node:os';
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
  // Docker injects only the safe, topology-specific defaults. The setup page
  // writes the operator choices to a 0600 file on the durable node volume, so
  // a first start never needs a hand-authored `.env` yet an explicit process
  // environment value still wins for managed deployments.
  const effectiveEnv = mergePersistedConfig(env);
  env = effectiveEnv;
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
  const explicitLanUrl = env.LOCAL_API_LAN_URL?.trim();
  const explicitRemoteUrl = env.LOCAL_API_REMOTE_URL?.trim();
  const legacyLocalApiUrl = parseLegacyApiUrl(
    env.LOCAL_API_PUBLIC_URL?.trim(),
    !explicitLanUrl,
    !explicitRemoteUrl,
  );
  const localApiLanUrl = explicitLanUrl
    ? parseLanApiUrl(explicitLanUrl, 'LOCAL_API_LAN_URL')
    : legacyLocalApiUrl.lanUrl ?? deriveLanApiUrl(localApiHost, localApiPort, localApiAllowLan);
  const localApiRemoteUrl = explicitRemoteUrl
    ? parseRemoteApiUrl(explicitRemoteUrl, 'LOCAL_API_REMOTE_URL')
    : legacyLocalApiUrl.remoteUrl;
  const localApiTrustedProxyAddresses = parseTrustedProxyAddresses(
    env.LOCAL_API_TRUSTED_PROXY_ADDRESSES,
    Boolean(localApiRemoteUrl),
  );
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
    localApiLanUrl,
    localApiRemoteUrl,
    localApiTrustedProxyAddresses,
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

/** Location intentionally follows LOCAL_STATE_PATH, so identity and setup move together on backup/restore. */
export function persistedConfigPath(env: NodeJS.ProcessEnv = process.env): string {
  const statePath = env.LOCAL_STATE_PATH?.trim() || path.join(process.cwd(), 'state.json');
  return path.join(path.dirname(path.resolve(statePath)), 'config.env');
}

function mergePersistedConfig(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const filePath = env.KUBUS_NODE_CONFIG_PATH?.trim() || persistedConfigPath(env);
  let persisted: NodeJS.ProcessEnv = {};
  try {
    if (fsExistsSync(filePath)) persisted = dotenv.parse(readFileSync(filePath));
  } catch (error) {
    // Treat a damaged configuration exactly like other invalid configuration:
    // startup stops and the setup surface gives the operator a repair route.
    throw new Error(`Unable to read kubus Node configuration: ${String((error as Error).message || error)}`);
  }
  // Compose materializes unset substitutions as empty strings. Treating those
  // as an explicit override would erase a value the setup page just persisted
  // on the node volume every time the container restarts.
  const explicit = Object.fromEntries(
    Object.entries(env).filter(([, value]) => value !== undefined && value !== ''),
  ) as NodeJS.ProcessEnv;
  return { ...persisted, ...explicit };
}

function parseLanApiUrl(value: string, key: string): string {
  const parsed = new URL(parseUrl(value, key));
  if (!['http:', 'https:'].includes(parsed.protocol) || !isPrivateLanHost(parsed.hostname)) {
    throw new Error(`${key} must be an HTTP(S) URL on a private LAN host, never loopback or public internet`);
  }
  return parsed.toString().replace(/\/$/, '');
}

function parseRemoteApiUrl(value: string, key: string): string {
  const parsed = new URL(parseUrl(value, key));
  if (parsed.protocol !== 'https:') throw new Error(`${key} must use HTTPS`);
  const host = normalizeHost(parsed.hostname);
  if (isLoopbackHost(host) || isWildcardHost(host)) {
    throw new Error(`${key} must use a phone-reachable host, never loopback or a wildcard bind`);
  }
  return parsed.toString().replace(/\/$/, '');
}

function parseLegacyApiUrl(
  value: string | undefined,
  acceptLan = true,
  acceptRemote = true,
): { lanUrl?: string; remoteUrl?: string } {
  if (!value) return {};
  if (!acceptLan && !acceptRemote) return {};
  const parsed = new URL(parseUrl(value, 'LOCAL_API_PUBLIC_URL'));
  if (isPrivateLanHost(parsed.hostname)) {
    if (!acceptLan) return {};
    return { lanUrl: parseLanApiUrl(value, 'LOCAL_API_PUBLIC_URL') };
  }
  if (!acceptRemote) return {};
  return { remoteUrl: parseRemoteApiUrl(value, 'LOCAL_API_PUBLIC_URL') };
}

function deriveLanApiUrl(host: string, port: number, enabled: boolean): string | undefined {
  if (!enabled) return undefined;
  // Listening on a wildcard (0.0.0.0 / ::) is the normal bare-metal setup, and
  // it is precisely the case that used to yield no endpoint at all: a wildcard
  // is not itself a routable address, so the node advertised nothing and
  // pairing failed with `pairing_endpoint_unavailable` — no QR, nothing to
  // scan. The operator has already said LAN access is intended, so resolve the
  // address a phone on the same network can actually reach.
  //
  // Deliberately NOT done inside a container: there `os.networkInterfaces()`
  // reports the container's own bridge address (commonly 172.17-18.x, which
  // is a private range and would pass every check here) while the phone must
  // reach the *host's* LAN address instead. Guessing would produce a QR that
  // scans perfectly and then never connects, which is strictly worse than an
  // honest failure — so containers must state their reachable URL explicitly
  // via LOCAL_API_LAN_URL.
  const resolved = isWildcardHost(host)
    ? isContainerRuntime()
      ? undefined
      : detectPrivateLanAddress()
    : host;
  if (!resolved || !isPrivateLanHost(resolved)) return undefined;
  const urlHost = resolved.includes(':') && !resolved.startsWith('[') ? `[${resolved}]` : resolved;
  return `http://${urlHost}:${port}`;
}

/** True when this process is running inside a container. */
export function isContainerRuntime(exists: (path: string) => boolean = fsExistsSync): boolean {
  return exists('/.dockerenv') || exists('/run/.containerenv');
}

/**
 * The node's own private LAN IPv4, or undefined when it has none.
 *
 * IPv4 only and non-internal only: a link-local/loopback/virtual address is
 * not something a phone can pair against, and advertising one would trade an
 * honest "unavailable" for a QR that silently never connects.
 */
export function detectPrivateLanAddress(
  interfaces: NodeJS.Dict<os.NetworkInterfaceInfo[]> = os.networkInterfaces(),
): string | undefined {
  for (const entries of Object.values(interfaces)) {
    for (const entry of entries ?? []) {
      if (entry.internal) continue;
      if (entry.family !== 'IPv4' && String(entry.family) !== '4') continue;
      if (isPrivateLanHost(entry.address)) return entry.address;
    }
  }
  return undefined;
}

function isPrivateLanHost(host: string): boolean {
  const normalized = normalizeHost(host);
  if (isLoopbackHost(normalized) || isWildcardHost(normalized)) return false;
  if (normalized.endsWith('.local') || normalized.endsWith('.internal')) return true;
  const ipv4 = ipv4Octets(normalized);
  if (ipv4) {
    const first = ipv4[0] ?? -1;
    const second = ipv4[1] ?? -1;
    return first === 10 ||
      (first === 192 && second === 168) ||
      (first === 172 && second >= 16 && second <= 31);
  }
  // RFC 4193 IPv6 unique-local addresses (fc00::/7).
  if (isIP(normalized) === 6) return /^f[cd][0-9a-f]{2}:/.test(normalized);
  return false;
}

function ipv4Octets(host: string): number[] | undefined {
  if (isIP(host) === 4) return host.split('.').map(Number);
  if (isIP(host) !== 6 || !host.startsWith('::ffff:')) return undefined;
  const suffix = host.slice('::ffff:'.length);
  if (isIP(suffix) === 4) return suffix.split('.').map(Number);
  const groups = suffix.split(':');
  if (groups.length !== 2) return undefined;
  const high = Number.parseInt(groups[0] || '', 16);
  const low = Number.parseInt(groups[1] || '', 16);
  if (!Number.isFinite(high) || !Number.isFinite(low)) return undefined;
  return [high >>> 8, high & 0xff, low >>> 8, low & 0xff];
}

function isWildcardHost(host: string): boolean {
  const normalized = normalizeHost(host);
  if (normalized === '::') return true;
  const ipv4 = ipv4Octets(normalized);
  return Boolean(ipv4 && ipv4.every((octet) => octet === 0));
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
  const host = normalizeHost(new URL(raw).hostname);
  if (['localhost', '127.0.0.1', '::1', 'kubo', 'ipfs'].includes(host)) return true;
  return isPrivateLanHost(host);
}

export function isLoopbackHost(host: string): boolean {
  const normalized = normalizeHost(host);
  if (normalized === 'localhost' || normalized === '::1') return true;
  const ipv4 = ipv4Octets(normalized);
  return Boolean(ipv4 && ipv4[0] === 127);
}

function normalizeHost(host: string): string {
  return host.trim().toLowerCase().replace(/^\[/, '').replace(/\]$/, '').replace(/\.$/, '');
}

function parseTrustedProxyAddresses(value: string | undefined, remoteConfigured: boolean): string[] {
  const addresses = [...new Set((value || '').split(',').map(normalizePeerAddress).filter(Boolean))];
  if (addresses.length > 0 && !remoteConfigured) {
    throw new Error('LOCAL_API_TRUSTED_PROXY_ADDRESSES requires LOCAL_API_REMOTE_URL');
  }
  if (addresses.some((address) => isIP(address) === 0)) {
    throw new Error('LOCAL_API_TRUSTED_PROXY_ADDRESSES must contain exact IP addresses');
  }
  return addresses;
}

function normalizePeerAddress(address: string): string {
  const normalized = normalizeHost(address).split('%', 1)[0] || '';
  const mapped = ipv4Octets(normalized);
  return mapped ? mapped.join('.') : normalized;
}
