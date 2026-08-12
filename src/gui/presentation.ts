/**
 * Human-facing presentation layer for kubus Node.
 *
 * Everything in this module is pure: machine state in, operator language out.
 * The GUI must never render a raw enum, error code or byte count, so this file
 * is the single place where runtime vocabulary becomes product vocabulary.
 *
 * The art.kubus Flutter client mirrors these strings in
 * `lib/features/node/presentation/node_state_presentation.dart`. Keep the two
 * in step: the wording is part of the product contract, not an implementation
 * detail.
 */

import type { ParticipationSnapshot, ParticipationState } from '../participation/networkParticipationGate.js';
import type { SpatialWorkerHealth } from '../capabilities/registry.js';
import type { JobState } from '../jobs/jobRuntime.js';

/**
 * Status severity, ordered least to most urgent. The GUI sorts and colours by
 * this rather than by section, so a single failing check can surface above an
 * otherwise healthy node.
 */
export type Severity = 'neutral' | 'good' | 'attention' | 'critical';

export const SEVERITY_ORDER: Record<Severity, number> = {
  neutral: 0,
  good: 1,
  attention: 2,
  critical: 3,
};

export function worstSeverity(values: Severity[]): Severity {
  return values.reduce<Severity>((worst, value) => (SEVERITY_ORDER[value] > SEVERITY_ORDER[worst] ? value : worst), 'neutral');
}

export interface StateDescription {
  /** Short label, safe to render next to a status dot. */
  title: string;
  /** One sentence of plain explanation. Never a stack trace, never a code. */
  body: string;
  severity: Severity;
  /** Optional call to action; omitted when there is nothing useful to do. */
  action?: { label: string; section: string };
}

/* -------------------------------------------------------------------------- */
/* Participation                                                              */
/* -------------------------------------------------------------------------- */

/**
 * Participation is reciprocity, not DRM. The copy explains what the operator
 * gets and what the network needs — it never accuses, and never says "denied".
 */
const PARTICIPATION: Record<ParticipationState, StateDescription> = {
  CONTRIBUTING: {
    title: 'Contributing',
    body: 'Archive participation is active.',
    severity: 'good',
  },
  JOINING: {
    title: 'Joining network',
    body: 'kubus Node is synchronising and verifying its public archive contribution.',
    severity: 'neutral',
  },
  DEGRADED: {
    title: 'Connection interrupted',
    body: 'Existing work can continue temporarily. New processing may pause if the node cannot restore participation.',
    severity: 'attention',
    action: { label: 'Diagnose', section: 'diagnostics' },
  },
  LOCKED: {
    title: 'Network participation required',
    body: 'Spatial processing becomes available when this kubus Node is actively contributing to the public archive.',
    severity: 'attention',
    action: { label: 'Check node status', section: 'diagnostics' },
  },
  UNCONFIGURED: {
    title: 'Setup required',
    body: 'Connect this node to your art.kubus operator account to begin.',
    severity: 'neutral',
    action: { label: 'Start setup', section: 'settings' },
  },
};

export function describeParticipation(snapshot: Pick<ParticipationSnapshot, 'state'>): StateDescription {
  return PARTICIPATION[snapshot.state] ?? PARTICIPATION.UNCONFIGURED;
}

/**
 * The one-line reciprocity explanation. Shown once on the overview and once in
 * onboarding — deliberately not repeated on every gated control.
 */
export const RECIPROCITY_EXPLANATION =
  'kubus Node gives you local spatial processing while your node contributes storage and availability to the shared public archive.';

/**
 * Requirement checks, translated. Keys match `ParticipationSnapshot.requirements`.
 * Anything missing from this map is not shown rather than shown raw.
 */
const REQUIREMENT_LABELS: Record<string, string> = {
  operatorIdentity: 'Operator account connected',
  registered: 'Node registered with the network',
  backendPolicy: 'Network policy received',
  kuboHealthy: 'Local storage service running',
  publicPinningEnabled: 'Public archive participation enabled',
  contributionCapacity: 'Allocated archive capacity meets the minimum',
  canonicalPinSetSynchronized: 'Public archive index synchronised',
  pinReconciliationHealthy: 'Archive contents reconciled',
  actualContributionStateVerified: 'Planned public archive records stored locally',
  schedulerActive: 'Background tasks running',
  heartbeatAccepted: 'Recent heartbeat accepted by the network',
  productionPinningSafe: 'Production pinning configuration is safe',
};

export function describeRequirements(requirements: Record<string, boolean>): Array<{ label: string; ok: boolean; key: string }> {
  return Object.entries(requirements)
    .filter(([key]) => key in REQUIREMENT_LABELS)
    .map(([key, ok]) => ({ key, ok, label: REQUIREMENT_LABELS[key]! }))
    // Unmet requirements first: the operator is here to fix something.
    .sort((a, b) => Number(a.ok) - Number(b.ok));
}

/* -------------------------------------------------------------------------- */
/* Spatial worker                                                             */
/* -------------------------------------------------------------------------- */

/**
 * Answers one question: can I process a spatial capture right now?
 * CUDA/driver detail stays in `detail` and is only rendered behind disclosure.
 */
export function describeWorker(worker: SpatialWorkerHealth): StateDescription {
  if (worker.status === 'ready') {
    if (worker.gpu.available) {
      return { title: 'Ready', body: 'Gaussian reconstruction available.', severity: 'good' };
    }
    // Malformed data: the worker claims readiness without a GPU. Never
    // invent a confident-looking state for that — treat it as degraded.
    return {
      title: 'Degraded',
      body: 'The spatial worker responded but reported a problem.',
      severity: 'attention',
      action: { label: 'Details', section: 'diagnostics' },
    };
  }
  if (worker.status === 'unconfigured') {
    return {
      title: 'Not configured',
      body: 'Spatial processing is not set up on this node.',
      severity: 'neutral',
      action: { label: 'View requirements', section: 'diagnostics' },
    };
  }
  if (worker.status === 'unsupported') {
    // The worker was reachable and answered — this is the one case where the
    // data actually establishes the hardware is the problem, not the network.
    return {
      title: 'GPU unavailable',
      body: 'The spatial worker is running, but CUDA cannot access a compatible NVIDIA GPU.',
      severity: 'neutral',
      action: { label: 'View requirements', section: 'diagnostics' },
    };
  }
  if (worker.status === 'degraded') {
    return {
      title: 'Degraded',
      body: 'The spatial worker responded but reported a problem.',
      severity: 'attention',
      action: { label: 'Details', section: 'diagnostics' },
    };
  }
  // status === 'unavailable': the worker could not be reached at all (down,
  // unreachable, timed out). We have no data on the GPU, so we never guess at
  // hardware incompatibility here — that would misdiagnose an offline
  // container as unsupported hardware.
  if (worker.gpu.available) {
    return {
      title: 'Worker unavailable',
      body: 'GPU detected, but the spatial worker is not responding.',
      severity: 'attention',
      action: { label: 'Details', section: 'diagnostics' },
    };
  }
  return {
    title: 'Worker unavailable',
    body: 'The spatial worker is not responding.',
    severity: 'attention',
    action: { label: 'View diagnostics', section: 'diagnostics' },
  };
}

/** "RTX 3080 Ti · 12 GB", or null when there is nothing worth showing. */
export function describeGpu(worker: SpatialWorkerHealth): string | null {
  if (!worker.gpu.available) return null;
  const name = worker.gpu.model || worker.gpu.name || worker.gpu.vendor;
  const vram = worker.gpu.totalVramBytes ? formatBytes(worker.gpu.totalVramBytes) : null;
  if (name && vram) return `${name} · ${vram}`;
  return name || vram;
}

/* -------------------------------------------------------------------------- */
/* Jobs                                                                       */
/* -------------------------------------------------------------------------- */

/**
 * Local pipeline stages (§31). Fewer stages than remote because there is no
 * transfer, no provider and no verification round-trip.
 */
export const LOCAL_JOB_STAGES = ['Preparing', 'Processing locally', 'Optimising', 'Creating preview', 'Complete'] as const;

export function describeLocalJob(job: { state: JobState; progress?: number }): StateDescription & { stageIndex: number; determinate: boolean } {
  const progress = typeof job.progress === 'number' ? job.progress : 0;
  switch (job.state) {
    case 'queued':
      return { title: 'Preparing', body: 'Waiting for the local spatial worker.', severity: 'neutral', stageIndex: 0, determinate: false };
    case 'running': {
      // The worker reports a real fraction, so a determinate bar is honest here.
      const stageIndex = progress >= 0.9 ? 3 : progress >= 0.6 ? 2 : 1;
      return { title: LOCAL_JOB_STAGES[stageIndex]!, body: 'Processing on your kubus Node.', severity: 'neutral', stageIndex, determinate: true };
    }
    case 'completed':
      return { title: 'Complete', body: 'The spatial archive is ready.', severity: 'good', stageIndex: 4, determinate: true };
    case 'cancelled':
      return { title: 'Cancelled', body: 'Processing was stopped. Your capture is unchanged.', severity: 'neutral', stageIndex: 0, determinate: false };
    case 'failed':
    default:
      return { title: 'Processing stopped', body: 'Your original capture is still available on your kubus Node.', severity: 'critical', stageIndex: 0, determinate: false };
  }
}

/**
 * Remote pipeline stages (§30), aligned to the backend state machine:
 * REQUESTED → MATCHED → ACCEPTED → INPUT_READY → RUNNING → OUTPUT_READY →
 * VERIFYING → VERIFIED → COMPLETED.
 *
 * Progress is stage-based rather than a percentage, because the backend cannot
 * estimate remaining time and a fake linear bar would be a lie.
 */
export const REMOTE_JOB_STAGES = [
  'Preparing capture',
  'Encrypting',
  'Sending to node',
  'Waiting for GPU',
  'Processing',
  'Preparing spatial archive',
  'Receiving result',
  'Verifying',
  'Complete',
] as const;

const REMOTE_STAGE_INDEX: Record<string, number> = {
  REQUESTED: 0,
  MATCHED: 2,
  ACCEPTED: 3,
  INPUT_READY: 3,
  RUNNING: 4,
  OUTPUT_READY: 5,
  VERIFYING: 7,
  VERIFIED: 7,
  COMPLETED: 8,
};

export function describeRemoteJob(state: string): StateDescription & { stageIndex: number; terminal: boolean } {
  const normalized = String(state || '').toUpperCase();
  if (normalized in REMOTE_STAGE_INDEX) {
    const stageIndex = REMOTE_STAGE_INDEX[normalized]!;
    const complete = normalized === 'COMPLETED';
    return {
      title: REMOTE_JOB_STAGES[stageIndex]!,
      body: complete ? 'The spatial archive is ready.' : 'Processing on the Kubus network.',
      severity: complete ? 'good' : 'neutral',
      stageIndex,
      terminal: complete,
    };
  }
  switch (normalized) {
    case 'DECLINED':
      return { title: 'Not accepted', body: 'The selected node could not take this job. Try another node.', severity: 'attention', stageIndex: 0, terminal: true };
    case 'EXPIRED':
      return { title: 'Request expired', body: 'This processing request expired before a node accepted it.', severity: 'attention', stageIndex: 0, terminal: true };
    case 'CANCELLED':
      return { title: 'Cancelled', body: 'Processing was stopped. Your capture is unchanged.', severity: 'neutral', stageIndex: 0, terminal: true };
    case 'DISPUTED':
      return { title: 'Result not verified', body: 'The returned result failed verification and was not accepted.', severity: 'critical', stageIndex: 7, terminal: true };
    case 'FAILED':
      return { title: 'Processing stopped', body: 'The provider node became unavailable before reconstruction finished. Your original capture is still available.', severity: 'critical', stageIndex: 0, terminal: true };
    default:
      return { title: 'Working', body: 'Processing on the Kubus network.', severity: 'neutral', stageIndex: 0, terminal: false };
  }
}

/* -------------------------------------------------------------------------- */
/* Errors                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * API/runtime codes → operator language. The raw code is still available to the
 * UI so it can be shown under "Technical details", but it is never the headline.
 */
const ERROR_MESSAGES: Record<string, string> = {
  NETWORK_PARTICIPATION_REQUIRED: 'Network participation required',
  NO_COMPATIBLE_PROVIDER: 'No compatible network GPU is currently available.',
  COMPUTE_JOB_EXPIRED: 'This processing request expired before a node accepted it.',
  PAYLOAD_RETRIEVAL_FAILED: 'The processing node could not retrieve the encrypted capture.',
  local_api_disabled: 'The local API is turned off on this node.',
  lan_api_disabled: 'This node only accepts connections from the computer it runs on.',
  browser_origin_not_allowed: 'The local API cannot be reached from a web browser.',
  local_credential_required: 'This device is not connected to the node.',
  scope_required: 'This device does not have permission for that action.',
  invalid_pairing_session: 'That pairing code is not valid.',
  pairing_session_expired: 'That pairing code has expired. Generate a new one.',
  pairing_session_replayed: 'That pairing code has already been used.',
  invalid_pairing_secret: 'That pairing code is not valid.',
  pairing_activation_required: 'Start pairing from the node itself.',
  worker_unavailable: 'The spatial worker is not running on this node.',
  worker_unsupported: 'This node cannot process that capture type.',
  worker_failed: 'The spatial worker stopped before finishing.',
  worker_output_invalid: 'The spatial worker returned an unusable result.',
  job_capture_required: 'Select a capture to process.',
  job_type_unsupported: 'That processing type is not supported.',
  job_not_found: 'That processing job no longer exists.',
  capture_not_found: 'That capture is no longer stored on this node.',
  spatial_not_found: 'That spatial archive no longer exists on this node.',
  backend_authorization_required: 'Sign in to art.kubus to publish.',
  request_too_large: 'That capture is too large to send to this node.',
  cid_invalid: 'That archive reference is not valid.',
  json_invalid: 'The node could not read that request.',
  local_route_not_found: 'This node does not support that action.',
};

export interface TranslatedError {
  message: string;
  /** Raw code, for the "Technical details" disclosure only. */
  code: string | null;
  severity: Severity;
}

export function translateError(code: string | null | undefined, fallback = 'Something went wrong on this node.'): TranslatedError {
  const key = String(code || '');
  const message = ERROR_MESSAGES[key];
  if (message) {
    return { message, code: key, severity: key === 'NETWORK_PARTICIPATION_REQUIRED' ? 'attention' : 'critical' };
  }
  return { message: fallback, code: key || null, severity: 'critical' };
}

/* -------------------------------------------------------------------------- */
/* Formatting                                                                 */
/* -------------------------------------------------------------------------- */

const BYTE_UNITS = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];

/**
 * Storage is shown in whole human units. Operators allocate "50 GB", never
 * "53687091200 bytes" (§45).
 */
export function formatBytes(bytes: number | null | undefined): string {
  const value = Number(bytes || 0);
  if (!Number.isFinite(value) || value <= 0) return '0 B';
  const exponent = Math.min(Math.floor(Math.log(value) / Math.log(1024)), BYTE_UNITS.length - 1);
  const scaled = value / 1024 ** exponent;
  // One decimal below 100 keeps "12.4 GB" precise without becoming noisy.
  const digits = exponent === 0 ? 0 : scaled >= 100 ? 0 : 1;
  return `${scaled.toFixed(digits)} ${BYTE_UNITS[exponent]}`;
}

/** Ratios arrive as 0..1 fractions from the runtime. */
export function formatPercent(fraction: number | null | undefined, digits = 1): string {
  const value = Number(fraction || 0);
  if (!Number.isFinite(value)) return '0%';
  const percent = Math.max(0, Math.min(1, value)) * 100;
  return `${percent.toFixed(percent >= 99.95 || Number.isInteger(percent) ? 0 : digits)}%`;
}

/** KUB8 is a contribution record, not a price. Fixed precision, no currency. */
export function formatKub8(value: number | null | undefined): string {
  const amount = Number(value || 0);
  if (!Number.isFinite(amount)) return '0.00';
  return amount.toFixed(2);
}

/**
 * Technical identifiers (peer IDs, CIDs, hashes) are truncated in the middle so
 * both ends stay recognisable. Always paired with a copy control in the UI.
 */
export function shortId(value: string | null | undefined, head = 8, tail = 6): string {
  const text = String(value || '');
  if (!text) return '—';
  if (text.length <= head + tail + 3) return text;
  return `${text.slice(0, head)}…${text.slice(-tail)}`;
}

/** "4 min ago" / "just now". Absolute timestamps stay in technical detail views. */
export function formatRelativeTime(iso: string | null | undefined, now = Date.now()): string {
  if (!iso) return 'never';
  const timestamp = Date.parse(iso);
  if (!Number.isFinite(timestamp)) return 'unknown';
  const seconds = Math.round((now - timestamp) / 1000);
  if (seconds < 45) return 'just now';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  return `${Math.round(hours / 24)} d ago`;
}

/** Countdown for pairing codes: "04:32". */
export function formatCountdown(expiresAt: string | null | undefined, now = Date.now()): string {
  const timestamp = Date.parse(String(expiresAt || ''));
  if (!Number.isFinite(timestamp)) return '00:00';
  const remaining = Math.max(0, Math.floor((timestamp - now) / 1000));
  const minutes = String(Math.floor(remaining / 60)).padStart(2, '0');
  const seconds = String(remaining % 60).padStart(2, '0');
  return `${minutes}:${seconds}`;
}

/* -------------------------------------------------------------------------- */
/* HTML safety                                                                */
/* -------------------------------------------------------------------------- */

/**
 * The GUI builds markup as strings, and much of what it renders originates
 * off-node (backend error text, pin failure reasons, log lines). Everything
 * interpolated into markup goes through this first.
 */
export function escapeHtml(value: unknown): string {
  if (value === null || value === undefined) return '';
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Escaping for values placed inside a quoted HTML attribute. */
export function escapeAttribute(value: unknown): string {
  return escapeHtml(value);
}
