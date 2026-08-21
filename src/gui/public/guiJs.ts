/**
 * kubus Node GUI client.
 *
 * This file is a renderer and nothing more. It never decides what a state
 * "means" — the server sends a view model in operator language (see
 * `src/gui/viewModel.ts`) and this code lays it out. Adding a state or changing
 * wording is a change to the view model, not to the markup here.
 *
 * Two rules hold throughout:
 *   - every interpolated value goes through `h()`; markup is only ever built
 *     from literals in this file;
 *   - a refresh never blanks the screen. The last known model stays rendered
 *     while the next one is in flight, so the node does not appear to flicker
 *     offline on every poll.
 *
 * Written with string concatenation rather than template literals because the
 * whole file is itself a template literal exported to the GUI server.
 */
export const guiJs = `
const TOKEN_KEY = 'kubus_node_gui_token';
const SECTIONS = [
  { id: 'overview', label: 'Overview' },
  { id: 'archive', label: 'Archive' },
  { id: 'spatial', label: 'Spatial' },
  { id: 'compute', label: 'Compute' },
  { id: 'contribution', label: 'Contribution' },
  { id: 'devices', label: 'Devices' },
  { id: 'diagnostics', label: 'Diagnostics' },
  { id: 'settings', label: 'Settings' },
];

let model = null;
let activeSection = location.hash.replace('#', '') || 'overview';
let refreshing = false;
let pairing = null;
let pairingTimer = null;
let onboardingStep = 0;
let onboardingDismissed = false;
let logState = { level: '', query: '', follow: true, lines: [] };
let diagnostics = null;

if (!SECTIONS.some((section) => section.id === activeSection)) activeSection = 'overview';

/* --- utilities ---------------------------------------------------------- */

const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => Array.prototype.slice.call(document.querySelectorAll(selector));

/** Escapes text for HTML. Every dynamic value in this file passes through it. */
function h(value) {
  if (value === null || value === undefined) return '';
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function announce(message) {
  const live = $('#live');
  if (live) live.textContent = message;
}

async function copyText(value) {
  try {
    if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
      await navigator.clipboard.writeText(value);
      return true;
    }
  } catch (_error) {
    // Fall through to the selection-based path used by non-secure local HTTP.
  }
  const field = document.createElement('textarea');
  field.value = value;
  field.setAttribute('readonly', '');
  field.style.position = 'fixed';
  field.style.opacity = '0';
  document.body.appendChild(field);
  field.select();
  field.setSelectionRange(0, field.value.length);
  let copied = false;
  try { copied = document.execCommand('copy'); } catch (_error) { copied = false; }
  field.remove();
  return copied;
}

async function request(path, options) {
  options = options || {};
  const token = localStorage.getItem(TOKEN_KEY) || '';
  const headers = Object.assign({ Accept: 'application/json' }, options.headers || {});
  if (token) headers.Authorization = 'Bearer ' + token;
  if (options.body) headers['Content-Type'] = 'application/json';
  const response = await fetch(path, Object.assign({}, options, { headers: headers }));
  if (response.status === 401) {
    renderAuth();
    throw new Error('authorization');
  }
  const payload = await response.json().catch(() => null);
  if (!response.ok || (payload && payload.success === false)) {
    const error = new Error((payload && payload.error) || 'Request failed');
    error.code = payload && payload.code;
    throw error;
  }
  return payload && payload.data !== undefined ? payload.data : payload;
}

/* --- shared fragments --------------------------------------------------- */

function statusLine(severity, label) {
  return '<span class="status ' + h(severity) + '"><span class="status-dot" aria-hidden="true"></span>' + h(label) + '</span>';
}

function metric(item) {
  const valueClass = item.emphasis === 'text' ? 'metric-text' : 't-metric';
  return '<div class="metric">' +
    '<div class="metric-label">' + h(item.label) + '</div>' +
    '<div class="' + valueClass + '">' + h(item.value) + '</div>' +
    (item.detail ? '<div class="metric-detail">' + h(item.detail) + '</div>' : '') +
    '</div>';
}

function metrics(items) {
  if (!items || !items.length) return '';
  return '<div class="metrics">' + items.map(metric).join('') + '</div>';
}

function empty(title, body) {
  return '<div class="empty"><div class="empty-title">' + h(title) + '</div><div class="empty-body">' + h(body) + '</div></div>';
}

function pageHeader(title, lede, trailing) {
  return '<div class="page-header">' +
    '<div class="page-header-row"><h1 class="t-page">' + h(title) + '</h1>' + (trailing || '') + '</div>' +
    (lede ? '<p class="page-lede">' + h(lede) + '</p>' : '') +
    '</div>';
}

/** A technical identifier: monospace, truncated, always copyable. */
function identifier(label, shortValue, fullValue) {
  if (!fullValue) return '';
  return '<div class="row-between">' +
    '<span class="t-body">' + h(label) + '</span>' +
    '<span class="row"><span class="t-mono">' + h(shortValue || fullValue) + '</span>' +
    '<button class="button small subtle" data-copy="' + h(fullValue) + '">Copy</button></span>' +
    '</div>';
}

function detailRow(label, value) {
  if (value === null || value === undefined || value === '') return '';
  return '<div class="row-between"><span class="t-body">' + h(label) + '</span><span class="t-body">' + h(value) + '</span></div>';
}

/* --- auth --------------------------------------------------------------- */

function renderAuth() {
  $('#app').innerHTML = '<main class="auth"><form class="auth-card" id="authForm">' +
    '<div class="brand"><div class="brand-name">kubus Node</div>' +
    '<div class="brand-descriptor">Local runtime + public archive node</div></div>' +
    '<p class="t-body">Enter the local GUI token configured as NODE_GUI_TOKEN to open this node.</p>' +
    '<label for="token">GUI token' +
    '<input id="token" type="password" autocomplete="current-password" required></label>' +
    '<button class="button primary" type="submit">Open node</button>' +
    '<p class="t-meta">This GUI controls local node operations only. It cannot move funds.</p>' +
    '</form></main>';
  $('#authForm').addEventListener('submit', (event) => {
    event.preventDefault();
    localStorage.setItem(TOKEN_KEY, $('#token').value);
    location.reload();
  });
}

/* --- shell -------------------------------------------------------------- */

function navigation() {
  const flags = sectionFlags();
  return SECTIONS.map((section) => {
    const current = section.id === activeSection;
    const flag = flags[section.id];
    return '<button type="button" class="nav-button" data-section="' + h(section.id) + '"' +
      (current ? ' aria-current="page"' : '') + '>' +
      '<span>' + h(section.label) + '</span>' +
      (flag ? '<span class="nav-flag ' + h(flag) + '" role="img" aria-label="Needs attention"></span>' : '') +
      '</button>';
  }).join('');
}

/** Marks the sections an alert points at, so the nav shows where to go. */
function sectionFlags() {
  const flags = {};
  (model && model.alerts ? model.alerts : []).forEach((alert) => {
    const target = alert.action && alert.action.section ? alert.action.section : alert.id;
    const existing = flags[target];
    if (!existing || alert.severity === 'critical') flags[target] = alert.severity;
  });
  return flags;
}

function renderShell() {
  $('#app').innerHTML = '<div class="shell">' +
    '<aside class="sidebar">' +
    '<div class="brand"><div class="brand-name">kubus Node</div>' +
    '<div class="brand-descriptor">Local runtime + public archive node</div></div>' +
    '<nav class="nav" aria-label="Sections">' + navigation() + '</nav>' +
    '<div class="sidebar-footer">' +
    '<div class="t-meta">' + h(model.node.label) + '</div>' +
    '<div class="t-meta">' + h(model.advanced.guiExposure) + '</div>' +
    '</div>' +
    '</aside>' +
    '<main class="main" id="main" tabindex="-1"></main>' +
    '</div>';
  bindNavigation();
}

function bindNavigation() {
  $$('[data-section]').forEach((button) => {
    button.addEventListener('click', () => navigate(button.dataset.section));
  });
}

function navigate(section) {
  if (!SECTIONS.some((item) => item.id === section)) return;
  activeSection = section;
  history.replaceState(null, '', '#' + section);
  renderShell();
  renderSection();
  const main = $('#main');
  if (main) main.focus();
}

/* --- banner ------------------------------------------------------------- */

/**
 * A participation problem is shown as a banner above the section, never as a
 * replacement for the interface. The operator keeps every tool they had.
 */
function banner() {
  const alerts = model.alerts || [];
  if (!alerts.length) return '';
  const alert = alerts[0];
  return '<div class="banner ' + (alert.severity === 'critical' ? 'critical' : '') + '" role="alert">' +
    '<div class="banner-body">' +
    '<div class="banner-title">' + h(alert.title) + '</div>' +
    '<div class="t-body">' + h(alert.body) + '</div>' +
    '</div>' +
    (alert.action ? '<button class="button small" data-section="' + h(alert.action.section) + '">' + h(alert.action.label) + '</button>' : '') +
    '</div>';
}

/* --- sections ----------------------------------------------------------- */

function renderOverview() {
  const cards = (model.overview || []).map((section) =>
    '<section class="panel" aria-labelledby="ov-' + h(section.id) + '">' +
    '<div class="panel-header">' +
    '<h2 class="t-card" id="ov-' + h(section.id) + '">' + h(section.title) + '</h2>' +
    (section.status ? statusLine(section.severity, section.status) : '') +
    '</div>' +
    (section.metrics.length ? metrics(section.metrics) : '') +
    '<button class="button small subtle" data-section="' + h(section.id) + '">Open ' + h(section.title.toLowerCase()) + '</button>' +
    '</section>'
  ).join('');

  return pageHeader(
    model.node.label,
    model.participation.body,
    statusLine(model.participation.severity, model.participation.title),
  ) +
    banner() +
    '<div class="overview-grid">' + cards + '</div>' +
    '<section class="panel">' +
    '<h2 class="t-card">Why participation matters</h2>' +
    '<p class="t-body">' + h(model.participation.explanation) + '</p>' +
    '</section>';
}

function renderArchive() {
  const archive = model.archive;
  const storage = model.storage;

  const capacity = storage.segments.length
    ? '<div class="capacity">' +
      '<div class="capacity-track" role="img" aria-label="Storage use: ' +
      h(storage.segments.map((segment) => segment.label + ' ' + segment.value).join(', ')) + '">' +
      storage.segments.filter((segment) => segment.key !== 'available').map((segment) =>
        '<span class="capacity-fill ' + h(segment.key) + '" style="width:' + (segment.fraction * 100).toFixed(2) + '%"></span>'
      ).join('') +
      '</div>' +
      '<div class="capacity-legend">' + storage.segments.map((segment) =>
        '<span class="capacity-key"><span class="capacity-swatch ' + h(segment.key) + '"></span>' +
        h(segment.label) + ' <span class="capacity-value">' + h(segment.value) + '</span></span>'
      ).join('') + '</div>' +
      '</div>'
    : '';

  const headline = [{ label: 'Stored', value: archive.stored }];
  if (archive.coverageLabel) headline.push({ label: 'Coverage', value: archive.coverageLabel, detail: archive.records + ' of ' + archive.tracked + ' records' });
  headline.push({ label: 'Public records', value: String(archive.records) });

  const failures = archive.failures.length
    ? '<div class="records">' + archive.failures.map((failure) =>
      '<div class="record">' +
      '<div class="record-title"><span class="t-mono">' + h(failure.cidShort) + '</span>' +
      '<button class="button small subtle" data-copy="' + h(failure.cid) + '">Copy</button></div>' +
      '<div class="t-body">' + h(failure.error) + '</div>' +
      '<div class="t-meta">' + h(failure.at) + '</div>' +
      '</div>'
    ).join('') + '</div>'
    : empty('Everything is stored', 'No archive records are missing from this node.');

  return pageHeader('Public archive', 'Records this node keeps available for the art.kubus network.') +
    '<section class="panel">' + metrics(headline) + capacity + '</section>' +
    '<section class="panel">' +
    '<div class="panel-header"><h2 class="t-card">Keeping the archive current</h2></div>' +
    '<div class="row">' +
    '<button class="button primary" data-action="sync">Check for new records</button>' +
    '<button class="button" data-action="pin">Store missing records</button>' +
    '<button class="button" data-action="heartbeat">Report availability</button>' +
    '</div>' +
    '<div class="t-meta">Last checked ' + h(archive.lastSync) + ' · last stored ' + h(archive.lastReconcile) + '</div>' +
    '</section>' +
    (archive.needsAttention > 0
      ? '<section class="panel"><div class="panel-header"><h2 class="t-card">Records needing attention</h2>' +
        '<span class="chip attention">' + h(archive.needsAttention) + '</span></div>' + failures + '</section>'
      : '') +
    '<section class="panel">' +
    '<details class="disclosure"><summary>Advanced archive details</summary>' +
    '<div class="stack-sm">' +
    detailRow('Collection records', archive.roleCounts.manifest) +
    detailRow('Artwork records', archive.roleCounts.record) +
    detailRow('Media files', archive.roleCounts.media) +
    detailRow('Priority records', archive.roleCounts.priority) +
    detailRow('Record limit', archive.limits.maxPinnedCids) +
    detailRow('Content filters', archive.limits.cidClassFilters.join(', ') || 'none') +
    (archive.needsAttention === 0 ? '' : '') +
    '</div></details>' +
    '</section>';
}

function renderSpatial() {
  const spatial = model.spatial;
  const items = [];
  if (spatial.gpu) items.push({ label: 'Graphics processor', value: spatial.gpu });
  items.push({ label: 'Active jobs', value: String(spatial.activeJobs), detail: spatial.queuedJobs ? spatial.queuedJobs + ' waiting' : undefined });
  items.push({ label: 'Captures held', value: String(spatial.captures) });

  return pageHeader('Spatial processing', 'Reconstructing spatial captures on this computer.',
    statusLine(spatial.severity, spatial.title)) +
    '<section class="panel">' +
    '<p class="t-body">' + h(spatial.body) + '</p>' +
    metrics(items) +
    (spatial.action ? '<div class="row"><button class="button" data-section="' + h(spatial.action.section) + '">' + h(spatial.action.label) + '</button></div>' : '') +
    '</section>' +
    (spatial.captures === 0
      ? '<section class="panel">' + empty('No spatial captures yet', 'Document an artwork spatially in the art.kubus app to create its first 3D archive.') + '</section>'
      : '') +
    '<section class="panel">' +
    '<details class="disclosure"><summary>Worker details</summary><div class="stack-sm">' +
    detailRow('Reported state', spatial.title) +
    (spatial.workerDetail ? '<div class="t-mono">' + h(spatial.workerDetail) + '</div>' : '') +
    (spatial.capabilities.length ? detailRow('Supported operations', spatial.capabilities.join(', ')) : '') +
    '</div></details>' +
    '</section>';
}

function renderCompute() {
  const compute = model.compute;
  const shareItems = [];
  if (compute.sharing) {
    shareItems.push({ label: 'Waiting', value: String(compute.queued) });
    shareItems.push({ label: 'In progress', value: String(compute.active) });
    shareItems.push({ label: 'Completed', value: String(compute.completed) });
  }

  return pageHeader('Compute network', 'Sharing spare GPU capacity with other art.kubus users.',
    statusLine(compute.severity, compute.status)) +
    '<section class="panel">' +
    '<h2 class="t-card">Share spare GPU capacity</h2>' +
    '<p class="t-body">Allow other art.kubus users to process spatial captures on this node. ' +
    'Successfully completed and verified jobs can contribute to your KUB8 reward record.</p>' +
    '<label class="switch">' +
    '<input type="checkbox" id="shareToggle"' + (compute.settings.enabled ? ' checked' : '') + '>' +
    '<span class="switch-track" aria-hidden="true"><span class="switch-thumb"></span></span>' +
    '<span class="switch-text"><span class="switch-title">Offer GPU to Kubus network</span>' +
    '<span class="t-meta">Archive participation is required and stays on. GPU sharing is optional.</span></span>' +
    '</label>' +
    (compute.settings.enabled
      ? '<label class="switch">' +
        '<input type="checkbox" id="pauseToggle"' + (compute.settings.paused ? ' checked' : '') + '>' +
        '<span class="switch-track" aria-hidden="true"><span class="switch-thumb"></span></span>' +
        '<span class="switch-text"><span class="switch-title">Pause sharing</span>' +
        '<span class="t-meta">Finish current jobs but accept no new ones.</span></span>' +
        '</label>'
      : '') +
    (shareItems.length ? metrics(shareItems) : '') +
    '</section>' +
    '<section class="panel">' +
    '<h2 class="t-card">What a shared job involves</h2>' +
    '<p class="t-body">Remote source captures are encrypted during transfer. This node temporarily ' +
    'decrypts them while processing the job and removes the working data afterwards.</p>' +
    '</section>' +
    (compute.settings.enabled
      ? '<section class="panel"><details class="disclosure"><summary>Sharing limits</summary>' +
        '<div class="stack-sm">' + compute.settingsDisplay.map((item) => detailRow(item.label, item.value)).join('') + '</div>' +
        '</details></section>'
      : '');
}

function renderContribution() {
  const contribution = model.contribution;
  if (!contribution.hasAny) {
    return pageHeader('Contribution', 'Verified records of what this node has contributed.') +
      '<section class="panel">' +
      empty('No verified contribution yet', 'Contribution appears after the network verifies archive availability or completed compute jobs.') +
      '</section>' + contributionExplainer();
  }

  return pageHeader('Contribution', 'Verified records of what this node has contributed.') +
    '<section class="panel">' +
    metrics([
      { label: 'Archive contribution', value: contribution.archiveKub8 + ' KUB8' },
      { label: 'Compute contribution', value: contribution.computeKub8 + ' KUB8' },
      { label: 'Pending total', value: contribution.pendingKub8 + ' KUB8' },
    ]) +
    '<p class="t-meta">' + h(contribution.settlementNote) + '</p>' +
    '</section>' + contributionExplainer();
}

function contributionExplainer() {
  const verified = model.contribution.verified;
  return '<section class="panel">' +
    '<details class="disclosure"><summary>How contribution is calculated</summary><div class="stack-sm">' +
    '<div><div class="t-card">Archive</div><p class="t-body">Based on verified public archive availability, ' +
    'retrieval reliability and the amount and type of canonical data you keep available.</p></div>' +
    '<div><div class="t-card">Compute</div><p class="t-body">Based on successfully completed and verified ' +
    'network compute jobs.</p></div>' +
    (verified.publicCidHours !== null ? detailRow('Verified archive hours', verified.publicCidHours) : '') +
    (verified.rewardableCidHours !== null ? detailRow('Verified priority hours', verified.rewardableCidHours) : '') +
    (verified.computeUnits !== null ? detailRow('Verified compute units', verified.computeUnits) : '') +
    '</div></details></section>';
}

function renderDevices() {
  const devices = model.devices || [];
  const list = devices.length
    ? '<div class="records">' + devices.map((device) =>
      '<div class="record">' +
      '<div class="record-title">' + h(device.label) + '</div>' +
      '<div class="t-meta">Connected ' + h(device.connected) + ' · last used ' + h(device.lastUsed) + '</div>' +
      '<div class="row"><button class="button small danger" data-revoke="' + h(device.id) + '">Disconnect</button></div>' +
      '</div>'
    ).join('') + '</div>'
    : empty('No art.kubus device connected', 'Connect the art.kubus app to use this node for spatial processing.');

  return pageHeader('Devices', 'art.kubus apps allowed to use this node.') +
    '<section class="panel">' +
    '<div class="panel-header"><h2 class="t-card">Connected devices</h2>' +
    '<button class="button primary" id="startPairing">Connect art.kubus</button></div>' +
    list +
    '</section>' +
    '<div id="pairingArea"></div>';
}

function renderPairingArea() {
  const area = $('#pairingArea');
  if (!area) return;
  if (!pairing) { area.innerHTML = ''; return; }
  if (pairing.connected) {
    area.innerHTML = '<section class="panel"><div class="pairing">' +
      '<h2 class="t-card">Device connected</h2>' +
      '<p class="t-body">The art.kubus app can now use this node.</p>' +
      '</div></section>';
    return;
  }
  area.innerHTML = '<section class="panel"><div class="pairing">' +
    '<h2 class="t-card">Connect art.kubus</h2>' +
    '<p class="t-body">Scan this code from the art.kubus app.</p>' +
    '<div class="qr-frame">' + pairing.qrSvg + '</div>' +
    '<details class="disclosure"><summary>Enter code manually</summary>' +
    '<div class="stack-sm"><div class="pairing-code">' + h(pairing.code) + '</div>' +
    '<button class="button small" data-copy="' + h(pairing.code) + '">Copy pairing code</button>' +
    '<div class="t-meta">Node ' + h(pairing.node.label) + ' · fingerprint ' + h(pairing.node.fingerprint) + '</div>' +
    '</div></details>' +
    '<div class="countdown t-body" id="pairingCountdown"></div>' +
    '<button class="button" id="cancelPairing">Cancel</button>' +
    '</div></section>';
  const copyPairing = area.querySelector('[data-copy]');
  copyPairing.addEventListener('click', async () => {
    if (!await copyText(copyPairing.dataset.copy)) {
      announce('Copy failed. Select the pairing code and copy it manually.');
      return;
    }
    announce('Copied');
    copyPairing.textContent = 'Copied';
  });
  $('#cancelPairing').addEventListener('click', stopPairing);
  tickPairing();
}

function renderDiagnostics() {
  const checks = diagnostics
    ? '<div class="records">' + diagnostics.checks.map((check) =>
      '<div class="record">' +
      '<div class="record-title">' + h(check.name) + statusLine(check.ok ? 'good' : 'attention', check.ok ? 'OK' : 'Needs attention') + '</div>' +
      (check.detail ? '<div class="t-body">' + h(check.detail) + '</div>' : '') +
      '</div>'
    ).join('') + '</div>'
    : empty('No checks run yet', 'Run the checks to see how each part of this node is doing.');

  return pageHeader('Diagnostics', 'Check the parts this node depends on.') +
    '<section class="panel">' +
    '<div class="panel-header"><h2 class="t-card">Node checks</h2>' +
    '<div class="row"><button class="button primary" id="runChecks">Run checks</button>' +
    (diagnostics ? '<button class="button" id="copyReport">Copy diagnostic report</button>' : '') +
    '</div></div>' +
    checks +
    (diagnostics ? '<p class="t-meta">The diagnostic report contains no tokens, keys or credentials.</p>' : '') +
    '</section>' +
    '<section class="panel" id="logsPanel">' +
    '<div class="panel-header"><h2 class="t-card">Logs</h2></div>' +
    '<div class="row">' +
    '<label for="logLevel" class="visually-hidden">Minimum level</label>' +
    '<select id="logLevel"><option value="">All levels</option><option value="info">Info</option>' +
    '<option value="warn">Warning</option><option value="error">Error</option></select>' +
    '<label for="logQuery" class="visually-hidden">Search logs</label>' +
    '<input type="text" id="logQuery" placeholder="Search logs">' +
    '<button class="button" id="toggleFollow">' + (logState.follow ? 'Pause' : 'Follow') + '</button>' +
    '</div>' +
    '<div class="log-viewport" id="logViewport"></div>' +
    '</section>';
}

/**
 * The subsystem a structured log line came from — the loop name for a
 * Scheduler loop, or the compute poller — so five different scheduler
 * loops failing at once no longer read as identical noise (Part 28).
 */
function logSubsystem(line) {
  const data = line.data;
  if (!data) return null;
  if (data.loop) return 'Scheduler · ' + data.loop;
  if (data.op === 'remote_compute_poll') return 'Compute provider';
  return null;
}

/**
 * A compact one-line error detail from a structured log payload — e.g.
 * "Backend unavailable · HTTP 503 · retry in 10s" — instead of forcing the
 * operator to read the raw message string for context already present as
 * structured fields.
 */
function logDetail(line) {
  const data = line.data;
  if (!data) return null;
  const parts = [];
  if (data.message && data.message !== line.message) parts.push(data.message);
  if (data.status) parts.push('HTTP ' + data.status);
  else if (data.code) parts.push(data.code);
  if (data.consecutiveFailures > 1) parts.push(data.consecutiveFailures + ' failures');
  if (data.nextRetryMs) parts.push('retrying in ' + Math.round(data.nextRetryMs / 1000) + 's');
  return parts.length ? parts.join(' · ') : null;
}

function renderLogLines() {
  const viewport = $('#logViewport');
  if (!viewport) return;
  const query = logState.query.toLowerCase();
  const lines = logState.lines.filter((line) =>
    !query || String(line.message || '').toLowerCase().indexOf(query) >= 0);
  viewport.innerHTML = lines.length
    ? lines.map((line) => {
      const subsystem = logSubsystem(line);
      const detail = logDetail(line);
      return '<div class="log-line">' +
        '<span class="log-level ' + h(line.level) + '">' + h(line.level) + '</span>' +
        '<span>' + h(line.at) + '</span>' +
        '<span>' +
        (subsystem ? '<span class="log-subsystem">' + h(subsystem) + '</span> ' : '') +
        h(line.message) +
        (detail ? '<span class="log-detail">' + h(detail) + '</span>' : '') +
        '</span>' +
        '</div>';
    }).join('')
    : '<div class="log-line"><span></span><span></span><span>No matching log lines.</span></div>';
  if (logState.follow) viewport.scrollTop = viewport.scrollHeight;
}

function renderSettings() {
  const advanced = model.advanced;
  return pageHeader('Settings', 'How this node identifies itself and what it exposes.') +
    '<section class="panel">' +
    '<h2 class="t-card">This node</h2>' +
    detailRow('Name', model.node.label) +
    detailRow('Version', model.node.version) +
    detailRow('Last reported to the network', model.node.lastHeartbeat) +
    // Same value, same format, shown on the pairing code — this is what an
    // operator compares by eye against what the art.kubus app displays.
    detailRow('Identity fingerprint', model.node.fingerprint) +
    '</section>' +
    '<section class="panel">' +
    '<h2 class="t-card">Access</h2>' +
    detailRow('This GUI', advanced.guiExposure) +
    detailRow('art.kubus app access', advanced.localApi) +
    detailRow('Operator account', advanced.operatorTokenConfigured ? 'Connected' : 'Not connected') +
    '<p class="t-meta">Tokens and keys are never shown here. Change them in the node configuration.</p>' +
    '</section>' +
    '<section class="panel">' +
    '<details class="disclosure"><summary>Technical details</summary><div class="stack-sm">' +
    identifier('Node ID', model.node.nodeId, advanced.nodeId) +
    identifier('Peer ID', model.node.peerId, advanced.peerId) +
    detailRow('Network endpoint', advanced.backendUrl) +
    '</div></details>' +
    '</section>';
}

/* --- onboarding --------------------------------------------------------- */

/**
 * Shown on a node that has never been configured. The steps report real state
 * rather than pretending to write configuration the runtime reads from the
 * environment — each one says what is already true and what remains.
 */
function shouldOnboard() {
  return !onboardingDismissed && model && model.participation.title === 'Setup required';
}

function onboardingSteps() {
  const advanced = model.advanced;
  const spatial = model.spatial;
  return [
    {
      title: 'Welcome to kubus Node',
      body: 'Run part of the art.kubus network on hardware you control.',
      features: [
        { title: 'Public archive', body: 'Keep verified cultural records available.' },
        { title: 'Local spatial processing', body: 'Process captures on a compatible local GPU.' },
        { title: 'Network compute', body: 'Optionally offer spare GPU capacity to other users.' },
      ],
      next: 'Continue setup',
    },
    {
      title: 'Connect operator account',
      body: 'Your node registers with art.kubus so the network can verify what it keeps available and record your contribution.',
      status: advanced.operatorTokenConfigured
        ? { severity: 'good', label: 'Operator account connected' }
        : { severity: 'attention', label: 'Set NODE_OPERATOR_TOKEN in the node configuration, then restart the node' },
      next: 'Next',
    },
    {
      title: 'Archive capacity',
      body: 'This node stores part of the public archive. Capacity is set in the node configuration and applies when the node starts.',
      status: { severity: 'neutral', label: 'Currently allocated: ' + model.storage.total },
      next: 'Next',
    },
    {
      title: 'Hardware',
      body: spatial.gpu
        ? 'A compatible graphics processor was detected on this computer.'
        : 'No compatible NVIDIA GPU was detected. This node can still keep the public archive available, and captures can be processed on the Kubus network.',
      status: { severity: spatial.severity, label: (spatial.gpu ? spatial.gpu + ' · ' : '') + spatial.title },
      next: 'Next',
    },
    {
      title: 'Share spare GPU capacity',
      body: 'Optionally let other art.kubus users process spatial captures on this node. You can change this at any time.',
      toggle: true,
      next: 'Finish',
    },
  ];
}

function renderOnboarding() {
  const steps = onboardingSteps();
  const step = steps[Math.min(onboardingStep, steps.length - 1)];
  const pips = steps.map((_, index) =>
    '<span class="step-pip ' + (index < onboardingStep ? 'done' : index === onboardingStep ? 'current' : '') + '"></span>'
  ).join('');

  $('#app').innerHTML = '<main class="onboarding"><section class="onboarding-card">' +
    '<div class="steps" role="img" aria-label="Step ' + (onboardingStep + 1) + ' of ' + steps.length + '">' + pips + '</div>' +
    '<div class="brand"><div class="brand-name">kubus Node</div>' +
    '<div class="brand-descriptor">Local &amp; distributed Gaussian splatting for a decentralised spatial archive.</div></div>' +
    '<div class="stack">' +
    '<h1 class="t-page">' + h(step.title) + '</h1>' +
    '<p class="page-lede">' + h(step.body) + '</p>' +
    (step.features
      ? '<div class="feature-list">' + step.features.map((feature) =>
        '<div class="feature"><div class="feature-title">' + h(feature.title) + '</div>' +
        '<div class="t-body">' + h(feature.body) + '</div></div>').join('') + '</div>'
      : '') +
    (step.status ? statusLine(step.status.severity, step.status.label) : '') +
    (step.toggle
      ? '<label class="switch"><input type="checkbox" id="onboardShare"' +
        (model.compute.settings.enabled ? ' checked' : '') + '>' +
        '<span class="switch-track" aria-hidden="true"><span class="switch-thumb"></span></span>' +
        '<span class="switch-text"><span class="switch-title">Offer spare GPU capacity to the network</span></span></label>'
      : '') +
    '</div>' +
    '<div class="row">' +
    (onboardingStep > 0 ? '<button class="button" id="onboardBack">Back</button>' : '') +
    '<span class="spacer"></span>' +
    '<button class="button subtle" id="onboardSkip">Skip</button>' +
    '<button class="button primary" id="onboardNext">' + h(step.next) + '</button>' +
    '</div>' +
    '</section></main>';

  const back = $('#onboardBack');
  if (back) back.addEventListener('click', () => { onboardingStep -= 1; renderOnboarding(); });
  $('#onboardSkip').addEventListener('click', finishOnboarding);
  $('#onboardNext').addEventListener('click', async () => {
    const share = $('#onboardShare');
    if (share) {
      await request('/gui/api/compute/settings', {
        method: 'PUT',
        body: JSON.stringify({ enabled: share.checked }),
      }).catch(() => null);
    }
    if (onboardingStep >= steps.length - 1) { finishOnboarding(); return; }
    onboardingStep += 1;
    renderOnboarding();
  });
}

function finishOnboarding() {
  onboardingDismissed = true;
  onboardingStep = 0;
  render();
}

/* --- actions ------------------------------------------------------------ */

function bindSectionEvents() {
  bindNavigation();

  $$('[data-copy]').forEach((button) => {
    button.addEventListener('click', async () => {
      if (!await copyText(button.dataset.copy)) {
        announce('Copy failed. Select the value and copy it manually.');
        return;
      }
      announce('Copied');
      const original = button.textContent;
      button.textContent = 'Copied';
      setTimeout(() => { button.textContent = original; }, 1200);
    });
  });

  $$('[data-action]').forEach((button) => {
    button.addEventListener('click', async () => {
      const label = button.textContent;
      button.disabled = true;
      button.textContent = 'Working…';
      try {
        await request('/gui/api/actions/' + button.dataset.action, { method: 'POST' });
        await refresh();
      } catch (error) {
        announce(error.message);
      } finally {
        button.disabled = false;
        button.textContent = label;
      }
    });
  });

  $$('[data-revoke]').forEach((button) => {
    button.addEventListener('click', async () => {
      if (!confirm('Disconnect this device? The art.kubus app will need to pair again.')) return;
      await request('/gui/api/devices/' + encodeURIComponent(button.dataset.revoke), { method: 'DELETE' })
        .catch((error) => announce(error.message));
      await refresh();
    });
  });

  const shareToggle = $('#shareToggle');
  if (shareToggle) {
    shareToggle.addEventListener('change', async () => {
      await updateCompute({ enabled: shareToggle.checked });
    });
  }
  const pauseToggle = $('#pauseToggle');
  if (pauseToggle) {
    pauseToggle.addEventListener('change', async () => {
      await updateCompute({ paused: pauseToggle.checked });
    });
  }

  const startPairing = $('#startPairing');
  if (startPairing) startPairing.addEventListener('click', beginPairing);

  const runChecks = $('#runChecks');
  if (runChecks) {
    runChecks.addEventListener('click', async () => {
      runChecks.disabled = true;
      runChecks.textContent = 'Running…';
      try {
        diagnostics = await request('/gui/api/actions/doctor', { method: 'POST' });
        announce('Checks complete');
      } catch (error) {
        announce(error.message);
      }
      renderSection();
    });
  }

  const copyReport = $('#copyReport');
  if (copyReport) {
    copyReport.addEventListener('click', async () => {
      const report = diagnostics.checks
        .map((check) => (check.ok ? '[ok]   ' : '[fail] ') + check.name + (check.detail ? ' — ' + check.detail : ''))
        .join('\\n');
      await navigator.clipboard.writeText('kubus Node diagnostic report\\n\\n' + report).catch(() => null);
      announce('Diagnostic report copied');
    });
  }

  const logLevel = $('#logLevel');
  if (logLevel) {
    logLevel.value = logState.level;
    logLevel.addEventListener('change', async () => {
      logState.level = logLevel.value;
      await loadLogs();
    });
  }
  const logQuery = $('#logQuery');
  if (logQuery) {
    logQuery.value = logState.query;
    logQuery.addEventListener('input', () => {
      logState.query = logQuery.value;
      renderLogLines();
    });
  }
  const toggleFollow = $('#toggleFollow');
  if (toggleFollow) {
    toggleFollow.addEventListener('click', () => {
      logState.follow = !logState.follow;
      toggleFollow.textContent = logState.follow ? 'Pause' : 'Follow';
    });
  }
}

async function updateCompute(patch) {
  try {
    await request('/gui/api/compute/settings', { method: 'PUT', body: JSON.stringify(patch) });
    await refresh();
  } catch (error) {
    announce(error.message);
    render();
  }
}

/* --- pairing ------------------------------------------------------------ */

async function beginPairing() {
  try {
    pairing = await request('/gui/api/pairing/session', { method: 'POST' });
    renderPairingArea();
    if (pairingTimer) clearInterval(pairingTimer);
    pairingTimer = setInterval(tickPairing, 1000);
  } catch (error) {
    announce(error.message);
  }
}

function stopPairing() {
  // The pairing secret lives only as long as the code is on screen.
  pairing = null;
  if (pairingTimer) { clearInterval(pairingTimer); pairingTimer = null; }
  renderPairingArea();
}

function tickPairing() {
  if (!pairing) return;
  const remaining = Math.max(0, Math.floor((Date.parse(pairing.expiresAt) - Date.now()) / 1000));
  const element = $('#pairingCountdown');
  if (element) {
    const minutes = String(Math.floor(remaining / 60)).padStart(2, '0');
    const seconds = String(remaining % 60).padStart(2, '0');
    element.textContent = 'Pairing code expires in ' + minutes + ':' + seconds;
  }
  if (remaining <= 0) {
    stopPairing();
    announce('Pairing code expired');
  }
}

/* --- logs --------------------------------------------------------------- */

async function loadLogs() {
  try {
    const data = await request('/gui/api/logs' + (logState.level ? '?level=' + encodeURIComponent(logState.level) : ''));
    logState.lines = data.logs || [];
    renderLogLines();
  } catch (error) {
    announce(error.message);
  }
}

/* --- render loop -------------------------------------------------------- */

function renderSection() {
  const main = $('#main');
  if (!main) return;
  if (activeSection === 'overview') main.innerHTML = renderOverview();
  else if (activeSection === 'archive') main.innerHTML = banner() + renderArchive();
  else if (activeSection === 'spatial') main.innerHTML = banner() + renderSpatial();
  else if (activeSection === 'compute') main.innerHTML = banner() + renderCompute();
  else if (activeSection === 'contribution') main.innerHTML = renderContribution();
  else if (activeSection === 'devices') main.innerHTML = renderDevices();
  else if (activeSection === 'diagnostics') main.innerHTML = renderDiagnostics();
  else if (activeSection === 'settings') main.innerHTML = renderSettings();
  bindSectionEvents();
  if (activeSection === 'devices') renderPairingArea();
  if (activeSection === 'diagnostics') { renderLogLines(); void loadLogs(); }
}

function render() {
  if (shouldOnboard()) { renderOnboarding(); return; }
  renderShell();
  renderSection();
}

async function refresh() {
  if (refreshing) return;
  refreshing = true;
  const main = $('#main');
  try {
    const next = await request('/gui/api/view');
    const firstLoad = model === null;
    model = next;
    if (firstLoad) render();
    else {
      // Keep the shell; only the section content and nav flags change.
      renderShell();
      renderSection();
    }
  } catch (error) {
    if (String(error.message) === 'authorization') return;
    // A failed poll must not discard a good screen. Only a cold start with no
    // model at all becomes an error page.
    if (model === null) {
      $('#app').innerHTML = '<main class="auth"><div class="auth-card">' +
        '<div class="brand"><div class="brand-name">kubus Node</div></div>' +
        '<p class="t-body">This node is not responding yet.</p>' +
        '<p class="t-meta">' + h(error.message) + '</p>' +
        '<button class="button primary" onclick="location.reload()">Try again</button>' +
        '</main>';
    } else {
      announce('Could not refresh node status');
      if (main) main.classList.add('is-refreshing');
    }
  } finally {
    refreshing = false;
    if (main) main.classList.remove('is-refreshing');
  }
}

window.addEventListener('hashchange', () => {
  const section = location.hash.replace('#', '');
  if (section && section !== activeSection) navigate(section);
});

void refresh();
setInterval(() => { void refresh(); }, 10000);
`;
