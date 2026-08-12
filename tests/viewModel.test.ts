import { describe, expect, it } from 'vitest';
import type { LocalState } from '../src/state/localStore.js';
import { buildViewModel, overallSeverity, type ViewModelInput } from '../src/gui/viewModel.js';

/**
 * The view model is where machine state becomes what an operator reads, so
 * these tests are about product behaviour rather than plumbing: that a healthy
 * node stays quiet, that unmeasured quantities are absent instead of invented,
 * and that nothing sensitive can reach the page.
 */

const NOW = Date.parse('2026-08-11T12:00:00.000Z');

function state(overrides: Partial<LocalState> = {}): LocalState {
  return {
    version: 1,
    publicPinSet: [],
    rewardableCids: [],
    desiredCids: [],
    pinnedCids: [],
    failedCids: {},
    activeCommitments: [],
    ...overrides,
  } as LocalState;
}

function input(overrides: Partial<ViewModelInput> = {}): ViewModelInput {
  return {
    state: state(),
    participation: { state: 'CONTRIBUTING', reason: 'ok', leaseEligible: true, requirements: {} },
    worker: { status: 'ready', gpu: { available: true, model: 'RTX 3080 Ti', totalVramBytes: 12 * 1024 ** 3 }, capabilities: ['spatial.reconstruct'] },
    jobs: { configured: true, running: 0, queued: 0, concurrency: 1 },
    compute: { enabled: false, paused: false, maxConcurrency: 1, maxQueueDepth: 2, maxAcceptedInputBytes: 1024 ** 3, minimumFreeVramBytes: 2 * 1024 ** 3 },
    storage: { repoBytes: 0, storageMaxBytes: 100 * 1024 ** 3, publicReplicaBytes: 0, privateCaptureBytes: 0, maxPinnedBytes: 50 * 1024 ** 3 },
    health: { backendReachable: true, kuboReachable: true },
    config: {
      nodeLabel: 'ROK-DESKTOP',
      apiBaseUrl: 'https://api.art.kubus',
      maxPinnedCids: 5000,
      cidClassFilters: [],
      localApiEnabled: true,
      localApiAllowLan: false,
      guiRemoteMode: false,
      guiTokenConfigured: true,
      operatorTokenConfigured: true,
    },
    captureCount: 0,
    now: NOW,
    ...overrides,
  };
}

describe('participation language', () => {
  it('translates every runtime state into operator language', () => {
    const cases = [
      ['CONTRIBUTING', 'Contributing', 'good'],
      ['JOINING', 'Joining network', 'neutral'],
      ['DEGRADED', 'Connection interrupted', 'attention'],
      ['LOCKED', 'Network participation required', 'attention'],
      ['UNCONFIGURED', 'Setup required', 'neutral'],
    ] as const;

    for (const [runtimeState, title, severity] of cases) {
      const model = buildViewModel(input({
        participation: { state: runtimeState, reason: '', leaseEligible: runtimeState === 'CONTRIBUTING', requirements: {} },
      }));
      expect(model.participation.title).toBe(title);
      expect(model.participation.severity).toBe(severity);
    }
  });

  it('never uses antagonistic or DRM language when locked', () => {
    const model = buildViewModel(input({
      participation: { state: 'LOCKED', reason: 'runtime gate violation', leaseEligible: false, requirements: {} },
    }));
    const text = (model.participation.title + ' ' + model.participation.body).toLowerCase();
    for (const forbidden of ['denied', 'violation', 'must contribute', 'forbidden', 'unauthorized']) {
      expect(text).not.toContain(forbidden);
    }
    // The raw runtime reason is not what the operator reads.
    expect(text).not.toContain('gate');
    expect(model.participation.action?.label).toBe('Check node status');
  });

  it('explains reciprocity once rather than on every gated control', () => {
    const model = buildViewModel(input());
    expect(model.participation.explanation).toContain('contributes storage and availability');
  });

  it('sorts requirements so unmet checks come first, and drops unknown keys', () => {
    const model = buildViewModel(input({
      participation: {
        state: 'JOINING',
        reason: '',
        leaseEligible: false,
        requirements: { registered: true, kuboHealthy: false, somethingInternal: false },
      },
    }));
    expect(model.participation.requirements.map((item) => item.key)).toEqual(['kuboHealthy', 'registered']);
    expect(model.participation.requirements[0]!.label).toBe('Local storage service running');
  });
});

describe('alerts', () => {
  it('stays silent on a healthy node', () => {
    expect(buildViewModel(input()).alerts).toEqual([]);
  });

  it('ranks a failed dependency above a degraded one', () => {
    const model = buildViewModel(input({
      health: { backendReachable: false, kuboReachable: false },
      participation: { state: 'DEGRADED', reason: '', leaseEligible: true, requirements: {} },
    }));
    expect(model.alerts[0]!.id).toBe('kubo');
    expect(model.alerts[0]!.severity).toBe('critical');
    expect(overallSeverity(model)).toBe('critical');
  });

  it('raises unstored archive records with a count, not a raw code', () => {
    const model = buildViewModel(input({
      state: state({ failedCids: { bafyone: { error: 'context deadline exceeded', at: '2026-08-11T11:00:00.000Z' } } }),
    }));
    const alert = model.alerts.find((item) => item.id === 'pins');
    expect(alert?.title).toBe('1 archive item could not be stored');
    expect(alert?.action?.section).toBe('archive');
  });
});

describe('archive', () => {
  it('reports no coverage figure when the node has nothing to keep yet', () => {
    // "0%" would read as failure; "not started" is the truth.
    const model = buildViewModel(input());
    expect(model.archive.coverage).toBeNull();
    expect(model.archive.coverageLabel).toBeNull();
  });

  it('measures coverage against what the node was asked to keep', () => {
    const model = buildViewModel(input({
      state: state({
        desiredCids: [
          { cid: 'a', role: 'manifest' },
          { cid: 'b', role: 'record' },
          { cid: 'c', role: 'media', isRewardable: true },
          { cid: 'd' },
        ] as never,
        pinnedCids: ['a', 'b', 'c'],
      }),
    }));
    expect(model.archive.coverageLabel).toBe('75%');
    expect(model.archive.records).toBe(3);
    expect(model.archive.roleCounts).toEqual({ manifest: 1, record: 1, media: 1, priority: 1 });
  });

  it('truncates identifiers and keeps the full value for copying', () => {
    const cid = 'bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi';
    const model = buildViewModel(input({
      state: state({ failedCids: { [cid]: { error: 'timeout', at: '2026-08-11T11:00:00.000Z' } } }),
    }));
    expect(model.archive.failures[0]!.cidShort).toContain('…');
    expect(model.archive.failures[0]!.cid).toBe(cid);
    expect(model.archive.failures[0]!.at).toBe('1 h ago');
  });
});

describe('storage', () => {
  it('drops empty segments instead of rendering zero-width slivers', () => {
    const model = buildViewModel(input({
      storage: { repoBytes: 12 * 1024 ** 3, storageMaxBytes: 100 * 1024 ** 3, publicReplicaBytes: 12 * 1024 ** 3, privateCaptureBytes: 0, maxPinnedBytes: 0 },
    }));
    expect(model.storage.segments.map((segment) => segment.key)).toEqual(['public', 'available']);
    expect(model.storage.segments[0]!.value).toBe('12.0 GB');
  });

  it('shows node overhead separately rather than inflating the public figure', () => {
    const model = buildViewModel(input({
      storage: { repoBytes: 14 * 1024 ** 3, storageMaxBytes: 100 * 1024 ** 3, publicReplicaBytes: 12 * 1024 ** 3, privateCaptureBytes: 4 * 1024 ** 3, maxPinnedBytes: 0 },
    }));
    const keys = model.storage.segments.map((segment) => segment.key);
    expect(keys).toEqual(['public', 'private', 'other', 'available']);
    const fractions = model.storage.segments.reduce((sum, segment) => sum + segment.fraction, 0);
    expect(fractions).toBeCloseTo(1, 5);
  });

  it('reports no available figure when no maximum is configured', () => {
    const model = buildViewModel(input({
      storage: { repoBytes: 5 * 1024 ** 3, storageMaxBytes: 0, publicReplicaBytes: 5 * 1024 ** 3, privateCaptureBytes: 0, maxPinnedBytes: 0 },
    }));
    expect(model.storage.availableBytes).toBeNull();
  });
});

describe('spatial', () => {
  it('answers whether a capture can be processed right now', () => {
    const model = buildViewModel(input());
    expect(model.spatial.title).toBe('Ready');
    expect(model.spatial.gpu).toBe('RTX 3080 Ti · 12.0 GB');
  });

  it('never blames the GPU when the worker could not be reached at all', () => {
    const unreachable = buildViewModel(input({ worker: { status: 'unavailable', gpu: { available: false }, capabilities: [] } }));
    expect(unreachable.spatial.title).toBe('Worker unavailable');
    expect(unreachable.spatial.body).toBe('The spatial worker is not responding.');
    expect(unreachable.spatial.severity).toBe('attention');

    const noWorker = buildViewModel(input({ worker: { status: 'unavailable', gpu: { available: true, model: 'RTX 4090' }, capabilities: [] } }));
    expect(noWorker.spatial.title).toBe('Worker unavailable');
    expect(noWorker.spatial.severity).toBe('attention');
  });

  it('only reports incompatible hardware when the worker actually answered', () => {
    const unsupported = buildViewModel(input({ worker: { status: 'unsupported', gpu: { available: false }, capabilities: [] } }));
    expect(unsupported.spatial.title).toBe('GPU unavailable');
    expect(unsupported.spatial.severity).toBe('neutral');
  });

  it('treats a never-configured worker as a neutral setup step', () => {
    const unconfigured = buildViewModel(input({ worker: { status: 'unconfigured', gpu: { available: false }, capabilities: [], detail: 'Spatial worker is not configured' } }));
    expect(unconfigured.spatial.title).toBe('Not configured');
    expect(unconfigured.spatial.severity).toBe('neutral');
  });

  it('keeps driver detail out of the headline', () => {
    const model = buildViewModel(input({
      worker: { status: 'degraded', gpu: { available: true }, capabilities: [], detail: 'CUDA error 999: unknown' },
    }));
    expect(model.spatial.title).not.toContain('CUDA');
    expect(model.spatial.workerDetail).toContain('CUDA');
  });
});

describe('compute sharing', () => {
  it('treats sharing being off as a neutral choice, not a problem', () => {
    const model = buildViewModel(input());
    expect(model.compute.status).toBe('Not sharing');
    expect(model.compute.severity).toBe('neutral');
    expect(model.alerts).toEqual([]);
  });

  it('flags paused sharing so it is not forgotten', () => {
    const model = buildViewModel(input({
      compute: { enabled: true, paused: true, maxConcurrency: 2, maxQueueDepth: 4, maxAcceptedInputBytes: 1024 ** 3, minimumFreeVramBytes: 0 },
    }));
    expect(model.compute.status).toBe('Paused');
    expect(model.compute.severity).toBe('attention');
  });

  it('counts only jobs this node is providing', () => {
    const model = buildViewModel(input({
      state: state({
        remoteJobs: {
          a: { role: 'provider', state: 'COMPLETED' },
          b: { role: 'provider', state: 'RUNNING' },
          c: { role: 'provider', state: 'MATCHED' },
          d: { role: 'requester', state: 'COMPLETED' },
        },
      }),
      compute: { enabled: true, paused: false, maxConcurrency: 2, maxQueueDepth: 4, maxAcceptedInputBytes: 1024 ** 3, minimumFreeVramBytes: 0 },
    }));
    expect(model.compute.completed).toBe(1);
    expect(model.compute.active).toBe(1);
    expect(model.compute.queued).toBe(1);
  });
});

describe('contribution', () => {
  it('shows an empty state rather than a row of zeros', () => {
    const model = buildViewModel(input());
    expect(model.contribution.hasAny).toBe(false);
    expect(model.contribution.settlementActive).toBe(false);
    expect(model.contribution.settlementNote).toContain('Settlement is not yet active');
  });

  it('reports archive and compute contribution separately and as a total', () => {
    const model = buildViewModel(input({
      state: state({
        rewards: { summary: { pendingKub8: 8.42, settledKub8: 0, noRewardEpochs: 0 } } as never,
        computeRewards: { pendingKub8: 5.7, settledKub8: 0 } as never,
      }),
    }));
    expect(model.contribution.archiveKub8).toBe('8.42');
    expect(model.contribution.computeKub8).toBe('5.70');
    expect(model.contribution.pendingKub8).toBe('14.12');
    expect(model.contribution.hasAny).toBe(true);
  });

  it('handles archive-only and compute-only contribution', () => {
    const archiveOnly = buildViewModel(input({
      state: state({ rewards: { summary: { pendingKub8: 3, settledKub8: 0, noRewardEpochs: 0 } } as never }),
    }));
    expect(archiveOnly.contribution.computeKub8).toBe('0.00');
    expect(archiveOnly.contribution.hasAny).toBe(true);

    const computeOnly = buildViewModel(input({
      state: state({ computeRewards: { pendingKub8: 2 } as never }),
    }));
    expect(computeOnly.contribution.archiveKub8).toBe('0.00');
    expect(computeOnly.contribution.hasAny).toBe(true);
  });

  it('marks settlement active once something has settled', () => {
    const model = buildViewModel(input({
      state: state({ rewards: { summary: { pendingKub8: 1, settledKub8: 4, noRewardEpochs: 0 } } as never }),
    }));
    expect(model.contribution.settlementActive).toBe(true);
  });

  it('presents contribution as a record, never as money', () => {
    const model = buildViewModel(input({
      state: state({ rewards: { summary: { pendingKub8: 8.42, settledKub8: 0, noRewardEpochs: 0 } } as never }),
    }));
    const serialized = JSON.stringify(model.contribution).toLowerCase();
    for (const financial of ['usd', 'eur', '$', 'price', 'apy', 'earnings', 'profit']) {
      expect(serialized).not.toContain(financial);
    }
  });
});

describe('devices', () => {
  it('lists connected devices and hides revoked ones', () => {
    const model = buildViewModel(input({
      state: state({
        localCredentials: {
          one: { tokenHash: 'x', label: 'Rok iPhone', scopes: ['captures:read'], createdAt: '2026-08-10T12:00:00.000Z', lastUsedAt: '2026-08-11T11:30:00.000Z' },
          two: { tokenHash: 'y', label: 'Old tablet', scopes: [], createdAt: '2026-01-01T00:00:00.000Z', revokedAt: '2026-02-01T00:00:00.000Z' },
        },
      }),
    }));
    expect(model.devices).toHaveLength(1);
    expect(model.devices[0]!.label).toBe('Rok iPhone');
    expect(model.devices[0]!.lastUsed).toBe('30 min ago');
  });
});

describe('secret safety', () => {
  it('never carries key material or credentials into the view model', () => {
    const model = buildViewModel(input({
      state: state({
        nodeKey: 'kubus-node-secret-key',
        computeIdentity: {
          encryptionPublicKey: 'pub',
          encryptionPrivateKey: 'PRIVATE-ENCRYPTION-KEY',
          signingPublicKey: 'spub',
          signingPrivateKey: 'PRIVATE-SIGNING-KEY',
          createdAt: '2026-01-01T00:00:00.000Z',
        },
        localCredentials: {
          one: { tokenHash: 'HASHED-DEVICE-TOKEN', label: 'Phone', scopes: [], createdAt: '2026-08-10T12:00:00.000Z' },
        },
      }),
    }));
    const serialized = JSON.stringify(model);
    for (const secret of ['kubus-node-secret-key', 'PRIVATE-ENCRYPTION-KEY', 'PRIVATE-SIGNING-KEY', 'HASHED-DEVICE-TOKEN']) {
      expect(serialized).not.toContain(secret);
    }
  });

  it('reports whether credentials are configured without revealing them', () => {
    const model = buildViewModel(input());
    expect(model.advanced.operatorTokenConfigured).toBe(true);
    expect(JSON.stringify(model.advanced)).not.toContain('Bearer');
  });
});

describe('overview', () => {
  it('surfaces the four conceptual areas in a fixed order', () => {
    const model = buildViewModel(input());
    expect(model.overview.map((section) => section.id)).toEqual(['archive', 'spatial', 'compute', 'contribution']);
  });

  it('describes an unstarted archive without alarming language', () => {
    const model = buildViewModel(input());
    const archive = model.overview.find((section) => section.id === 'archive')!;
    expect(archive.severity).toBe('neutral');
    expect(archive.status).toBe('Available');
  });
});
