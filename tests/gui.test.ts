import { describe, expect, it } from 'vitest';
import type { IncomingMessage } from 'node:http';
import type { AppConfig } from '../src/config/schema.js';
import { ActionLock } from '../src/runtime/actionLock.js';
import { assertGuiConfig, authorizeGuiRequest } from '../src/gui/guiAuth.js';
import { startGuiServer } from '../src/gui/guiServer.js';
import { redactSecrets } from '../src/logging/logBuffer.js';

const baseConfig = {
  guiHost: '127.0.0.1',
  guiAllowRemote: false,
  guiToken: undefined,
} as AppConfig;

function request(remoteAddress: string, authorization?: string) {
  return {
    socket: { remoteAddress },
    headers: {
      authorization,
      cookie: '',
    },
  } as IncomingMessage;
}

describe('local GUI safety helpers', () => {
  it('allows tokenless GUI requests only from loopback localhost mode', () => {
    expect(authorizeGuiRequest(request('127.0.0.1'), baseConfig)).toBe(true);
    expect(authorizeGuiRequest(request('172.20.0.1'), baseConfig)).toBe(false);
  });

  it('requires a GUI token when exposed beyond localhost', () => {
    expect(() => assertGuiConfig({ ...baseConfig, guiHost: '0.0.0.0' } as AppConfig)).toThrow(/NODE_GUI_TOKEN/);
    expect(() => assertGuiConfig({ ...baseConfig, guiAllowRemote: true } as AppConfig)).toThrow(/NODE_GUI_TOKEN/);
    expect(() => assertGuiConfig({ ...baseConfig, guiHost: '0.0.0.0', guiToken: 'local-secret' } as AppConfig)).not.toThrow();
  });

  it('redacts operator tokens and Authorization headers in GUI payloads', () => {
    const redacted = redactSecrets({
      token: 'kubus_node_secret',
      nested: { Authorization: 'Bearer kubus_node_secret' },
      message: 'Authorization: Bearer kubus_node_secret',
    });
    expect(JSON.stringify(redacted)).not.toContain('kubus_node_secret');
    expect(JSON.stringify(redacted)).toContain('[redacted]');
  });

  it('serializes GUI and scheduler actions through a single lock', async () => {
    const lock = new ActionLock();
    let release: () => void = () => undefined;
    const first = lock.run('first', () => new Promise<void>((resolve) => {
      release = resolve;
    }));

    await expect(lock.run('second', async () => undefined)).rejects.toThrow(/first/);
    release();
    await first;
    await expect(lock.run('third', async () => 'ok')).resolves.toBe('ok');
  });

  it('serves redacted local status behind the GUI token', async () => {
    const config = {
      ...baseConfig,
      apiBaseUrl: 'http://api.test',
      operatorToken: 'kubus_node_secret',
      operatorWallet: 'wallet',
      nodeLabel: 'local-node',
      ipfsGatewayUrl: 'http://127.0.0.1:8080',
      guiEnabled: true,
      guiPort: 0,
      guiToken: 'gui-secret',
      guiDisplayUrl: 'http://my.node.kubus.site:8787/gui',
      guiFallbackUrl: 'http://127.0.0.1:8787/gui',
    } as AppConfig;
    const store = {
      snapshot: () => ({
        version: 1,
        nodeKey: 'kubus-node-secret-key',
        nodeId: 'node-1',
        publicPinSet: [],
        rewardableCids: [],
        desiredCids: [],
        pinnedCids: [],
        failedCids: {},
        activeCommitments: [],
      }),
    };
    const server = await startGuiServer({
      api: { getHealth: async () => ({ ok: true }) } as never,
      kubo: { id: async () => ({ ID: 'peer' }), version: async () => ({ Version: '0.41.0' }), repoStat: async () => ({}) } as never,
      store: store as never,
      config,
      logger: { info: () => undefined } as never,
      actionLock: new ActionLock(),
    });
    try {
      const response = await fetch(server.url.replace('/gui', '/gui/api/status'), {
        headers: { Authorization: 'Bearer gui-secret' },
      });
      const body = await response.text();
      expect(response.ok).toBe(true);
      expect(body).toContain('local-node');
      expect(body).not.toContain('kubus_node_secret');
      expect(body).not.toContain('kubus-node-secret-key');
    } finally {
      await server.close();
    }
  });
});
