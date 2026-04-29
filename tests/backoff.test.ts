import { describe, expect, it } from 'vitest';
import { Backoff } from '../src/scheduler/backoff.js';

describe('Backoff', () => {
  it('caps delay and resets after success', () => {
    const backoff = new Backoff(100, 200);
    expect(backoff.failure()).toBeGreaterThanOrEqual(75);
    for (let i = 0; i < 10; i += 1) expect(backoff.failure()).toBeLessThanOrEqual(300);
    backoff.success();
    expect(backoff.failure()).toBeLessThanOrEqual(150);
  });
});
