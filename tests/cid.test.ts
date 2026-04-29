import { describe, expect, it } from 'vitest';
import { normalizeCid } from '../src/utils/cid.js';

describe('CID helpers', () => {
  it('normalizes ipfs URI input', () => {
    expect(normalizeCid('ipfs://bafybeigdyrzt/path')).toBe('bafybeigdyrzt');
  });

  it('rejects invalid values', () => {
    expect(() => normalizeCid('bad cid')).toThrow(/Invalid CID/);
  });
});
