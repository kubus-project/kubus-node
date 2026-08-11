import { describe, expect, it } from 'vitest';
import {
  describeGpu,
  describeLocalJob,
  describeParticipation,
  describeRemoteJob,
  describeRequirements,
  describeWorker,
  escapeHtml,
  formatBytes,
  formatCountdown,
  formatKub8,
  formatPercent,
  formatRelativeTime,
  shortId,
  translateError,
  worstSeverity,
  LOCAL_JOB_STAGES,
  REMOTE_JOB_STAGES,
  RECIPROCITY_EXPLANATION,
} from '../src/gui/presentation.js';
import type { SpatialWorkerHealth } from '../src/capabilities/registry.js';

describe('participation language', () => {
  it('translates every runtime state without leaking enum names', () => {
    for (const state of ['UNCONFIGURED', 'JOINING', 'CONTRIBUTING', 'DEGRADED', 'LOCKED'] as const) {
      const described = describeParticipation({ state });
      expect(described.title).toBeTruthy();
      expect(described.body).toBeTruthy();
      expect(described.title).not.toContain('_');
      expect(described.title).not.toBe(state);
    }
  });

  it('frames the gate as reciprocity rather than denial', () => {
    const locked = describeParticipation({ state: 'LOCKED' });
    expect(locked.title).toBe('Network participation required');
    // The product rule: never DRM language, never blame.
    expect(locked.title.toLowerCase()).not.toContain('denied');
    expect(locked.body.toLowerCase()).not.toContain('violation');
    expect(locked.body.toLowerCase()).not.toContain('must');
    expect(locked.action?.section).toBe('diagnostics');
    expect(RECIPROCITY_EXPLANATION).toContain('while your node contributes');
  });

  it('marks a healthy node good and an interrupted node attention, not critical', () => {
    expect(describeParticipation({ state: 'CONTRIBUTING' }).severity).toBe('good');
    expect(describeParticipation({ state: 'DEGRADED' }).severity).toBe('attention');
    expect(describeParticipation({ state: 'LOCKED' }).severity).toBe('attention');
  });

  it('lists unmet requirements first and hides unknown keys', () => {
    const rows = describeRequirements({ kuboHealthy: true, heartbeatAccepted: false, somethingNew: false });
    expect(rows.map((row) => row.key)).toEqual(['heartbeatAccepted', 'kuboHealthy']);
    expect(rows[0]!.label).toBe('Recent heartbeat accepted by the network');
  });
});

describe('spatial worker language', () => {
  const worker = (overrides: Partial<SpatialWorkerHealth>): SpatialWorkerHealth => ({
    status: 'unavailable',
    gpu: { available: false },
    capabilities: [],
    ...overrides,
  });

  it('answers "can I process right now"', () => {
    expect(describeWorker(worker({ status: 'ready', gpu: { available: true } })).title).toBe('Ready');
    expect(describeWorker(worker({ status: 'unsupported' })).title).toBe('Unavailable');
  });

  it('separates "no GPU" from "GPU present but worker down"', () => {
    const noGpu = describeWorker(worker({ status: 'unavailable' }));
    expect(noGpu.body).toBe('No compatible NVIDIA GPU detected.');
    expect(noGpu.severity).toBe('neutral');

    const workerDown = describeWorker(worker({ status: 'unavailable', gpu: { available: true, model: 'RTX 3080 Ti' } }));
    expect(workerDown.title).toBe('Worker unavailable');
    expect(workerDown.severity).toBe('attention');
  });

  it('formats a GPU summary and returns null when there is nothing to say', () => {
    expect(describeGpu(worker({ gpu: { available: true, model: 'RTX 3080 Ti', totalVramBytes: 12 * 1024 ** 3 } }))).toBe('RTX 3080 Ti · 12.0 GB');
    expect(describeGpu(worker({ gpu: { available: false } }))).toBeNull();
  });
});

describe('job progress language', () => {
  it('uses determinate progress locally only while the worker reports it', () => {
    expect(describeLocalJob({ state: 'queued' }).determinate).toBe(false);
    expect(describeLocalJob({ state: 'running', progress: 0.5 }).determinate).toBe(true);
    expect(describeLocalJob({ state: 'completed' }).title).toBe('Complete');
  });

  it('reassures the operator that the source capture survives a failure', () => {
    const failed = describeLocalJob({ state: 'failed' });
    expect(failed.severity).toBe('critical');
    expect(failed.body).toContain('still available');
  });

  it('maps every backend compute state onto a named stage', () => {
    const states = ['REQUESTED', 'MATCHED', 'ACCEPTED', 'INPUT_READY', 'RUNNING', 'OUTPUT_READY', 'VERIFYING', 'VERIFIED', 'COMPLETED'];
    for (const state of states) {
      const described = describeRemoteJob(state);
      expect(REMOTE_JOB_STAGES).toContain(described.title);
      expect(described.stageIndex).toBeGreaterThanOrEqual(0);
    }
    expect(describeRemoteJob('COMPLETED').terminal).toBe(true);
    expect(describeRemoteJob('RUNNING').terminal).toBe(false);
  });

  it('gives each terminal failure its own honest explanation', () => {
    expect(describeRemoteJob('EXPIRED').title).toBe('Request expired');
    expect(describeRemoteJob('DECLINED').severity).toBe('attention');
    expect(describeRemoteJob('DISPUTED').severity).toBe('critical');
    expect(describeRemoteJob('FAILED').body).toContain('still available');
    for (const state of ['EXPIRED', 'DECLINED', 'DISPUTED', 'FAILED', 'CANCELLED']) {
      expect(describeRemoteJob(state).terminal).toBe(true);
    }
  });

  it('never renders a raw state string for an unknown state', () => {
    const unknown = describeRemoteJob('SOME_FUTURE_STATE');
    expect(unknown.title).toBe('Working');
    expect(unknown.title).not.toContain('_');
  });

  it('keeps the local pipeline shorter than the remote pipeline', () => {
    expect(LOCAL_JOB_STAGES.length).toBeLessThan(REMOTE_JOB_STAGES.length);
  });
});

describe('error translation', () => {
  it('replaces documented API codes with operator language', () => {
    expect(translateError('NETWORK_PARTICIPATION_REQUIRED').message).toBe('Network participation required');
    expect(translateError('NO_COMPATIBLE_PROVIDER').message).toBe('No compatible network GPU is currently available.');
    expect(translateError('COMPUTE_JOB_EXPIRED').message).toContain('expired before a node accepted it');
    expect(translateError('PAYLOAD_RETRIEVAL_FAILED').message).toContain('could not retrieve the encrypted capture');
  });

  it('keeps the raw code for technical disclosure but never in the message', () => {
    const translated = translateError('worker_unavailable');
    expect(translated.code).toBe('worker_unavailable');
    expect(translated.message).not.toContain('worker_unavailable');
  });

  it('falls back to plain language for unknown codes', () => {
    const translated = translateError('brand_new_code');
    expect(translated.message).toBe('Something went wrong on this node.');
    expect(translated.code).toBe('brand_new_code');
  });

  it('treats the participation gate as attention, not failure', () => {
    expect(translateError('NETWORK_PARTICIPATION_REQUIRED').severity).toBe('attention');
    expect(translateError('worker_failed').severity).toBe('critical');
  });
});

describe('formatting', () => {
  it('formats bytes in human units', () => {
    expect(formatBytes(0)).toBe('0 B');
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(12.4 * 1024 ** 3)).toBe('12.4 GB');
    expect(formatBytes(820 * 1024 ** 3)).toBe('820 GB');
  });

  it('formats coverage without spurious decimals', () => {
    expect(formatPercent(0.986)).toBe('98.6%');
    expect(formatPercent(1)).toBe('100%');
    expect(formatPercent(0)).toBe('0%');
  });

  it('formats KUB8 as a contribution record, not a price', () => {
    expect(formatKub8(14.123)).toBe('14.12');
    expect(formatKub8(null)).toBe('0.00');
  });

  it('truncates technical identifiers in the middle', () => {
    expect(shortId('bafybeigdyrztktx5c6xk4dvbrgm2h5r5ojqsvrxjvhqvbn3lqvzq')).toMatch(/^bafybeig….{6}$/);
    expect(shortId('short')).toBe('short');
    expect(shortId(null)).toBe('—');
  });

  it('formats relative times and pairing countdowns', () => {
    const now = Date.parse('2026-08-11T12:00:00.000Z');
    expect(formatRelativeTime('2026-08-11T11:56:00.000Z', now)).toBe('4 min ago');
    expect(formatRelativeTime(null)).toBe('never');
    expect(formatCountdown('2026-08-11T12:04:32.000Z', now)).toBe('04:32');
    expect(formatCountdown('2026-08-11T11:00:00.000Z', now)).toBe('00:00');
  });
});

describe('severity and HTML safety', () => {
  it('surfaces the most urgent status', () => {
    expect(worstSeverity(['good', 'neutral', 'attention'])).toBe('attention');
    expect(worstSeverity(['good', 'critical', 'attention'])).toBe('critical');
    expect(worstSeverity([])).toBe('neutral');
  });

  it('escapes markup from off-node strings', () => {
    // Pin failures and log lines originate outside the node and land in innerHTML.
    expect(escapeHtml('<img src=x onerror="alert(1)">')).toBe('&lt;img src=x onerror=&quot;alert(1)&quot;&gt;');
    expect(escapeHtml("it's")).toBe('it&#39;s');
    expect(escapeHtml(null)).toBe('');
  });
});
