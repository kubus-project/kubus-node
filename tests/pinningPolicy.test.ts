import { afterEach, describe, expect, it, vi } from 'vitest';
import { planPublicPins } from '../src/operator/commitments.js';
import { reconcilePins } from '../src/ipfs/pinning.js';
import type { PublicPinSetRecord } from '../src/backend/models.js';
import crypto from 'node:crypto';
import { CID } from 'multiformats/cid';
import * as digest from 'multiformats/hashes/digest';

const fixtureCid = (text: string) => CID.createV0(digest.create(0x12, crypto.createHash('sha256').update(text).digest())).toString();
const validCid = fixtureCid('synthetic-valid');
const otherCid = fixtureCid('synthetic-other');

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
      pinAdd: vi.fn(async () => { events.push('kubo'); }).mockRejectedValueOnce(new Error('not found')),
      addBytes: vi.fn(async () => { events.push('add'); return { Hash: CID.parse(validCid).toV1().toString() }; }),
    };
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => { events.push('http'); return new Response(new Uint8Array([1])); });
    const result = await reconcilePins(kubo as never, [{ id: '1', cid: validCid, role: 'record' }], false, 'http://api.test');
    expect(kubo.pinAdd).toHaveBeenCalledTimes(2);
    expect(kubo.addBytes).toHaveBeenCalledWith(expect.any(Uint8Array), `${validCid}.bin`, { pin: false });
    expect(events).toEqual(['http', 'add', 'kubo']);
    expect(result[0]?.ok).toBe(true);
  });

  it('rejects fallback bytes whose imported CID does not match', async () => {
    const kubo = { pinAdd: vi.fn(async () => { throw new Error('not found'); }), addBytes: vi.fn(async () => ({ Hash: otherCid })) };
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(new Uint8Array([1])));
    const [result] = await reconcilePins(kubo as never, [{ id: '1', cid: validCid, role: 'record' }], false);
    expect(result?.ok).toBe(false);
    expect(result?.error).toMatch(/hashed to/);
    expect(kubo.pinAdd).toHaveBeenCalledTimes(1);
    expect(kubo.addBytes).toHaveBeenCalledWith(expect.any(Uint8Array), `${validCid}.bin`, { pin: false });
  });

  it('reports a failed verified-content pin instead of treating import as availability', async () => {
    const kubo = { pinAdd: vi.fn(async () => { throw new Error('RPC unavailable'); }), addBytes: vi.fn(async () => ({ Hash: validCid })) };
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(new Uint8Array([1])));
    const [result] = await reconcilePins(kubo as never, [{ id: '1', cid: validCid, role: 'record' }], false);
    expect(result?.ok).toBe(false);
    expect(kubo.pinAdd).toHaveBeenCalledTimes(2);
  });

  it('rejects an invalid content identifier before Kubo or gateway access', async () => {
    const kubo = { pinAdd: vi.fn(), addBytes: vi.fn() };
    const fetch = vi.spyOn(globalThis, 'fetch');
    const [result] = await reconcilePins(kubo as never, [{ id: '1', cid: 'bafyInvalidIdentifier', role: 'record' }]);
    expect(result?.ok).toBe(false);
    expect(kubo.pinAdd).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });
});
