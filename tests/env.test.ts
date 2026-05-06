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

  it('requires a GUI token when binding the GUI to all container interfaces', () => {
    expect(() => parseEnv({
      ...baseEnv,
      NODE_GUI_ENABLED: 'true',
      NODE_GUI_HOST: '0.0.0.0',
      NODE_GUI_TOKEN: '',
    })).toThrow(/NODE_GUI_TOKEN/);
  });

  it('accepts Docker GUI binding when a GUI token is configured', () => {
    const config = parseEnv({
      ...baseEnv,
      NODE_GUI_ENABLED: 'true',
      NODE_GUI_HOST: '0.0.0.0',
      NODE_GUI_PORT: '8787',
      NODE_GUI_TOKEN: 'local-gui-token',
      NODE_GUI_DISPLAY_URL: 'http://my.node.kubus.site:8787/gui',
    });

    expect(config.guiEnabled).toBe(true);
    expect(config.guiHost).toBe('0.0.0.0');
    expect(config.guiDisplayUrl).toBe('http://my.node.kubus.site:8787/gui');
    expect(config.guiFallbackUrl).toBe('http://127.0.0.1:8787/gui');
  });
});
