import { describe, expect, it } from 'vitest';
import { validateComputeProviderSettings } from '../src/compute/providerSettings.js';

const current = {
  enabled: false,
  paused: false,
  maxConcurrency: 1,
  maxQueueDepth: 2,
  maxAcceptedInputBytes: 1024 * 1024,
  minimumFreeVramBytes: 0,
};

describe('compute provider settings', () => {
  it('supports explicit optional GPU sharing and pause controls', () => {
    expect(validateComputeProviderSettings({ enabled: true, paused: true, maxConcurrency: 3 }, current)).toMatchObject({
      enabled: true,
      paused: true,
      maxConcurrency: 3,
    });
  });

  it('rejects unbounded concurrency and undersized payload limits', () => {
    expect(() => validateComputeProviderSettings({ maxConcurrency: 17 }, current)).toThrow('compute_setting_maxConcurrency_invalid');
    expect(() => validateComputeProviderSettings({ maxAcceptedInputBytes: 1 }, current)).toThrow('compute_setting_maxAcceptedInputBytes_invalid');
  });
});
