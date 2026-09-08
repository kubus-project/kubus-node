import crypto from 'node:crypto';
import { promises as fs } from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { persistedConfigPath } from '../config/env.js';
import { loadOrCreateNodeIdentity } from '../identity/nodeIdentity.js';
import {
  InstallationError, claimInstallation, confirmInstallation, pollInstallation, startInstallation,
  type StartedInstallation,
} from '../setup/installationClient.js';

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
  const security: SetupSecurity = {
    nonce: crypto.randomBytes(32).toString('base64url'), port, saving: false, completed: false, starting: false,
  };
  const server = http.createServer((req, res) => {
    void handle(req, res, configPath, env, security).catch((error: unknown) => {
      sendJson(res, error instanceof SetupRequestError ? error.status : 500, { success: false, error: 'Setup could not save the configuration.' });
    });
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

class SetupRequestError extends Error {
  constructor(readonly status: number) { super('Invalid setup request'); }
}

interface SetupSecurity {
  nonce: string;
  port: number;
  saving: boolean;
  completed: boolean;
  /** Guards concurrent installation starts, so one page cannot open many grants. */
  starting: boolean;
  apiBaseUrl?: string;
  installation?: StartedInstallation;
  /**
   * The account-authorized credential, held in memory between the claim and the
   * config write. It is never echoed back to the page.
   */
  credential?: { token: string; wallet: string };
}

/** The directory the durable Ed25519 identity lives in, before any config exists. */
function stateDir(env: NodeJS.ProcessEnv): string {
  return path.dirname(env.LOCAL_STATE_PATH?.trim() || '/var/lib/kubus-node/state.json');
}

async function handle(req: http.IncomingMessage, res: http.ServerResponse, configPath: string, env: NodeJS.ProcessEnv, security: SetupSecurity): Promise<void> {
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Content-Security-Policy', "frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
  const allowedHosts = [`127.0.0.1:${security.port}`, `localhost:${security.port}`, `[::1]:${security.port}`];
  if (!req.headers.host || !allowedHosts.includes(req.headers.host)) throw new SetupRequestError(403);
  if (req.headers['sec-fetch-site'] === 'cross-site') throw new SetupRequestError(403);
  const requestUrl = new URL(req.url || '/', 'http://127.0.0.1');
  if (requestUrl.search) throw new SetupRequestError(400);
  if (req.method === 'GET' && requestUrl.pathname === '/setup') {
    sendHtml(res, setupHtml(security.nonce));
    return;
  }
  // Every mutating setup route carries the identical guard. Account
  // authorization is an additional route, never a way around these checks.
  const assertMutation = (): void => {
    if (req.headers.origin !== `http://${req.headers.host}`) throw new SetupRequestError(403);
    if (req.headers['content-type']?.split(';')[0]?.trim().toLowerCase() !== 'application/json') throw new SetupRequestError(415);
    const nonce = req.headers['x-kubus-setup-nonce'];
    if (typeof nonce !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(nonce)
        || !crypto.timingSafeEqual(Buffer.from(nonce), Buffer.from(security.nonce))) throw new SetupRequestError(403);
    if (security.completed) throw new SetupRequestError(409);
  };

  // Starts the account-authorized installation. The response carries only a
  // short code the person reads; the claim verifier stays in this process.
  if (req.method === 'POST' && requestUrl.pathname === '/setup/account/start') {
    assertMutation();
    if (security.starting) throw new SetupRequestError(409);
    security.starting = true;
    try {
      const input = await readJson(req);
      const apiBaseUrl = requiredUrl(input, 'apiBaseUrl');
      const label = typeof input.nodeLabel === 'string' ? input.nodeLabel.trim().slice(0, 80) : null;
      const identity = await loadOrCreateNodeIdentity(stateDir(env));
      const started = await startInstallation({ apiBaseUrl, identity, label, kind: 'NODE_SETUP' });
      security.apiBaseUrl = apiBaseUrl;
      security.installation = started;
      sendJson(res, 201, {
        success: true,
        userCode: started.userCode,
        expiresAt: started.expiresAt,
        fingerprint: identity.fingerprint,
      });
    } catch (error) {
      security.installation = undefined;
      throw error instanceof SetupRequestError ? error : new SetupRequestError(502);
    } finally { security.starting = false; }
    return;
  }

  // Polled by the setup page while the person authorizes in art.kubus. The
  // credential lands in memory here and is written to disk by /setup/config.
  if (req.method === 'POST' && requestUrl.pathname === '/setup/account/poll') {
    assertMutation();
    // Read (and therefore bound) the body before any state check, so every
    // mutating route enforces the same 16 KiB limit in the same order.
    await readJson(req);
    const started = security.installation;
    const apiBaseUrl = security.apiBaseUrl;
    if (!started || !apiBaseUrl) throw new SetupRequestError(409);
    if (security.credential) { sendJson(res, 200, { success: true, state: 'AUTHORIZED', ready: true }); return; }
    let state: string;
    try {
      state = await pollInstallation({ apiBaseUrl, started });
      if (state === 'AUTHORIZED') {
        const identity = await loadOrCreateNodeIdentity(stateDir(env));
        const claimed = await claimInstallation({ apiBaseUrl, identity, started });
        security.credential = { token: claimed.token, wallet: claimed.wallet };
      }
    } catch (error) {
      const code = error instanceof InstallationError ? error.code : 'NODE_INSTALLATION_FAILED';
      sendJson(res, 200, { success: true, state: 'ERROR', ready: false, errorCode: code });
      return;
    }
    sendJson(res, 200, { success: true, state, ready: Boolean(security.credential) });
    return;
  }

  if (req.method === 'POST' && requestUrl.pathname === '/setup/config') {
    assertMutation();
    if (security.saving) throw new SetupRequestError(409);
    security.saving = true;
    try {
      const input = await readJson(req);
      let config: Record<string, string>;
      try { config = setupConfig(input, env, security.credential); } catch { throw new SetupRequestError(400); }
      await writeConfig(configPath, config);
      // Only once the credential is durably on disk is the installation
      // confirmed. A failure before this point leaves the grant unconsumed
      // rather than burning it on a Node that never stored anything.
      if (security.credential && security.installation && security.apiBaseUrl) {
        try {
          await confirmInstallation({
            apiBaseUrl: security.apiBaseUrl,
            identity: await loadOrCreateNodeIdentity(stateDir(env)),
            started: security.installation,
          });
        } catch { /* The credential is already usable; confirmation retries on next start. */ }
      }
      security.credential = undefined;
      security.completed = true;
      sendJson(res, 201, { success: true, restartRequired: true });
      // Compose uses `restart: unless-stopped`; closing this bootstrap process
      // is therefore the convergence point from unconfigured -> normal runtime.
      setTimeout(() => process.exit(75), 150).unref();
    } finally { security.saving = false; }
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
    if (size > MAX_BODY_BYTES) throw new SetupRequestError(413);
    chunks.push(bytes);
  }
  let parsed: unknown;
  try { parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new SetupRequestError(400); }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new SetupRequestError(400);
  return parsed as Record<string, unknown>;
}

/**
 * Builds the runtime config.
 *
 * The ordinary path takes its credential from [accountCredential], produced by
 * the account-authorized installation, so nobody is asked to paste a scoped
 * operator token. Manual token entry survives only as an explicit Advanced
 * choice for development and operator recovery; it is never the fallback when
 * account authorization simply has not happened yet, because silently
 * accepting a pasted token there would put the raw-token path back in front of
 * ordinary users.
 */
function setupConfig(
  input: Record<string, unknown>,
  env: NodeJS.ProcessEnv,
  accountCredential?: { token: string; wallet: string },
): Record<string, string> {
  const apiUrl = requiredUrl(input, 'apiBaseUrl');
  const advanced = input.advanced === true;
  let operatorToken: string;
  let operatorWallet: string;
  if (advanced) {
    operatorToken = requiredText(input, 'operatorToken', 1024);
    operatorWallet = requiredText(input, 'operatorWallet', 128);
  } else {
    if (!accountCredential) throw new Error('account_authorization_required');
    operatorToken = accountCredential.token;
    operatorWallet = accountCredential.wallet;
  }
  if (!operatorToken.startsWith('kubus_node_')) throw new Error('operator_token_invalid');
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

function setupHtml(nonce: string): string {
  return `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Set up kubus Node</title>
<style>body{max-width:42rem;margin:3rem auto;padding:0 1rem;font:16px system-ui;line-height:1.5}label{display:block;margin:1rem 0}input{box-sizing:border-box;width:100%;padding:.6rem}button{padding:.7rem 1rem}small{color:#555}code{font:600 1.6rem/1.2 ui-monospace,monospace;letter-spacing:.16em}details{margin:1.5rem 0;border-top:1px solid #ddd;padding-top:1rem}#step2{display:none}</style>
<h1>Set up kubus Node</h1><p>Your captures stay on your Node. The network receives archive participation and short-lived connection coordination, never capture bytes.</p>
<form id="f">
<label>Node name<input name="nodeLabel" required maxlength="80"></label>
<label>art.kubus API URL<input name="apiBaseUrl" type="url" required value="https://api.kubus.site"></label>
<label>Archive capacity (bytes)<input name="archiveBytes" type="number" min="1" value="53687091200"></label>
<label>Archive record limit<input name="archiveRecords" type="number" min="1" value="100"></label>
<label><input name="allowLan" type="checkbox"> Allow connections from devices on this network</label>
<small>When enabled, setup detects this PC's private LAN address and uses it in pairing. You never need to type an IP address.</small>
<label><input name="offerRemoteCompute" type="checkbox"> Offer compatible NVIDIA GPU capacity to the network</label>
<details><summary>Advanced setup</summary><p><small>For development and operator recovery only. An ordinary setup never needs these: signing in to art.kubus authorizes this Node for you.</small></p>
<label><input id="adv" name="advanced" type="checkbox"> Configure a scoped Node token manually</label>
<label>Operator wallet<input name="operatorWallet" autocomplete="off"></label>
<label>Scoped Node token<input name="operatorToken" type="password" autocomplete="off"></label></details>
<button id="go">Continue</button></form>
<section id="step2"><h2>Authorize this Node</h2>
<p>Open art.kubus, sign in, and choose <strong>Add a Node</strong>. Enter this code:</p>
<p><code id="code"></code></p>
<p><small>Node fingerprint: <span id="fp"></span></small></p></section>
<p id="m" role="status"></p>
<script>
const body=()=>{let d=Object.fromEntries(new FormData(f));d.allowLan=f.allowLan.checked;d.offerRemoteCompute=f.offerRemoteCompute.checked;d.advanced=adv.checked;return d};
const send=(p,d)=>fetch(p,{method:'POST',headers:{'content-type':'application/json','x-kubus-setup-nonce':'${nonce}'},body:JSON.stringify(d)});
const save=async()=>{let r=await send('/setup/config',body());m.textContent=r.ok?'Saved. Node is restarting…':'Could not save setup. Check every field and try again.'};
f.onsubmit=async e=>{e.preventDefault();
  if(adv.checked){m.textContent='Saving…';return save()}
  m.textContent='Starting authorization…';
  let r=await send('/setup/account/start',body());
  if(!r.ok){m.textContent='Could not reach art.kubus. Check the API URL and try again.';return}
  let s=await r.json();code.textContent=s.userCode;fp.textContent=s.fingerprint.slice(0,16);
  step2.style.display='block';go.disabled=true;m.textContent='Waiting for you to authorize this Node in art.kubus…';
  const tick=async()=>{let p=await send('/setup/account/poll',{});let v=await p.json();
    if(v.ready){m.textContent='Authorized. Saving…';return save()}
    if(v.state==='DECLINED'){m.textContent='Authorization was declined in art.kubus.';go.disabled=false;return}
    if(v.state==='EXPIRED'){m.textContent='That code expired. Choose Continue to get a new one.';go.disabled=false;step2.style.display='none';return}
    setTimeout(tick,3000)};
  setTimeout(tick,3000)};
</script>`;
}
