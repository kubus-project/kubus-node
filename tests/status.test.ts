import { describe, expect, it } from 'vitest';
import { buildStatusSummary } from '../src/operator/status.js';
import type { AppConfig } from '../src/config/schema.js';

describe('buildStatusSummary', () => {
  it('uses local state without backend', () => {
    const summary = buildStatusSummary({ apiBaseUrl: 'http://api', operatorWallet: 'wallet' } as AppConfig, {
      version: 1,
      nodeKey: 'kubus-node-abcdef123456',
      nodeId: 'node',
      publicPinSet: [],
      rewardableCids: [],
      desiredCids: [],
      pinnedCids: [],
      failedCids: {},
      activeCommitments: [],
    });
    expect(summary.registered).toBe(true);
    expect(summary.nodeKeyFingerprint).toHaveLength(16);
    expect(JSON.stringify(summary)).not.toContain('abcdef');
    expect(summary.backendHealth).toBe('not_checked');
    expect(summary.publicPinSetCount).toBe(0);
  });
});
