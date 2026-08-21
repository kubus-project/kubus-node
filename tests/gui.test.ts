import { describe, expect, it } from 'vitest';
import type { IncomingMessage } from 'node:http';
import type { AppConfig } from '../src/config/schema.js';
import type { SpatialWorkerHealth } from '../src/capabilities/registry.js';
import { ActionLock } from '../src/runtime/actionLock.js';
import { assertGuiConfig, authorizeGuiRequest } from '../src/gui/guiAuth.js';
import { startGuiServer } from '../src/gui/guiServer.js';
import { guiJs } from '../src/gui/public/guiJs.js';
import { escapeHtml } from '../src/gui/presentation.js';
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

  it('ships a GUI client that parses as JavaScript', () => {
    // The client is a template literal compiled into the server bundle, so a
    // syntax error would otherwise only surface in a browser.
    expect(() => new Function(guiJs)).not.toThrow();
  });

  it('binds the copy action inserted with an active pairing session', () => {
    const pairingRenderer = guiJs.slice(
      guiJs.indexOf('function renderPairingArea()'),
      guiJs.indexOf('function renderDiagnostics()'),
    );
    expect(pairingRenderer).toContain("area.querySelector('[data-copy]')");
    expect(pairingRenderer).toContain('copyText(copyPairing.dataset.copy)');
    expect(pairingRenderer).toContain('Copy failed. Select the pairing code');
  });

  it('falls back when the Clipboard API is unavailable or denied', () => {
    expect(guiJs).toContain("typeof navigator.clipboard.writeText === 'function'");
    expect(guiJs).toContain("document.createElement('textarea')");
    expect(guiJs).toContain("document.execCommand('copy')");
    expect(guiJs).toContain('return copied;');
  });

  it('escapes with the same rules as the server', () => {
    // The client carries its own copy of escapeHtml because it cannot import
    // from the runtime. If one side is ever weakened, the two diverge here.
    for (const replacement of ['&amp;', '&lt;', '&gt;', '&quot;', '&#39;']) {
      expect(guiJs).toContain(replacement);
    }
    expect(escapeHtml('<img src=x onerror="alert(1)">')).toBe(
      '&lt;img src=x onerror=&quot;alert(1)&quot;&gt;',
    );
  });

  it('injects raw HTML only for the locally generated pairing QR', () => {
    // Everything else reaches the page through h(). The QR is an SVG this node
    // built itself from a fixed path template, so it is the one safe exception.
    const rawInjections = guiJs.match(/\+\s*(?:pairing\.qrSvg|[a-zA-Z.]*[Hh]tml)\b/g) || [];
    expect(rawInjections).toEqual(['+ pairing.qrSvg']);
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

  describe('redesigned GUI endpoints', () => {
    const nodeConfig = {
      ...baseConfig,
      apiBaseUrl: 'http://api.test',
      operatorToken: 'kubus_node_operator_secret',
      nodeLabel: 'ROK-DESKTOP',
      ipfsGatewayUrl: 'http://127.0.0.1:8080',
      guiEnabled: true,
      guiPort: 0,
      guiToken: 'gui-secret',
      maxPinnedCids: 5000,
      maxPinnedBytes: 50 * 1024 ** 3,
      cidClassFilters: [],
      localApiEnabled: false,
      localApiAllowLan: false,
      localApiPort: 8787,
      pairingSessionTtlMs: 300000,
    } as unknown as AppConfig;

    const snapshot = {
      version: 1,
      nodeKey: 'kubus-node-secret-key',
      nodeId: 'node-1',
      peerId: '12D3KooWExamplePeerIdentifierValue',
      publicPinSet: [],
      rewardableCids: [],
      desiredCids: [{ cid: 'bafyone', sizeBytes: 1024 ** 3, role: 'record' }],
      pinnedCids: ['bafyone'],
      failedCids: {},
      activeCommitments: [],
      localCredentials: {},
    };

    const readyWorker: SpatialWorkerHealth = { status: 'ready', gpu: { available: true, model: 'RTX 3080 Ti', totalVramBytes: 12 * 1024 ** 3 }, capabilities: [] };

    function startNode(options: { workerHealth?: SpatialWorkerHealth; onRefresh?: () => void } = {}) {
      const workerHealth = options.workerHealth ?? readyWorker;
      return startGuiServer({
        api: { getHealth: async () => ({ ok: true }) } as never,
        kubo: {
          id: async () => ({ ID: 'peer' }),
          version: async () => ({ Version: '0.41.0' }),
          repoStat: async () => ({ RepoSize: 2 * 1024 ** 3, StorageMax: 100 * 1024 ** 3 }),
        } as never,
        store: {
          snapshot: () => snapshot,
          update: async (mutate: (state: unknown) => void) => { mutate(snapshot); },
        } as never,
        config: nodeConfig,
        logger: { info: () => undefined } as never,
        actionLock: new ActionLock(),
        localApi: {
          identity: { fingerprint: 'abcdef0123456789fedcba9876543210fedcba9876543210fedcba98765432' },
          participationGate: { refresh: async () => ({ state: 'CONTRIBUTING', reason: 'ok', leaseEligible: true, requirements: { registered: true } }) },
          capabilities: {
            getWorkerHealth: () => workerHealth,
            refreshIfStale: async () => { options.onRefresh?.(); return []; },
          },
          jobs: { health: () => ({ configured: true, running: 0, queued: 0, concurrency: 1 }) },
          remoteCompute: {
            settings: () => ({ enabled: false, paused: false, maxConcurrency: 1, maxQueueDepth: 2, maxAcceptedInputBytes: 1024 ** 3, minimumFreeVramBytes: 0 }),
            updateSettings: async (patch: Record<string, unknown>) => ({ enabled: patch.enabled === true, paused: false, maxConcurrency: 1, maxQueueDepth: 2, maxAcceptedInputBytes: 1024 ** 3, minimumFreeVramBytes: 0 }),
          },
          captures: { list: () => [{ sizeBytes: 512 * 1024 ** 2 }] },
          pairing: {
            createSession: async () => ({
              version: 3,
              sessionId: 'session-1',
              secret: 'pairing-one-time-secret',
              expiresAt: new Date(Date.now() + 300000).toISOString(),
              payload: 'kubus-node://pair?v=3&e=https%3A%2F%2Fnode.example.test&s=session-1&k=pairing-one-time-secret&l=kubus_node_studio&f=abcdef012345&pk=MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY',
              node: {
                id: 'node-1',
                label: 'ROK-DESKTOP',
                endpoint: 'https://node.example.test',
                endpoints: ['https://node.example.test'],
                fingerprint: 'abcdef0123456789',
                publicKey: 'MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY',
              },
            }),
          },
        } as never,
      });
    }

    const headers = { Authorization: 'Bearer gui-secret' };

    it('serves an operator-language view model without leaking secrets', async () => {
      const server = await startNode();
      try {
        const response = await fetch(server.url.replace('/gui', '/gui/api/view'), { headers });
        const body = await response.json();
        expect(response.ok).toBe(true);

        const model = body.data;
        expect(model.node.label).toBe('ROK-DESKTOP');
        expect(model.participation.title).toBe('Contributing');
        expect(model.spatial.title).toBe('Ready');
        expect(model.archive.stored).toBe('1.0 GB');
        // Peer ID is truncated for display but copyable in full.
        expect(model.node.peerId).toContain('…');
        // Formatted identity fingerprint for on-screen comparison with the app.
        expect(model.node.fingerprint).toBe('ABCD EF01 2345 6789');

        const serialized = JSON.stringify(body);
        expect(serialized).not.toContain('kubus_node_operator_secret');
        expect(serialized).not.toContain('kubus-node-secret-key');
        expect(serialized).not.toContain('gui-secret');
      } finally {
        await server.close();
      }
    });

    it('returns a scannable pairing code and no operator credentials', async () => {
      const server = await startNode();
      try {
        const response = await fetch(server.url.replace('/gui', '/gui/api/pairing/session'), { method: 'POST', headers });
        const body = await response.json();
        expect(response.status).toBe(201);

        // The QR is rendered locally: self-contained SVG, no network reference.
        expect(body.data.qrSvg.startsWith('<svg')).toBe(true);
        expect(body.data.qrSvg).not.toContain('<image');
        // Manual copy and rendered QR use the exact same canonical payload.
        expect(body.data.code).toContain('kubus-node://pair?v=3');
        expect(body.data.code).toContain('l=kubus_node_studio');
        expect(body.data.code).not.toContain('[redacted]');
        expect(body.data.qrSvg).toContain('viewBox=');
        // The GUI formats the fingerprint for display (formatFingerprint):
        // grouped 4s, uppercase, from the first 16 hex characters.
        expect(body.data.node.fingerprint).toBe('ABCD EF01 2345 6789');
        expect(JSON.stringify(body)).not.toContain('kubus_node_operator_secret');
      } finally {
        await server.close();
      }
    });

    it('lets the operator turn GPU sharing on without touching archive participation', async () => {
      const server = await startNode();
      try {
        const response = await fetch(server.url.replace('/gui', '/gui/api/compute/settings'), {
          method: 'PUT',
          headers: { ...headers, 'Content-Type': 'application/json' },
          body: JSON.stringify({ enabled: true }),
        });
        const body = await response.json();
        expect(response.ok).toBe(true);
        expect(body.data.enabled).toBe(true);
      } finally {
        await server.close();
      }
    });

    it('refuses GUI endpoints without the token', async () => {
      const server = await startNode();
      try {
        const response = await fetch(server.url.replace('/gui', '/gui/api/view'));
        expect(response.status).toBe(401);
      } finally {
        await server.close();
      }
    });

    it('refreshes capability state before rendering the view', async () => {
      let refreshed = false;
      const server = await startNode({ onRefresh: () => { refreshed = true; } });
      try {
        await fetch(server.url.replace('/gui', '/gui/api/view'), { headers });
        expect(refreshed).toBe(true);
      } finally {
        await server.close();
      }
    });

    it('shows Ready with the GPU label for a healthy worker', async () => {
      const server = await startNode({ workerHealth: readyWorker });
      try {
        const response = await fetch(server.url.replace('/gui', '/gui/api/view'), { headers });
        const model = (await response.json()).data;
        expect(model.spatial.title).toBe('Ready');
        expect(model.spatial.gpu).toBe('RTX 3080 Ti · 12.0 GB');
      } finally {
        await server.close();
      }
    });

    it('shows Worker unavailable, never "No compatible NVIDIA GPU detected", when the worker cannot be reached', async () => {
      const server = await startNode({
        workerHealth: { status: 'unavailable', gpu: { available: false }, capabilities: [], detail: 'connect ECONNREFUSED' },
      });
      try {
        const response = await fetch(server.url.replace('/gui', '/gui/api/view'), { headers });
        const model = (await response.json()).data;
        expect(model.spatial.title).toBe('Worker unavailable');
        expect(model.spatial.body).not.toContain('No compatible NVIDIA GPU');
      } finally {
        await server.close();
      }
    });

    it('shows GPU unavailable when the worker responded but reports no CUDA device', async () => {
      const server = await startNode({
        workerHealth: { status: 'unsupported', gpu: { available: false }, capabilities: [], detail: 'A CUDA-capable NVIDIA GPU is required for local reconstruction' },
      });
      try {
        const response = await fetch(server.url.replace('/gui', '/gui/api/view'), { headers });
        const model = (await response.json()).data;
        expect(model.spatial.title).toBe('GPU unavailable');
      } finally {
        await server.close();
      }
    });

    it('shows Degraded when the worker responds with a reported problem', async () => {
      const server = await startNode({
        workerHealth: { status: 'degraded', gpu: { available: true }, capabilities: [], detail: 'CUDA error 999: unknown' },
      });
      try {
        const response = await fetch(server.url.replace('/gui', '/gui/api/view'), { headers });
        const model = (await response.json()).data;
        expect(model.spatial.title).toBe('Degraded');
      } finally {
        await server.close();
      }
    });
  });
});
