/**
 * Boots the GUI against fixtures so its states can be looked at without a real
 * node, a GPU or a network.
 *
 *   npx tsx scripts/previewGui.ts [healthy|locked|unconfigured]
 *
 * Development tooling: it never touches the node's real state file.
 */
import crypto from 'node:crypto';
import { startGuiServer } from '../src/gui/guiServer.js';
import { serializePairingPayload } from '../src/localApi/pairingService.js';
import { nodeFingerprintFromPublicKey } from '../src/identity/nodeIdentity.js';

const scenario = process.argv[2] || 'healthy';
const previewSecret = Buffer.from(Array.from({ length: 32 }, (_, index) => index + 1)).toString('base64url');
const previewKeyPair = crypto.generateKeyPairSync('ed25519');
const previewPublicKeyRaw = Buffer.from((previewKeyPair.publicKey.export({ format: 'jwk' }) as { x: string }).x, 'base64url');
const previewPublicKey = previewPublicKeyRaw.toString('base64url');
const previewFingerprint = nodeFingerprintFromPublicKey(previewPublicKeyRaw);
const previewPairingPayload = serializePairingPayload({
  endpoint: 'http://192.168.1.24:8787',
  alternateEndpoints: ['https://node.example.test'],
  sessionId: 'session-1',
  secret: previewSecret,
  nodeId: 'node-1',
  label: 'ROK-DESKTOP',
  fingerprint: previewFingerprint,
  publicKey: previewPublicKey,
});

const config = {
  guiHost: '127.0.0.1',
  guiAllowRemote: false,
  guiEnabled: true,
  guiPort: 8791,
  guiToken: undefined,
  apiBaseUrl: 'https://api.art.kubus',
  operatorToken: 'kubus_node_operator_secret',
  nodeLabel: 'ROK-DESKTOP',
  ipfsGatewayUrl: 'http://127.0.0.1:8080',
  maxPinnedCids: 5000,
  maxPinnedBytes: 50 * 1024 ** 3,
  cidClassFilters: [],
  localApiEnabled: true,
  localApiAllowLan: false,
  localApiPort: 8787,
  pairingSessionTtlMs: 300000,
} as never;

const participationByScenario: Record<string, unknown> = {
  healthy: { state: 'CONTRIBUTING', reason: 'ok', leaseEligible: true, requirements: { registered: true, kuboHealthy: true } },
  locked: { state: 'LOCKED', reason: 'runtime gate violation', leaseEligible: false, requirements: { registered: true, kuboHealthy: false, publicPinningEnabled: false } },
  unconfigured: { state: 'UNCONFIGURED', reason: 'no operator', leaseEligible: false, requirements: {} },
};

const workerByScenario: Record<string, unknown> = {
  healthy: { status: 'ready', gpu: { available: true, model: 'RTX 3080 Ti', totalVramBytes: 12 * 1024 ** 3 }, capabilities: ['spatial.reconstruct', 'spatial.optimize'] },
  locked: { status: 'unavailable', gpu: { available: true, model: 'RTX 3080 Ti', totalVramBytes: 12 * 1024 ** 3 }, capabilities: [], detail: 'worker did not respond on 127.0.0.1:8799' },
  unconfigured: { status: 'unsupported', gpu: { available: false }, capabilities: [] },
};

const snapshot = {
  version: 1,
  nodeKey: 'kubus-node-secret-key',
  nodeId: 'node-1',
  peerId: '12D3KooWExamplePeerIdentifierValueLongEnoughToTruncate',
  publicPinSet: [],
  rewardableCids: [],
  desiredCids: Array.from({ length: 847 }, (_, i) => ({
    cid: 'bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtq' + String(i).padStart(4, '0'),
    sizeBytes: 15 * 1024 ** 2,
    role: i % 7 === 0 ? 'manifest' : i % 3 === 0 ? 'record' : 'media',
    isRewardable: i % 11 === 0,
  })),
  pinnedCids: [] as string[],
  failedCids: scenario === 'healthy' ? {} : {
    bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtq0003: { error: 'context deadline exceeded while fetching block', at: new Date(Date.now() - 3600_000).toISOString() },
    bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtq0044: { error: 'no providers found', at: new Date(Date.now() - 7200_000).toISOString() },
  },
  activeCommitments: [],
  latestPublicPinSetSyncAt: new Date(Date.now() - 240_000).toISOString(),
  latestPinReconcileAt: new Date(Date.now() - 600_000).toISOString(),
  latestHeartbeatAt: new Date(Date.now() - 90_000).toISOString(),
  latestHeartbeat: { agentVersion: '0.8.0-alpha.4' },
  rewards: scenario === 'healthy' ? { summary: { pendingKub8: 8.42, settledKub8: 0, noRewardEpochs: 1 } } : undefined,
  computeRewards: scenario === 'healthy' ? { pendingKub8: 5.7, settledKub8: 0, verifiedComputeUnits: 214 } : undefined,
  remoteJobs: {
    a: { role: 'provider', state: 'COMPLETED' },
    b: { role: 'provider', state: 'RUNNING' },
    c: { role: 'provider', state: 'MATCHED' },
  },
  localCredentials: scenario === 'unconfigured' ? {} : {
    one: { tokenHash: 'x', label: 'Rok iPhone 15', scopes: ['captures:read'], createdAt: new Date(Date.now() - 86400_000 * 3).toISOString(), lastUsedAt: new Date(Date.now() - 1800_000).toISOString() },
    two: { tokenHash: 'y', label: 'Studio iPad', scopes: ['captures:read'], createdAt: new Date(Date.now() - 86400_000 * 20).toISOString(), lastUsedAt: new Date(Date.now() - 86400_000).toISOString() },
  },
};
snapshot.pinnedCids = snapshot.desiredCids.slice(0, scenario === 'healthy' ? 835 : 700).map((r) => r.cid);

const server = await startGuiServer({
  api: { getHealth: async () => ({ ok: true }) } as never,
  kubo: {
    id: async () => ({ ID: 'peer' }),
    version: async () => ({ Version: '0.41.0' }),
    repoStat: async () => ({ RepoSize: 14 * 1024 ** 3, StorageMax: 100 * 1024 ** 3 }),
  } as never,
  store: { snapshot: () => snapshot, update: async (m: (s: unknown) => void) => { m(snapshot); } } as never,
  config,
  logger: { info: () => undefined } as never,
  actionLock: { snapshot: () => ({}), run: async (_n: string, f: () => unknown) => f() } as never,
  localApi: {
    identity: { fingerprint: previewFingerprint },
    participationGate: { refresh: async () => participationByScenario[scenario] },
    capabilities: { getWorkerHealth: () => workerByScenario[scenario], refreshIfStale: async () => [] },
    jobs: { health: () => ({ configured: true, running: scenario === 'healthy' ? 1 : 0, queued: 0, concurrency: 2 }) },
    remoteCompute: {
      settings: () => ({ enabled: scenario === 'healthy', paused: false, maxConcurrency: 2, maxQueueDepth: 4, maxAcceptedInputBytes: 2 * 1024 ** 3, minimumFreeVramBytes: 2 * 1024 ** 3 }),
      updateSettings: async (p: Record<string, unknown>) => ({ enabled: p.enabled === true, paused: p.paused === true, maxConcurrency: 2, maxQueueDepth: 4, maxAcceptedInputBytes: 2 * 1024 ** 3, minimumFreeVramBytes: 2 * 1024 ** 3 }),
    },
    captures: { list: () => Array.from({ length: scenario === 'healthy' ? 6 : 0 }, () => ({ sizeBytes: 800 * 1024 ** 2 })) },
    pairing: {
      createSession: async () => ({
        version: 3,
        sessionId: 'session-1',
        secret: previewSecret,
        expiresAt: new Date(Date.now() + 292_000).toISOString(),
        payload: previewPairingPayload,
        node: {
          id: 'node-1',
          label: 'ROK-DESKTOP',
          endpoint: 'http://192.168.1.24:8787',
          endpoints: ['http://192.168.1.24:8787', 'https://node.example.test'],
          fingerprint: previewFingerprint,
          publicKey: previewPublicKey,
        },
      }),
      revoke: async () => undefined,
    },
  } as never,
});

console.log('READY ' + server.url);
