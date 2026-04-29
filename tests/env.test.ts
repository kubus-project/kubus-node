import { describe, expect, it } from 'vitest';
import { parseEnv } from '../src/config/env.js';

const baseEnv = {
  KUBUS_API_BASE_URL: 'http://localhost:3000',
  KUBUS_OPERATOR_TOKEN: 'token',
  KUBUS_OPERATOR_WALLET: 'wallet',
  KUBUS_NODE_LABEL: 'node',
  KUBUS_NODE_ENDPOINT_URL: 'http://localhost:8080',
  IPFS_RPC_URL: 'http://localhost:5001',
  IPFS_GATEWAY_URL: 'http://localhost:8080',
  LOCAL_STATE_PATH: './data/state.json',
  LOG_LEVEL: 'info',
  HEARTBEAT_INTERVAL_MS: '5000',
  CID_SYNC_INTERVAL_MS: '30000',
  COMMITMENT_INTERVAL_MS: '30000',
  STATUS_INTERVAL_MS: '10000',
  MAX_PINNED_CIDS: '10',
  CID_CLASS_FILTERS: 'hot,warm',
  NODE_ENV: 'development',
};

describe('parseEnv', () => {
  it('parses required config', () => {
    const config = parseEnv(baseEnv);
    expect(config.apiBaseUrl).toBe('http://localhost:3000');
    expect(config.cidClassFilters).toEqual(['hot', 'warm']);
  });

  it('fails clearly when required values are missing', () => {
    expect(() => parseEnv({ ...baseEnv, KUBUS_OPERATOR_TOKEN: '' })).toThrow(/KUBUS_OPERATOR_TOKEN/);
  });

  it('rejects unsafe production switches', () => {
    expect(() => parseEnv({ ...baseEnv, NODE_ENV: 'production', KUBUS_SKIP_PINNING: 'true' })).toThrow(/SKIP_PINNING/);
    expect(() => parseEnv({ ...baseEnv, NODE_ENV: 'production', IPFS_RPC_URL: 'http://example.com:5001' })).toThrow(/IPFS_RPC_URL/);
  });
});
