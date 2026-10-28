import { describe, expect, it, vi, afterEach } from 'vitest';
import { KuboClient } from '../src/ipfs/kuboClient.js';
import { syntheticCid } from './fixtures/contentIds.js';
import { canonicalPinCid } from '../src/utils/cid.js';

afterEach(() => vi.restoreAllMocks());

describe('KuboClient', () => {
  it('normalizes RPC URL and calls id', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ ID: 'peer' })));
    const client = new KuboClient('http://kubo:5001');
    await expect(client.id()).resolves.toEqual({ ID: 'peer' });
    expect(fetchMock).toHaveBeenCalledWith('http://kubo:5001/api/v0/id', expect.objectContaining({ method: 'POST' }));
  });
  it('allows an explicitly unpinned import while preserving the existing default', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response(JSON.stringify({ Hash: 'synthetic-import' })));
    const client = new KuboClient('http://kubo:5001');
    await client.addBytes(new Uint8Array([1]), 'synthetic.bin', { pin: false });
    await client.addBytes(new Uint8Array([1]), 'synthetic.bin');
    expect(new URL(String(fetchMock.mock.calls[0]?.[0])).searchParams.get('pin')).toBe('false');
    expect(new URL(String(fetchMock.mock.calls[1]?.[0])).searchParams.get('pin')).toBe('true');
  });
  it('can include direct and indirect pins when checking prior ownership', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{"Keys":{}}'));
    await new KuboClient('http://kubo:5001').pinLs(undefined, 'all');
    expect(new URL(String(fetchMock.mock.calls[0]?.[0])).searchParams.get('type')).toBe('all');
  });
  it('finds a new canonical pin through an existing v0 record without changing legacy discovery', async () => {
    const cid = syntheticCid('legacy-url-new-pin');
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response('not pinned or pinned indirectly', { status: 500 }))
      .mockResolvedValueOnce(new Response('{"Keys":{}}'));
    await new KuboClient('http://kubo:5001').pinLs(cid);
    expect(new URL(String(fetchMock.mock.calls[0]?.[0])).searchParams.get('arg')).toBe(cid);
    expect(new URL(String(fetchMock.mock.calls[1]?.[0])).searchParams.get('arg')).toBe(canonicalPinCid(cid));
  });
  it('does not hide unrelated pin-list transport failures behind alias retries', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('RPC route unavailable', { status: 404 }));
    await expect(new KuboClient('http://kubo:5001').pinLs(syntheticCid('unavailable'))).rejects.toThrow('HTTP 404');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
