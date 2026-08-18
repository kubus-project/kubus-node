import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
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

  it('requires HTTPS for a configured remote phone API endpoint', () => {
    expect(() => parseEnv({ ...baseEnv, LOCAL_API_REMOTE_URL: 'http://node.example.test' })).toThrow(/HTTPS/);
    expect(parseEnv({ ...baseEnv, LOCAL_API_REMOTE_URL: 'https://node.example.test' }).localApiRemoteUrl)
      .toBe('https://node.example.test');
  });

  it('rejects loopback and wildcard HTTPS remote endpoints', () => {
    for (const endpoint of [
      'https://localhost:8787',
      'https://localhost.:8787',
      'https://127.0.0.1:8787',
      'https://127.0.0.1.:8787',
      'https://127.0.0.2:8787',
      'https://127.255.255.255:8787',
      'https://0.0.0.0:8787',
      'https://[::1]:8787',
      'https://[::]:8787',
      'https://[::ffff:127.0.0.1]:8787',
      'https://[::ffff:127.255.255.255]:8787',
      'https://[::ffff:0.0.0.0]:8787',
    ]) {
      expect(() => parseEnv({ ...baseEnv, LOCAL_API_REMOTE_URL: endpoint }))
        .toThrow(/phone-reachable/);
    }
  });

  it('preserves the legacy public endpoint while deployments migrate', () => {
    expect(parseEnv({ ...baseEnv, LOCAL_API_PUBLIC_URL: 'https://legacy.example.test' }).localApiRemoteUrl)
      .toBe('https://legacy.example.test');
    expect(parseEnv({ ...baseEnv, LOCAL_API_PUBLIC_URL: 'http://192.168.1.24:8787' }).localApiLanUrl)
      .toBe('http://192.168.1.24:8787');
    expect(parseEnv({
      ...baseEnv,
      LOCAL_API_PUBLIC_URL: 'https://legacy.example.test',
      LOCAL_API_REMOTE_URL: 'https://current.example.test',
    }).localApiRemoteUrl).toBe('https://current.example.test');
  });

  it('accepts only exact trusted proxy IPs for a configured remote endpoint', () => {
    expect(parseEnv({
      ...baseEnv,
      LOCAL_API_REMOTE_URL: 'https://node.example.test',
      LOCAL_API_TRUSTED_PROXY_ADDRESSES: '172.17.0.1, ::ffff:172.17.0.1, fd00::1',
    }).localApiTrustedProxyAddresses).toEqual(['172.17.0.1', 'fd00::1']);
    expect(() => parseEnv({
      ...baseEnv,
      LOCAL_API_TRUSTED_PROXY_ADDRESSES: '172.17.0.1',
    })).toThrow(/requires LOCAL_API_REMOTE_URL/);
    expect(() => parseEnv({
      ...baseEnv,
      LOCAL_API_REMOTE_URL: 'https://node.example.test',
      LOCAL_API_TRUSTED_PROXY_ADDRESSES: 'proxy.internal',
    })).toThrow(/exact IP addresses/);
  });

  it('accepts explicit and legacy IPv6 unique-local LAN endpoints', () => {
    const explicit = parseEnv({
      ...baseEnv,
      LOCAL_API_ALLOW_LAN: 'true',
      LOCAL_API_LAN_URL: 'http://[fd00::1]:8787',
    });
    expect(explicit.localApiLanUrl).toBe('http://[fd00::1]:8787');

    const legacy = parseEnv({
      ...baseEnv,
      LOCAL_API_ALLOW_LAN: 'true',
      LOCAL_API_PUBLIC_URL: 'http://[fcab::42]:8787',
    });
    expect(legacy.localApiLanUrl).toBe('http://[fcab::42]:8787');
  });

  it('rejects IPv6 addresses outside the exact RFC 4193 ULA range', () => {
    for (const endpoint of [
      'http://[fc::1]:8787',
      'http://[fcd::1]:8787',
      'http://[fe00::1]:8787',
    ]) {
      expect(() => parseEnv({
        ...baseEnv,
        LOCAL_API_ALLOW_LAN: 'true',
        LOCAL_API_LAN_URL: endpoint,
      })).toThrow(/private LAN host/);
    }
  });

  it('does not accept private-looking public hostnames as LAN addresses', () => {
    for (const endpoint of [
      'http://10.attacker.example:8787',
      'http://192.168.attacker.example:8787',
      'http://172.16.attacker.example:8787',
    ]) {
      expect(() => parseEnv({
        ...baseEnv,
        LOCAL_API_ALLOW_LAN: 'true',
        LOCAL_API_LAN_URL: endpoint,
      })).toThrow(/private LAN host/);
    }
  });

  it('applies RFC1918 rules to IPv4-mapped IPv6 LAN addresses', () => {
    const config = parseEnv({
      ...baseEnv,
      LOCAL_API_ALLOW_LAN: 'true',
      LOCAL_API_LAN_URL: 'http://[::ffff:192.168.1.24]:8787',
    });
    expect(config.localApiLanUrl).toBe('http://[::ffff:c0a8:118]:8787');
    expect(() => parseEnv({
      ...baseEnv,
      LOCAL_API_ALLOW_LAN: 'true',
      LOCAL_API_LAN_URL: 'http://[::ffff:203.0.113.1]:8787',
    })).toThrow(/private LAN host/);
  });

  it('leaves the optional sample remote endpoint disabled', () => {
    const sample = readFileSync(new URL('../.env.example', import.meta.url), 'utf8');
    expect(sample).toMatch(/^LOCAL_API_REMOTE_URL=$/m);
  });

  it('brackets a derived IPv6 unique-local endpoint', () => {
    const config = parseEnv({
      ...baseEnv,
      LOCAL_API_ALLOW_LAN: 'true',
      LOCAL_API_HOST: 'fd00::1',
      LOCAL_API_PORT: '8787',
    });
    expect(config.localApiLanUrl).toBe('http://[fd00::1]:8787');
  });

  it('ignores a stale legacy value when its endpoint slot is replaced', () => {
    const remote = parseEnv({
      ...baseEnv,
      LOCAL_API_PUBLIC_URL: 'http://public.example.test',
      LOCAL_API_REMOTE_URL: 'https://current.example.test',
    });
    expect(remote.localApiRemoteUrl).toBe('https://current.example.test');

    const complete = parseEnv({
      ...baseEnv,
      LOCAL_API_PUBLIC_URL: 'not-a-url',
      LOCAL_API_ALLOW_LAN: 'true',
      LOCAL_API_LAN_URL: 'http://192.168.1.24:8787',
      LOCAL_API_REMOTE_URL: 'https://current.example.test',
    });
    expect(complete.localApiLanUrl).toBe('http://192.168.1.24:8787');
    expect(complete.localApiRemoteUrl).toBe('https://current.example.test');
  });
});
