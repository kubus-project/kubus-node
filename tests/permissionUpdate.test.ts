import { afterEach, describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import crypto from 'node:crypto';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import stableStringify from 'json-stable-stringify';
import { PermissionUpdateService, replaceOperatorCredential } from '../src/setup/permissionUpdate.js';
import { loadOrCreateNodeIdentity } from '../src/identity/nodeIdentity.js';

let backend: http.Server | undefined;
const dirs: string[] = [];

afterEach(async () => {
  if (backend) await new Promise<void>((resolve) => backend!.close(() => resolve()));
  backend = undefined;
  await Promise.all(dirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

async function tempDir() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'kubus-permission-'));
  dirs.push(dir);
  return dir;
}

const NODE_ID = '11111111-2222-4333-8444-555555555555';
const CURRENT_TOKEN = `kubus_node_${'0'.repeat(16)}_${'1'.repeat(64)}`;
const EXISTING_CONFIG = [
  'NODE_ENV="production"',
  'KUBUS_API_BASE_URL="https://api.kubus.site"',
  'KUBUS_OPERATOR_TOKEN="kubus_node_old_credential"',
  'KUBUS_OPERATOR_WALLET="OldWallet"',
  'KUBUS_NODE_LABEL="Studio"',
  'MAX_PINNED_BYTES="53687091200"',
].join('\n') + '\n';

interface Fake {
  origin: string;
  state: { value: string };
  seen: { claimed: number; confirmed: number; kind?: string; nodeId?: string | null; previousTokenPrefix?: string | null };
  token: string;
  failClaim?: boolean;
}

async function startFakeBackend(): Promise<Fake> {
  const listener = net.createServer();
  await new Promise<void>((resolve) => listener.listen(0, '127.0.0.1', resolve));
  const port = (listener.address() as net.AddressInfo).port;
  await new Promise<void>((resolve) => listener.close(() => resolve()));

  const fake: Fake = {
    origin: `http://127.0.0.1:${port}`,
    state: { value: 'PENDING' },
    seen: { claimed: 0, confirmed: 0 },
    token: `kubus_node_${'c'.repeat(16)}_${'d'.repeat(64)}`,
  };
  let record: { id: string; userCode: string; publicKey: string; claimVerifierHash: string; kind: string; nodeId: string | null };

  const verify = (action: string, publicKey: string, signature: string, fields: Record<string, unknown>): boolean => {
    const message = Buffer.from(`kubus.node-installation/1\n${stableStringify({ action, ...fields })}`);
    const key = crypto.createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: publicKey }, format: 'jwk' });
    return crypto.verify(null, message, key, Buffer.from(signature, 'base64url'));
  };

  backend = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk) => chunks.push(chunk as Buffer));
    req.on('end', () => {
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
      const reply = (status: number, data: unknown) => {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ success: status < 400, data, errorCode: status >= 400 ? 'REJECTED' : undefined }));
      };
      const url = req.url || '';
      if (url === '/api/availability/node-installations') {
        fake.seen.kind = body.kind;
        fake.seen.nodeId = body.nodeId;
        fake.seen.previousTokenPrefix = body.previousTokenPrefix;
        if (!verify('create', body.publicKey, body.signature, {
          id: null, userCode: null, publicKey: body.publicKey,
          claimVerifierHash: body.claimVerifierHash, kind: body.kind, nodeId: body.nodeId ?? null,
        })) return reply(403, null);
        record = {
          id: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee', userCode: 'JKMN2345',
          publicKey: body.publicKey, claimVerifierHash: body.claimVerifierHash,
          kind: body.kind, nodeId: body.nodeId ?? null,
        };
        return reply(201, { installationId: record.id, userCode: record.userCode, expiresAt: new Date(Date.now() + 900000).toISOString() });
      }
      if (url.endsWith('/status')) return reply(200, { state: fake.state.value });
      if (url.endsWith('/claim')) {
        if (fake.failClaim) return reply(500, null);
        if (!verify('claim', record.publicKey, body.signature, {
          id: record.id, userCode: record.userCode, publicKey: record.publicKey,
          claimVerifierHash: record.claimVerifierHash, kind: record.kind, nodeId: record.nodeId,
        })) return reply(403, null);
        fake.seen.claimed += 1;
        return reply(200, {
          installationId: record.id, kind: record.kind, token: fake.token,
          wallet: 'NewWallet', nodeId: record.nodeId, scopes: [], replacesTokenId: 'old-token-id',
        });
      }
      if (url.endsWith('/confirm')) {
        if (!verify('confirm', record.publicKey, body.signature, {
          id: record.id, userCode: record.userCode, publicKey: record.publicKey,
          claimVerifierHash: record.claimVerifierHash, kind: record.kind, nodeId: record.nodeId,
        })) return reply(403, null);
        fake.seen.confirmed += 1;
        return reply(200, { state: 'CONFIRMED' });
      }
      return reply(404, null);
    });
  });
  await new Promise<void>((resolve) => backend!.listen(port, '127.0.0.1', resolve));
  return fake;
}

async function newService(fake: Fake, overrides: { nodeId?: () => string | undefined; currentToken?: () => string | undefined } = {}) {
  const dir = await tempDir();
  const configPath = path.join(dir, 'config.env');
  await fs.writeFile(configPath, EXISTING_CONFIG);
  const identity = await loadOrCreateNodeIdentity(dir);
  const service = new PermissionUpdateService({
    apiBaseUrl: fake.origin,
    configPath,
    identity,
    nodeId: overrides.nodeId ?? (() => NODE_ID),
    currentToken: overrides.currentToken ?? (() => CURRENT_TOKEN),
  });
  return { service, configPath, identity };
}

describe('explicit compute permission update', () => {
  it('UPDATE: rotates the credential in place and keeps every other setting', async () => {
    const fake = await startFakeBackend();
    const { service, configPath, identity } = await newService(fake);

    const begun = await service.begin();
    expect(begun.phase).toBe('WAITING_FOR_AUTHORIZATION');
    expect(begun.userCode).toBe('JKMN2345');
    // Rotation targets the existing Node, never a re-enrolment.
    expect(fake.seen.kind).toBe('PERMISSION_UPDATE');
    expect(fake.seen.nodeId).toBe(NODE_ID);
    // Names the credential being replaced, without its secret half.
    expect(fake.seen.previousTokenPrefix).toBe(`kubus_node_${'0'.repeat(16)}`);
    expect(JSON.stringify(fake.seen)).not.toContain('1'.repeat(64));

    expect((await service.refresh()).phase).toBe('WAITING_FOR_AUTHORIZATION');
    fake.state.value = 'AUTHORIZED';
    const done = await service.refresh();

    expect(done.phase).toBe('COMPLETED');
    expect(done.restartRequired).toBe(true);
    expect(fake.seen.claimed).toBe(1);
    expect(fake.seen.confirmed).toBe(1);

    const config = await fs.readFile(configPath, 'utf8');
    expect(config).toContain(`KUBUS_OPERATOR_TOKEN=${JSON.stringify(fake.token)}`);
    expect(config).toContain('KUBUS_OPERATOR_WALLET="NewWallet"');
    expect(config).not.toContain('kubus_node_old_credential');
    // Unrelated configuration survives the rotation untouched.
    expect(config).toContain('KUBUS_NODE_LABEL="Studio"');
    expect(config).toContain('MAX_PINNED_BYTES="53687091200"');
    expect(config).toContain('KUBUS_API_BASE_URL="https://api.kubus.site"');

    // The Ed25519 identity is the same one it was before.
    const after = await loadOrCreateNodeIdentity(path.dirname(configPath));
    expect(after.fingerprint).toBe(identity.fingerprint);
  });

  it('CANCEL: declining leaves the old credential in place', async () => {
    const fake = await startFakeBackend();
    const { service, configPath } = await newService(fake);
    await service.begin();
    fake.state.value = 'DECLINED';

    const status = await service.refresh();
    expect(status.phase).toBe('DECLINED');
    expect(status.restartRequired).toBe(false);
    expect(fake.seen.claimed).toBe(0);
    expect(await fs.readFile(configPath, 'utf8')).toBe(EXISTING_CONFIG);
  });

  it('FAILURE DURING ROTATION: a failed claim never half-writes the credential', async () => {
    const fake = await startFakeBackend();
    fake.failClaim = true;
    const { service, configPath } = await newService(fake);
    await service.begin();
    fake.state.value = 'AUTHORIZED';

    const status = await service.refresh();
    expect(status.phase).toBe('FAILED');
    expect(status.restartRequired).toBe(false);
    expect(fake.seen.confirmed).toBe(0);
    // Untouched, so the Node keeps working on the credential it already had.
    expect(await fs.readFile(configPath, 'utf8')).toBe(EXISTING_CONFIG);
  });

  it('REPLAY: refreshing after completion does not collect a second credential', async () => {
    const fake = await startFakeBackend();
    const { service } = await newService(fake);
    await service.begin();
    fake.state.value = 'AUTHORIZED';
    await service.refresh();

    await service.refresh();
    await service.refresh();
    expect(fake.seen.claimed).toBe(1);
  });

  it('repeated begins while one update is outstanding reuse the same grant', async () => {
    const fake = await startFakeBackend();
    const { service } = await newService(fake);
    const first = await service.begin();
    const second = await service.begin();
    expect(second.installationId).toBe(first.installationId);
  });

  it('an unregistered Node cannot start a permission update', async () => {
    const fake = await startFakeBackend();
    const { service } = await newService(fake, { nodeId: () => undefined });
    await expect(service.begin()).rejects.toMatchObject({ code: 'NODE_NOT_REGISTERED' });
  });

  it('sends no prefix when the current credential is not a usable token', async () => {
    const fake = await startFakeBackend();
    const { service } = await newService(fake, { currentToken: () => undefined });
    await service.begin();
    expect(fake.seen.previousTokenPrefix).toBeNull();
  });

  it('replaceOperatorCredential refuses values that would corrupt the config file', async () => {
    const dir = await tempDir();
    const configPath = path.join(dir, 'config.env');
    await fs.writeFile(configPath, EXISTING_CONFIG);
    await expect(replaceOperatorCredential(configPath, { token: 'a\nB=c', wallet: 'w' }))
      .rejects.toThrow('credential_unrepresentable');
    expect(await fs.readFile(configPath, 'utf8')).toBe(EXISTING_CONFIG);
  });
});
