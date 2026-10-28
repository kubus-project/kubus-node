import { describe, expect, it, vi, afterEach } from 'vitest';
import { KuboClient } from '../src/ipfs/kuboClient.js';

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
});
