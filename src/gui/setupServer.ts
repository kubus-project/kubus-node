import crypto from 'node:crypto';
import { promises as fs } from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { persistedConfigPath } from '../config/env.js';

/**
 * A deliberately small first-start server, separate from the normal GUI.
 *
 * It exists before an operator token, Kubo client, or full runtime config can
 * exist, so reusing the dashboard here would force us to invent fake service
 * health. Docker publishes this port on host loopback until setup completes;
 * the page therefore never listens on a public/LAN address while it has no
 * authentication boundary.
 */
export interface SetupServerHandle {
  url: string;
  close(): Promise<void>;
}

const MAX_BODY_BYTES = 16 * 1024;

export async function startSetupServer(env: NodeJS.ProcessEnv = process.env): Promise<SetupServerHandle> {
  const configPath = env.KUBUS_NODE_CONFIG_PATH?.trim() || persistedConfigPath(env);
  const host = env.KUBUS_SETUP_HOST?.trim() || '0.0.0.0';
  const port = parsePort(env.KUBUS_SETUP_PORT || env.NODE_GUI_PORT || '8787');
  const server = http.createServer((req, res) => {
    void handle(req, res, configPath, env).catch(() => sendJson(res, 500, { success: false, error: 'Setup could not save the configuration.' }));
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, resolve);
  });
  return {
    url: `http://127.0.0.1:${port}/setup`,
    close: () => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())),
  };
}

async function handle(req: http.IncomingMessage, res: http.ServerResponse, configPath: string, env: NodeJS.ProcessEnv): Promise<void> {
  const requestUrl = new URL(req.url || '/', 'http://127.0.0.1');
  if (req.method === 'GET' && requestUrl.pathname === '/setup') {
    sendHtml(res, setupHtml());
    return;
  }
  if (req.method === 'POST' && requestUrl.pathname === '/setup/config') {
    const input = await readJson(req);
    const config = setupConfig(input, env);
    await writeConfig(configPath, config);
    sendJson(res, 201, { success: true, restartRequired: true });
    // Compose uses `restart: unless-stopped`; closing this bootstrap process
    // is therefore the convergence point from unconfigured -> normal runtime.
    setTimeout(() => process.exit(75), 150).unref();
    return;
  }
  sendJson(res, 404, { success: false, error: 'Not found' });
}

async function readJson(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += bytes.length;
    if (size > MAX_BODY_BYTES) throw new Error('body_too_large');
    chunks.push(bytes);
  }
  const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('invalid_body');
  return parsed as Record<string, unknown>;
}

function setupConfig(input: Record<string, unknown>, env: NodeJS.ProcessEnv): Record<string, string> {
  const apiUrl = requiredUrl(input, 'apiBaseUrl');
  const operatorToken = requiredText(input, 'operatorToken', 1024);
  if (!operatorToken.startsWith('kubus_node_')) throw new Error('operator_token_invalid');
  const operatorWallet = requiredText(input, 'operatorWallet', 128);
  const nodeLabel = requiredText(input, 'nodeLabel', 80);
  const allowLan = input.allowLan === true;
  const statePath = env.LOCAL_STATE_PATH?.trim() || '/var/lib/kubus-node/state.json';
  const guiToken = crypto.randomBytes(32).toString('base64url');
  return {
    NODE_ENV: 'production',
    KUBUS_API_BASE_URL: apiUrl,
    KUBUS_OPERATOR_TOKEN: operatorToken,
    KUBUS_OPERATOR_WALLET: operatorWallet,
    KUBUS_NODE_LABEL: nodeLabel,
    KUBUS_NODE_ENDPOINT_URL: env.KUBUS_NODE_ENDPOINT_URL?.trim() || 'http://127.0.0.1:8787',
    IPFS_RPC_URL: env.IPFS_RPC_URL?.trim() || 'http://kubo:5001',
    IPFS_GATEWAY_URL: env.IPFS_GATEWAY_URL?.trim() || 'http://127.0.0.1:8080',
    LOCAL_STATE_PATH: statePath,
    LOG_LEVEL: env.LOG_LEVEL?.trim() || 'info',
    HEARTBEAT_INTERVAL_MS: env.HEARTBEAT_INTERVAL_MS?.trim() || '60000',
    CID_SYNC_INTERVAL_MS: env.CID_SYNC_INTERVAL_MS?.trim() || '300000',
    COMMITMENT_INTERVAL_MS: env.COMMITMENT_INTERVAL_MS?.trim() || '900000',
    STATUS_INTERVAL_MS: env.STATUS_INTERVAL_MS?.trim() || '120000',
    MAX_PINNED_CIDS: positiveInteger(input.archiveRecords, 100),
    MAX_PINNED_BYTES: positiveInteger(input.archiveBytes, 53_687_091_200),
    CID_CLASS_FILTERS: 'hot,warm',
    NODE_GUI_ENABLED: 'true',
    NODE_GUI_HOST: env.NODE_GUI_HOST?.trim() || '0.0.0.0',
    NODE_GUI_PORT: env.NODE_GUI_PORT?.trim() || '8787',
    NODE_GUI_TOKEN: guiToken,
    NODE_GUI_ALLOW_REMOTE: 'false',
    NODE_GUI_DISPLAY_URL: env.NODE_GUI_DISPLAY_URL?.trim() || 'http://127.0.0.1:8787/gui',
    LOCAL_API_ENABLED: 'true',
    LOCAL_API_HOST: env.LOCAL_API_HOST?.trim() || '0.0.0.0',
    LOCAL_API_PORT: env.LOCAL_API_PORT?.trim() || '8787',
    LOCAL_API_ALLOW_LAN: String(allowLan),
    LOCAL_DATA_PATH: env.LOCAL_DATA_PATH?.trim() || path.join(path.dirname(statePath), 'data'),
    OFFER_REMOTE_COMPUTE: String(input.offerRemoteCompute === true),
    REMOTE_COMPUTE_PAUSED: 'false',
  };
}

async function writeConfig(filePath: string, values: Record<string, string>): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const content = Object.entries(values).map(([key, value]) => `${key}=${escapeEnv(value)}`).join('\n') + '\n';
  const temporary = path.join(path.dirname(filePath), `.config.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`);
  await fs.writeFile(temporary, content, { mode: 0o600 });
  await fs.rename(temporary, filePath);
  if (process.platform !== 'win32') await fs.chmod(filePath, 0o600);
}

function escapeEnv(value: string): string {
  if (/[\r\n]/.test(value)) throw new Error('multiline_value');
  return JSON.stringify(value);
}

function requiredText(input: Record<string, unknown>, key: string, maxLength: number): string {
  const value = typeof input[key] === 'string' ? input[key].trim() : '';
  if (!value || value.length > maxLength || /[\r\n]/.test(value)) throw new Error(`invalid_${key}`);
  return value;
}

function requiredUrl(input: Record<string, unknown>, key: string): string {
  return parseUrl(requiredText(input, key, 512));
}

function optionalUrl(input: Record<string, unknown>, key: string): string | undefined {
  const value = typeof input[key] === 'string' ? input[key].trim() : '';
  return value ? parseUrl(value) : undefined;
}

function parseUrl(value: string): string {
  const parsed = new URL(value);
  if (!['http:', 'https:'].includes(parsed.protocol) || !parsed.hostname) throw new Error('invalid_url');
  return parsed.toString().replace(/\/$/, '');
}

function positiveInteger(value: unknown, fallback: number): string {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? String(parsed) : String(fallback);
}

function parsePort(value: string): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535) throw new Error('invalid_setup_port');
  return parsed;
}

function sendHtml(res: http.ServerResponse, body: string): void {
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
  res.end(body);
}

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
  res.end(JSON.stringify(body));
}

function setupHtml(): string {
  return `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Set up kubus Node</title>
<style>body{max-width:42rem;margin:3rem auto;padding:0 1rem;font:16px system-ui}label{display:block;margin:1rem 0}input{box-sizing:border-box;width:100%;padding:.6rem}button{padding:.7rem 1rem}small{color:#555}</style>
<h1>Set up kubus Node</h1><p>Your captures stay on your Node. The network receives archive participation and short-lived connection coordination, never capture bytes.</p>
<form id="f"><label>Node name<input name="nodeLabel" required maxlength="80"></label><label>art.kubus API URL<input name="apiBaseUrl" type="url" required placeholder="https://api.kubus.site"></label><label>Operator wallet<input name="operatorWallet" required></label><label>Scoped Node token<input name="operatorToken" type="password" required autocomplete="off"></label><label>Archive capacity (bytes)<input name="archiveBytes" type="number" min="1" value="53687091200"></label><label>Archive record limit<input name="archiveRecords" type="number" min="1" value="100"></label><label><input name="allowLan" type="checkbox"> Allow connections from devices on this network</label><small>When enabled, setup detects this PC's private LAN address and uses it in pairing. You never need to type an IP address.</small><label><input name="offerRemoteCompute" type="checkbox"> Offer compatible NVIDIA GPU capacity to the network</label><button>Save and start Node</button></form><p id="m" role="status"></p>
<script>f.onsubmit=async e=>{e.preventDefault();m.textContent='Saving…';let d=Object.fromEntries(new FormData(f));d.allowLan=f.allowLan.checked;d.offerRemoteCompute=f.offerRemoteCompute.checked;let r=await fetch('/setup/config',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(d)});m.textContent=r.ok?'Saved. Node is restarting…':'Could not save setup. Check every field and try again.'}</script>`;
}
