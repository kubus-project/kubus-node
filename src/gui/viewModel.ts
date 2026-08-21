/**
 * The GUI view model.
 *
 * The browser client is deliberately a thin renderer: every decision about what
 * an operator sees — which state language, which severity, which numbers are
 * worth showing at all — is made here, in typed and tested code, and shipped to
 * the page as plain data.
 *
 * Two consequences worth keeping:
 *
 * 1. Nothing raw leaks. The view model is built by naming fields explicitly, so
 *    a secret added to `LocalState` later cannot appear in the GUI by accident.
 * 2. Every metric is measured. Where the runtime does not actually observe a
 *    quantity, the field is `null` and the GUI omits the row rather than
 *    inventing a confident-looking number.
 */

import type { ParticipationSnapshot } from '../participation/networkParticipationGate.js';
import type { SpatialWorkerHealth } from '../capabilities/registry.js';
import type { ComputeProviderSettings } from '../compute/providerSettings.js';
import { formatFingerprint } from '../identity/nodeIdentity.js';
import type { LocalState } from '../state/localStore.js';
import {
  RECIPROCITY_EXPLANATION,
  describeGpu,
  describeParticipation,
  describeRequirements,
  describeWorker,
  formatBytes,
  formatKub8,
  formatPercent,
  formatRelativeTime,
  shortId,
  worstSeverity,
  type Severity,
  type StateDescription,
} from './presentation.js';

export interface ViewModelInput {
  state: LocalState;
  /** Only the fingerprint travels here — never the public key or anything key-shaped, and never the private key. */
  identity: { fingerprint: string };
  participation: ParticipationSnapshot;
  worker: SpatialWorkerHealth;
  jobs: { configured: boolean; running: number; queued: number; concurrency: number };
  compute: ComputeProviderSettings;
  storage: {
    repoBytes: number;
    storageMaxBytes: number;
    publicReplicaBytes: number;
    privateCaptureBytes: number;
    maxPinnedBytes: number;
  };
  health: { backendReachable: boolean; kuboReachable: boolean; kuboVersion?: string | null };
  config: {
    nodeLabel: string;
    apiBaseUrl: string;
    maxPinnedCids: number;
    cidClassFilters: string[];
    localApiEnabled: boolean;
    localApiAllowLan: boolean;
    guiRemoteMode: boolean;
    guiTokenConfigured: boolean;
    operatorTokenConfigured: boolean;
  };
  captureCount: number;
  now?: number;
}

/** A single headline figure. `value` is already formatted for display. */
export interface Metric {
  label: string;
  value: string;
  /** Secondary line. Omitted rather than padded with filler. */
  detail?: string;
  /**
   * Quantities are set in the large tabular figure style; identifiers and names
   * are not. A GPU model is a label, and rendering it at metric size makes
   * every card shout at the same volume.
   */
  emphasis?: 'number' | 'text';
}

export interface Alert extends StateDescription {
  id: string;
}

export interface SectionSummary {
  /** Section id, matching the navigation. */
  id: string;
  title: string;
  /** Omitted where a status word would add nothing the metrics do not say. */
  status?: string;
  severity: Severity;
  metrics: Metric[];
}

export interface NodeViewModel {
  node: {
    label: string;
    nodeId: string | null;
    /** Truncated for display; the full value travels in `peerIdFull` for copy. */
    peerId: string | null;
    peerIdFull: string | null;
    version: string | null;
    lastHeartbeat: string | null;
    /**
     * Formatted (grouped, uppercase, 16-hex-char) Ed25519 identity fingerprint —
     * the value an operator compares by eye against what the art.kubus app
     * shows for this node. Never the public key itself, and never the
     * private key.
     */
    fingerprint: string;
  };
  participation: StateDescription & {
    /** Shown once, on the overview — never repeated on each gated control. */
    explanation: string;
    leaseEligible: boolean;
    graceExpiresAt: string | null;
    requirements: Array<{ key: string; label: string; ok: boolean }>;
  };
  /** Sorted worst-first. Empty when the node is healthy — no "all green" wall. */
  alerts: Alert[];
  overview: SectionSummary[];
  archive: {
    storedBytes: number;
    stored: string;
    records: number;
    tracked: number;
    coverage: number | null;
    coverageLabel: string | null;
    needsAttention: number;
    lastSync: string;
    lastReconcile: string;
    roleCounts: { manifest: number; record: number; media: number; priority: number };
    failures: Array<{ cid: string; cidShort: string; error: string; at: string }>;
    limits: { maxPinnedCids: number; cidClassFilters: string[] };
  };
  storage: {
    /** Compact capacity bar, in display order. Zero-size segments are dropped. */
    segments: Array<{ key: string; label: string; bytes: number; value: string; fraction: number }>;
    totalBytes: number;
    total: string;
    /** null when Kubo reports no configured maximum. */
    availableBytes: number | null;
  };
  spatial: StateDescription & {
    gpu: string | null;
    workerDetail: string | null;
    capabilities: string[];
    activeJobs: number;
    queuedJobs: number;
    captures: number;
  };
  compute: {
    sharing: boolean;
    paused: boolean;
    status: string;
    severity: Severity;
    settings: ComputeProviderSettings;
    settingsDisplay: Array<{ key: string; label: string; value: string }>;
    completed: number;
    active: number;
    queued: number;
  };
  contribution: {
    archiveKub8: string;
    computeKub8: string;
    pendingKub8: string;
    settlementActive: boolean;
    settlementNote: string;
    hasAny: boolean;
    verified: { publicCidHours: number | null; rewardableCidHours: number | null; computeUnits: number | null };
  };
  devices: Array<{ id: string; label: string; connected: string; lastUsed: string; scopes: string[] }>;
  advanced: {
    /** Everything here is behind progressive disclosure in the GUI. */
    backendUrl: string;
    nodeId: string | null;
    peerId: string | null;
    localApi: string;
    guiExposure: string;
    operatorTokenConfigured: boolean;
    guiTokenConfigured: boolean;
  };
}

/* -------------------------------------------------------------------------- */

const ROLE_KEYS = ['manifest', 'record', 'media', 'priority'] as const;

export function buildViewModel(input: ViewModelInput): NodeViewModel {
  const now = input.now ?? Date.now();
  const { state } = input;

  const participationDescription = describeParticipation(input.participation);
  const workerDescription = describeWorker(input.worker);

  const archive = buildArchive(input, now);
  const storage = buildStorage(input);
  const contribution = buildContribution(state);
  const compute = buildCompute(input);

  const spatial = {
    ...workerDescription,
    gpu: describeGpu(input.worker),
    // CUDA/driver text is diagnostic detail, never the headline (§17).
    workerDetail: input.worker.detail ?? null,
    capabilities: input.worker.capabilities ?? [],
    activeJobs: input.jobs.running,
    queuedJobs: input.jobs.queued,
    captures: input.captureCount,
  };

  return {
    node: {
      label: input.config.nodeLabel,
      nodeId: state.nodeId ?? null,
      peerId: state.peerId ? shortId(state.peerId) : null,
      peerIdFull: state.peerId ?? null,
      version: state.latestHeartbeat?.agentVersion ?? null,
      lastHeartbeat: formatRelativeTime(state.latestHeartbeatAt, now),
      fingerprint: formatFingerprint(input.identity.fingerprint),
    },
    participation: {
      ...participationDescription,
      explanation: RECIPROCITY_EXPLANATION,
      leaseEligible: input.participation.leaseEligible,
      graceExpiresAt: input.participation.graceExpiresAt ?? null,
      requirements: describeRequirements(input.participation.requirements || {}),
    },
    alerts: buildAlerts(input, participationDescription, workerDescription, archive),
    overview: buildOverview({ participationDescription, archive, spatial, compute, contribution }),
    archive,
    storage,
    spatial,
    compute,
    contribution,
    devices: buildDevices(state, now),
    advanced: {
      backendUrl: input.config.apiBaseUrl,
      nodeId: state.nodeId ?? null,
      peerId: state.peerId ?? null,
      localApi: input.config.localApiEnabled
        ? (input.config.localApiAllowLan ? 'Enabled for this network' : 'Enabled for this computer only')
        : 'Disabled',
      guiExposure: input.config.guiRemoteMode ? 'Reachable beyond this computer' : 'This computer only',
      operatorTokenConfigured: input.config.operatorTokenConfigured,
      guiTokenConfigured: input.config.guiTokenConfigured,
    },
  };
}

/* -------------------------------------------------------------------------- */
/* Archive                                                                    */
/* -------------------------------------------------------------------------- */

function buildArchive(input: ViewModelInput, now: number): NodeViewModel['archive'] {
  const { state } = input;
  const tracked = state.desiredCids.length;
  const pinned = state.pinnedCids.length;
  const failures = Object.entries(state.failedCids || {});

  // Coverage is a measured ratio of what this node was asked to keep against
  // what it actually holds. When nothing is tracked yet there is no ratio, and
  // showing "0%" would read as a failure rather than as "not started".
  const coverage = tracked > 0 ? pinned / tracked : null;

  const roleCounts = state.desiredCids.reduce(
    (counts, record) => {
      const key = record.isRewardable
        ? 'priority'
        : record.role === 'manifest'
          ? 'manifest'
          : record.role === 'record'
            ? 'record'
            : 'media';
      counts[key] += 1;
      return counts;
    },
    { manifest: 0, record: 0, media: 0, priority: 0 } as Record<(typeof ROLE_KEYS)[number], number>,
  );

  return {
    storedBytes: input.storage.publicReplicaBytes,
    stored: formatBytes(input.storage.publicReplicaBytes),
    records: pinned,
    tracked,
    coverage,
    coverageLabel: coverage === null ? null : formatPercent(coverage),
    needsAttention: failures.length,
    lastSync: formatRelativeTime(state.latestPublicPinSetSyncAt, now),
    lastReconcile: formatRelativeTime(state.latestPinReconcileAt, now),
    roleCounts,
    failures: failures.map(([cid, failure]) => ({
      cid,
      cidShort: shortId(cid, 10, 8),
      error: failure.error,
      at: formatRelativeTime(failure.at, now),
    })),
    limits: { maxPinnedCids: input.config.maxPinnedCids, cidClassFilters: input.config.cidClassFilters },
  };
}

/* -------------------------------------------------------------------------- */
/* Storage                                                                    */
/* -------------------------------------------------------------------------- */

function buildStorage(input: ViewModelInput): NodeViewModel['storage'] {
  const { publicReplicaBytes, privateCaptureBytes, repoBytes, storageMaxBytes } = input.storage;

  // Kubo's repo holds more than the public replicas alone (blocks in transit,
  // internal data). Anything unaccounted for is shown as its own segment rather
  // than silently folded into the public archive figure.
  const otherBytes = Math.max(0, repoBytes - publicReplicaBytes);
  const usedBytes = publicReplicaBytes + otherBytes + privateCaptureBytes;
  const availableBytes = storageMaxBytes > 0 ? Math.max(0, storageMaxBytes - usedBytes) : null;
  const totalBytes = storageMaxBytes > 0 ? storageMaxBytes : usedBytes;

  const candidates = [
    { key: 'public', label: 'Public archive', bytes: publicReplicaBytes },
    { key: 'private', label: 'Private spatial', bytes: privateCaptureBytes },
    { key: 'other', label: 'Node data', bytes: otherBytes },
    { key: 'available', label: 'Available', bytes: availableBytes ?? 0 },
  ];

  return {
    segments: candidates
      .filter((segment) => segment.bytes > 0)
      .map((segment) => ({
        ...segment,
        value: formatBytes(segment.bytes),
        fraction: totalBytes > 0 ? segment.bytes / totalBytes : 0,
      })),
    totalBytes,
    total: formatBytes(totalBytes),
    availableBytes,
  };
}

/* -------------------------------------------------------------------------- */
/* Compute                                                                    */
/* -------------------------------------------------------------------------- */

function buildCompute(input: ViewModelInput): NodeViewModel['compute'] {
  const settings = input.compute;
  const remoteJobs = Object.values(input.state.remoteJobs || {}) as Array<{ state?: string; role?: string }>;
  const providerJobs = remoteJobs.filter((job) => job.role === 'provider');
  const completed = providerJobs.filter((job) => String(job.state).toUpperCase() === 'COMPLETED').length;
  const active = providerJobs.filter((job) => ['RUNNING', 'INPUT_READY', 'ACCEPTED'].includes(String(job.state).toUpperCase())).length;
  const queued = providerJobs.filter((job) => String(job.state).toUpperCase() === 'MATCHED').length;

  const status = !settings.enabled ? 'Not sharing' : settings.paused ? 'Paused' : 'Sharing GPU';

  return {
    sharing: settings.enabled && !settings.paused,
    paused: settings.paused,
    status,
    // Sharing is optional, so "off" is a neutral choice and never an alarm.
    severity: !settings.enabled ? 'neutral' : settings.paused ? 'attention' : 'good',
    settings,
    settingsDisplay: [
      { key: 'maxConcurrency', label: 'Concurrent jobs', value: String(settings.maxConcurrency) },
      { key: 'maxQueueDepth', label: 'Queue limit', value: String(settings.maxQueueDepth) },
      { key: 'maxAcceptedInputBytes', label: 'Largest accepted capture', value: formatBytes(settings.maxAcceptedInputBytes) },
      { key: 'minimumFreeVramBytes', label: 'Reserved VRAM', value: formatBytes(settings.minimumFreeVramBytes) },
    ],
    completed,
    active,
    queued,
  };
}

/* -------------------------------------------------------------------------- */
/* Contribution                                                               */
/* -------------------------------------------------------------------------- */

function buildContribution(state: LocalState): NodeViewModel['contribution'] {
  const archiveKub8 = Number(state.rewards?.summary?.pendingKub8 || 0);
  const computeKub8 = Number(state.computeRewards?.pendingKub8 || 0);
  const settled = Number(state.rewards?.summary?.settledKub8 || 0) + Number(state.computeRewards?.settledKub8 || 0);
  const verified = state.latestStatus?.archiveContribution as
    | { verifiedPublicCidHours?: number; verifiedRewardableCidHours?: number }
    | undefined;

  // Settlement is only "active" once something has actually settled; the
  // runtime records everything as pending until the control plane says so.
  const settlementActive = settled > 0;

  return {
    archiveKub8: formatKub8(archiveKub8),
    computeKub8: formatKub8(computeKub8),
    pendingKub8: formatKub8(archiveKub8 + computeKub8),
    settlementActive,
    settlementNote: settlementActive
      ? 'Settled contribution is recorded by the network.'
      : 'Reward records are currently tracked by the network. Settlement is not yet active.',
    hasAny: archiveKub8 > 0 || computeKub8 > 0,
    verified: {
      publicCidHours: numberOrNull(verified?.verifiedPublicCidHours),
      rewardableCidHours: numberOrNull(verified?.verifiedRewardableCidHours),
      computeUnits: numberOrNull(state.computeRewards?.verifiedComputeUnits),
    },
  };
}

function numberOrNull(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/* -------------------------------------------------------------------------- */
/* Devices                                                                    */
/* -------------------------------------------------------------------------- */

function buildDevices(state: LocalState, now: number): NodeViewModel['devices'] {
  return Object.entries(state.localCredentials || {})
    // A revoked credential is gone, not a row with a "revoked" badge.
    .filter(([, credential]) => !credential.revokedAt)
    .map(([id, credential]) => ({
      id,
      label: credential.label || 'art.kubus device',
      connected: formatRelativeTime(credential.createdAt, now),
      lastUsed: formatRelativeTime(credential.lastUsedAt, now),
      scopes: credential.scopes || [],
    }))
    .sort((a, b) => a.label.localeCompare(b.label));
}

/* -------------------------------------------------------------------------- */
/* Alerts and overview                                                        */
/* -------------------------------------------------------------------------- */

/**
 * Only things the operator can act on. A healthy node produces an empty list,
 * which is what keeps the interface from turning into a wall of green (§44).
 */
function buildAlerts(
  input: ViewModelInput,
  participation: StateDescription,
  worker: StateDescription,
  archive: NodeViewModel['archive'],
): Alert[] {
  const alerts: Alert[] = [];

  if (!input.health.backendReachable) {
    alerts.push({
      id: 'backend',
      title: 'Cannot reach art.kubus',
      body: 'The node cannot contact the network right now. It will keep retrying and existing archive data stays available.',
      severity: 'attention',
      action: { label: 'Diagnose', section: 'diagnostics' },
    });
  }
  if (!input.health.kuboReachable) {
    alerts.push({
      id: 'kubo',
      title: 'Local storage service is not running',
      body: 'The node cannot store or serve archive data until the local storage service is available.',
      severity: 'critical',
      action: { label: 'Diagnose', section: 'diagnostics' },
    });
  }
  if (participation.severity === 'attention' || participation.severity === 'critical') {
    alerts.push({ id: 'participation', ...participation });
  }
  if (worker.severity === 'attention' || worker.severity === 'critical') {
    alerts.push({ id: 'spatial', ...worker, title: `Spatial processing — ${worker.title.toLowerCase()}` });
  }
  if (archive.needsAttention > 0) {
    alerts.push({
      id: 'pins',
      title: `${archive.needsAttention} archive ${archive.needsAttention === 1 ? 'item' : 'items'} could not be stored`,
      body: 'These records are part of the public archive but are not currently held by this node.',
      severity: 'attention',
      action: { label: 'Open archive', section: 'archive' },
    });
  }

  return alerts.sort((a, b) => severityRank(b.severity) - severityRank(a.severity));
}

function severityRank(severity: Severity): number {
  return { neutral: 0, good: 1, attention: 2, critical: 3 }[severity];
}

function buildOverview(parts: {
  participationDescription: StateDescription;
  archive: NodeViewModel['archive'];
  spatial: NodeViewModel['spatial'];
  compute: NodeViewModel['compute'];
  contribution: NodeViewModel['contribution'];
}): SectionSummary[] {
  const { archive, spatial, compute, contribution } = parts;

  const archiveMetrics: Metric[] = [{ label: 'Stored', value: archive.stored }];
  if (archive.coverageLabel) archiveMetrics.push({ label: 'Coverage', value: archive.coverageLabel, detail: `${archive.records} of ${archive.tracked} records` });
  else archiveMetrics.push({ label: 'Records', value: String(archive.records) });

  const spatialMetrics: Metric[] = [];
  // The GPU is the answer to "can I process here", but it is a name, not a
  // quantity — it stays at label weight so the numbers keep their emphasis.
  if (spatial.gpu) spatialMetrics.push({ label: 'Graphics processor', value: spatial.gpu, emphasis: 'text' });
  if (spatial.activeJobs > 0) spatialMetrics.push({ label: 'Processing now', value: String(spatial.activeJobs) });
  if (spatial.captures > 0) spatialMetrics.push({ label: 'Captures held', value: String(spatial.captures) });

  const computeMetrics: Metric[] = [];
  if (compute.sharing) {
    computeMetrics.push({ label: 'Jobs waiting', value: String(compute.queued) });
    if (compute.completed > 0) computeMetrics.push({ label: 'Jobs completed', value: String(compute.completed) });
  }

  return [
    {
      id: 'archive',
      title: 'Public archive',
      status: archive.needsAttention > 0 ? `${archive.needsAttention} need attention` : 'Available',
      severity: archive.needsAttention > 0 ? 'attention' : archive.records > 0 ? 'good' : 'neutral',
      metrics: archiveMetrics,
    },
    {
      id: 'spatial',
      title: 'Spatial',
      status: spatial.title,
      severity: spatial.severity,
      metrics: spatialMetrics,
    },
    {
      id: 'compute',
      title: 'Compute network',
      status: compute.status,
      severity: compute.severity,
      metrics: computeMetrics,
    },
    {
      // Contribution is a record, not a health state: no status word and no
      // status dot, just the figure it exists to report.
      id: 'contribution',
      title: 'Contribution',
      severity: 'neutral',
      metrics: contribution.hasAny
        ? [{ label: 'Pending', value: `${contribution.pendingKub8} KUB8` }]
        : [{ label: 'Pending', value: 'None yet', emphasis: 'text', detail: 'Appears after the network verifies activity' }],
    },
  ];
}

/** Worst severity across the node, for the header status dot. */
export function overallSeverity(model: NodeViewModel): Severity {
  if (model.alerts.length === 0) return model.participation.severity;
  return worstSeverity(model.alerts.map((alert) => alert.severity));
}
