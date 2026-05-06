export const guiJs = `
const tokenKey = 'kubus_node_gui_token';
let activeSection = 'overview';
let statusCache = null;

const $ = (selector) => document.querySelector(selector);
const fmt = (value) => value === undefined || value === null || value === '' ? 'n/a' : String(value);
const short = (value) => {
  const text = fmt(value);
  return text.length > 18 ? text.slice(0, 10) + '...' + text.slice(-6) : text;
};

async function request(path, options = {}) {
  const token = localStorage.getItem(tokenKey) || '';
  const headers = { Accept: 'application/json', ...(options.headers || {}) };
  if (token) headers.Authorization = 'Bearer ' + token;
  if (options.body) headers['Content-Type'] = 'application/json';
  const response = await fetch(path, { ...options, headers });
  if (response.status === 401) {
    showAuth();
    throw new Error('GUI authorization required');
  }
  const data = await response.json().catch(() => null);
  if (!response.ok || data?.success === false) throw new Error(data?.error || 'Request failed');
  return data?.data ?? data;
}

function showAuth() {
  document.body.innerHTML = '<main class="auth card"><div><div class="brand">Kubus Node</div><p class="subtle">Enter the local GUI token configured as NODE_GUI_TOKEN.</p></div><input id="token" type="password" autocomplete="current-password" placeholder="GUI token"><button class="button primary" id="login">Open GUI</button><div class="subtle">This GUI cannot spend funds. It only controls local node operations.</div></main>';
  $('#login').addEventListener('click', () => {
    localStorage.setItem(tokenKey, $('#token').value);
    location.reload();
  });
}

function navTemplate() {
  return ['overview', 'pinning', 'rewards', 'commitments', 'logs', 'doctor'].map((name) => '<button data-section="' + name + '" class="' + (activeSection === name ? 'active' : '') + '">' + name[0].toUpperCase() + name.slice(1) + '</button>').join('');
}

function metric(label, value, detail = '') {
  return '<div class="card metric"><div class="metric-label">' + label + '</div><div class="metric-value">' + fmt(value) + '</div><div class="subtle">' + detail + '</div></div>';
}

function renderShell(data) {
  statusCache = data;
  document.body.innerHTML = '<div class="shell"><aside class="sidebar"><div class="brand">Kubus Node</div><div class="local-note">' + fmt(data.gui.displayUrl) + '<br>' + fmt(data.gui.fallbackUrl) + '<br>my.node.kubus.site is a local alias, not a public service.</div><nav class="nav">' + navTemplate() + '</nav></aside><main class="main"><div class="topbar"><div><h1>Local node health</h1><p class="subtle">Public archive pinning, rewardable commitments, and local operations.</p></div><span class="badge ' + tone(data.status) + '">' + fmt(data.status) + '</span></div><div id="section"></div></main></div>';
  document.querySelectorAll('[data-section]').forEach((button) => {
    button.addEventListener('click', () => {
      activeSection = button.dataset.section;
      renderShell(statusCache);
      renderSection();
    });
  });
}

function tone(value) {
  if (value === 'healthy' || value === true) return 'good';
  if (value === 'offline' || value === false) return 'bad';
  return 'warn';
}

function row(label, value) {
  return '<div class="split"><span class="subtle">' + label + '</span><span class="mono">' + fmt(value) + '</span></div>';
}

function renderOverview(data) {
  return '<section class="section active"><div class="grid">' +
    metric('Node status', data.status, 'latest backend heartbeat') +
    metric('Backend', data.backendReachable ? 'reachable' : 'offline', data.backendUrl) +
    metric('Kubo', data.kuboReachable ? 'reachable' : 'offline', short(data.peerId)) +
    metric('Active commitments', data.activeCommitmentCount, 'rewardable commitments') +
    '</div><div class="card"><h2>Node identity</h2>' +
    row('Label', data.nodeLabel) + row('Node ID', data.nodeId) + row('Peer ID', data.peerId) + row('Operator wallet', short(data.operatorWallet)) + row('Latest heartbeat', data.lastHeartbeat) + row('Current epoch', data.currentEpoch) +
    '</div></section>';
}

async function renderPinning() {
  const data = await request('/gui/api/pinning');
  const failed = data.failedPins.map((item) => '<div class="row"><div class="mono">' + item.cid + '</div><div class="error">' + item.error + '</div><div class="subtle">' + item.at + '</div></div>').join('') || '<div class="subtle">No failed pins.</div>';
  $('#section').innerHTML = '<section class="section active"><div class="grid">' +
    metric('Public pin-set', data.publicPinSetCount, 'canonical public CIDs') +
    metric('Tracked public CIDs', data.desiredCidCount, 'after local caps/filters') +
    metric('Pinned public CIDs', data.pinnedCidCount, 'successfully pinned') +
    metric('Rewardable CIDs', data.rewardableCidCount, 'commitment subset') +
    '</div><div class="card"><h2>Safe actions</h2><div class="actions"><button class="button primary" data-action="sync">Sync public pin set</button><button class="button" data-action="pin">Reconcile pins</button><button class="button" data-action="commitments">Refresh commitments</button><button class="button" data-action="heartbeat">Send heartbeat</button></div><p class="subtle">MAX_PINNED_CIDS=' + data.maxPinnedCids + ' · CID_CLASS_FILTERS=' + fmt(data.cidClassFilters.join(',')) + ' · latest sync=' + fmt(data.latestSyncTime) + '</p></div><div class="card"><h2>Failed pins</h2><div class="list">' + failed + '</div></div></section>';
  bindActions();
}

async function renderRewards() {
  const data = await request('/gui/api/rewards');
  $('#section').innerHTML = '<section class="section active"><div class="grid">' +
    metric('Pending KUB8 rewards', data.summary.pendingKub8, 'control-plane record') +
    metric('Settled KUB8', data.summary.settledKub8, 'not live payout settlement') +
    metric('No-reward epochs', data.summary.noRewardEpochs, 'below threshold or no checks') +
    metric('Reward rows', data.count, 'latest response') +
    '</div><div class="card"><h2>Rewards</h2><p class="subtle">Payout settlement is pending a control-plane record. This local GUI cannot spend funds.</p></div></section>';
}

async function renderCommitments() {
  const data = await request('/gui/api/commitments');
  const rows = data.commitments.map((item) => '<div class="row"><div class="split"><strong>' + fmt(item.objectType || 'object') + '</strong><span class="badge">' + fmt(item.status) + '</span></div><div class="mono">' + fmt(item.cid) + '</div><div class="subtle">Object ' + fmt(item.objectId) + ' · role ' + fmt(item.metadata?.rewardRole || item.metadata?.verificationHints?.rewardRole) + ' · expires ' + fmt(item.expiresAt) + '</div><div class="subtle">manifest ' + fmt(item.metadata?.manifestCidPinned) + ' · record ' + fmt(item.metadata?.recordCidPinned) + ' · leaf ' + fmt(item.metadata?.leafCidPinned) + '</div><a class="mono" href="' + data.gatewayBaseUrl + '/ipfs/' + item.cid + '" target="_blank" rel="noreferrer">local gateway</a></div>').join('') || '<div class="subtle">No active commitments.</div>';
  $('#section').innerHTML = '<section class="section active"><div class="card"><h2>Rewardable commitments</h2><div class="list">' + rows + '</div></div></section>';
}

async function renderLogs() {
  const data = await request('/gui/api/logs');
  const rows = data.logs.map((log) => '<div class="row log-line"><div><span class="badge">' + log.level + '</span> <span class="subtle">' + log.at + '</span></div><div>' + log.message + '</div><div class="mono">' + (log.data ? JSON.stringify(log.data) : '') + '</div></div>').join('') || '<div class="subtle">No local logs buffered yet.</div>';
  $('#section').innerHTML = '<section class="section active"><div class="card"><div class="split"><h2>Recent logs</h2><button class="button" id="clearLogs">Clear local view</button></div><div class="list">' + rows + '</div></div></section>';
  $('#clearLogs').addEventListener('click', async () => {
    await request('/gui/api/logs', { method: 'DELETE' });
    renderLogs();
  });
}

async function renderDoctor() {
  $('#section').innerHTML = '<section class="section active"><div class="card"><h2>Doctor</h2><button class="button primary" id="runDoctor">Run checks</button><div id="doctorResult" class="list"></div></div></section>';
  $('#runDoctor').addEventListener('click', async () => {
    const result = await request('/gui/api/actions/doctor', { method: 'POST' });
    $('#doctorResult').innerHTML = result.checks.map((check) => '<div class="row"><div class="split"><strong>' + check.name + '</strong><span class="badge ' + tone(check.ok) + '">' + (check.ok ? 'ok' : 'failed') + '</span></div><div class="subtle">' + fmt(check.detail) + '</div></div>').join('');
  });
}

function bindActions() {
  document.querySelectorAll('[data-action]').forEach((button) => {
    button.addEventListener('click', async () => {
      const action = button.dataset.action;
      button.disabled = true;
      button.textContent = 'Working...';
      try {
        await request('/gui/api/actions/' + action, { method: 'POST' });
        await renderPinning();
      } catch (error) {
        alert(error.message);
      }
    });
  });
}

async function renderSection() {
  if (activeSection === 'overview') $('#section').innerHTML = renderOverview(statusCache);
  if (activeSection === 'pinning') await renderPinning();
  if (activeSection === 'rewards') await renderRewards();
  if (activeSection === 'commitments') await renderCommitments();
  if (activeSection === 'logs') await renderLogs();
  if (activeSection === 'doctor') await renderDoctor();
}

async function boot() {
  try {
    const data = await request('/gui/api/status');
    renderShell(data);
    await renderSection();
  } catch (error) {
    if (!String(error.message).includes('authorization')) {
      document.body.innerHTML = '<main class="auth card"><div class="brand">Kubus Node</div><p class="error">' + error.message + '</p></main>';
    }
  }
}

boot();
`;
