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
});
