import { afterEach, describe, expect, it, vi } from 'vitest';
import { planPublicPins } from '../src/operator/commitments.js';
import { reconcilePins } from '../src/ipfs/pinning.js';
import type { PublicPinSetRecord } from '../src/backend/models.js';

afterEach(() => vi.restoreAllMocks());

describe('byte-aware public pinning', () => {
  it('selects hot canonical records before cold large variants deterministically', () => {
    const records: PublicPinSetRecord[] = [
      { id: '3', cid: 'QmCold1111111111111111111111111111111111111111', role: 'spatial_archive', storageClass: 'cold', sizeBytes: 900 },
      { id: '2', cid: 'QmWarm1111111111111111111111111111111111111111', role: 'spatial_mobile', storageClass: 'warm', sizeBytes: 400 },
      { id: '1', cid: 'QmHot11111111111111111111111111111111111111111', role: 'manifest', storageClass: 'hot', sizeBytes: 100 },
    ];
    expect(planPublicPins(records, 10, 500, []).map((item) => item.id)).toEqual(['1', '2']);
  });

  it('attempts native Kubo before HTTP fallback', async () => {
    const events: string[] = [];
    const kubo = {
      pinAdd: vi.fn(async () => { events.push('kubo'); throw new Error('not found'); }),
      addBytes: vi.fn(async () => { events.push('add'); return { Hash: 'QmValid111111111111111111111111111111111111111' }; }),
    };
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => { events.push('http'); return new Response(new Uint8Array([1])); });
    const result = await reconcilePins(kubo as never, [{ id: '1', cid: 'QmValid111111111111111111111111111111111111111', role: 'record' }], false, 'http://api.test');
    expect(events[0]).toBe('kubo');
    expect(events).toContain('http');
    expect(result[0]?.ok).toBe(true);
  });

  it('rejects fallback bytes whose imported CID does not match', async () => {
    const kubo = { pinAdd: vi.fn(async () => { throw new Error('not found'); }), addBytes: vi.fn(async () => ({ Hash: 'QmOther111111111111111111111111111111111111111' })) };
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(new Uint8Array([1])));
    const [result] = await reconcilePins(kubo as never, [{ id: '1', cid: 'QmValid111111111111111111111111111111111111111', role: 'record' }], false);
    expect(result?.ok).toBe(false);
    expect(result?.error).toMatch(/hashed to/);
  });
});
