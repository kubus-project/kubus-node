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

  describe('hasAllBlocksLocally', () => {
    // Bodies below are what Kubo 0.43.0 actually sent for these situations;
    // each came back as HTTP 200.
    const CID = 'Qma4THUwvRb9YAZ4EJ88fRUGpCxgpnAd7aDE1bUq7qhhTn';
    const ndjson = (...lines: unknown[]) => new Response(lines.map((line) => JSON.stringify(line)).join('\n') + '\n', { status: 200 });

    it('is true when every ref streams without an error', async () => {
      vi.spyOn(globalThis, 'fetch').mockResolvedValue(ndjson({ Ref: 'Qmd7UC', Err: '' }, { Ref: 'QmZLRF', Err: '' }));
      await expect(new KuboClient('http://kubo:5001').hasAllBlocksLocally(CID)).resolves.toBe(true);
    });

    it('is true for a single-block CID, which streams no refs at all', async () => {
      vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('', { status: 200 }));
      await expect(new KuboClient('http://kubo:5001').hasAllBlocksLocally(CID)).resolves.toBe(true);
    });

    it('is false when the root block is gone, although Kubo answered 200', async () => {
      vi.spyOn(globalThis, 'fetch').mockResolvedValue(ndjson({ Ref: '', Err: `block was not found locally (offline): ipld: could not find ${CID}` }));
      await expect(new KuboClient('http://kubo:5001').hasAllBlocksLocally(CID)).resolves.toBe(false);
    });

    it('is false when the root survived but its files did not (a hollow bundle)', async () => {
      vi.spyOn(globalThis, 'fetch').mockResolvedValue(ndjson({ Ref: '', Err: 'failed to fetch all nodes' }));
      await expect(new KuboClient('http://kubo:5001').hasAllBlocksLocally(CID)).resolves.toBe(false);
    });

    it('is false when an error follows good refs, an HTTP error, a non-JSON line or a transport failure', async () => {
      const client = new KuboClient('http://kubo:5001');
      vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(ndjson({ Ref: 'Qm1', Err: '' }, { Ref: 'Qm2', Err: 'context deadline exceeded' }));
      await expect(client.hasAllBlocksLocally(CID)).resolves.toBe(false);
      vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(new Response('{"Message":"nope"}', { status: 500 }));
      await expect(client.hasAllBlocksLocally(CID)).resolves.toBe(false);
      vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(new Response('{"Ref":"Qm1","Err":""}\n{"Ref":"Qm2","Er', { status: 200 }));
      await expect(client.hasAllBlocksLocally(CID)).resolves.toBe(false);
      vi.spyOn(globalThis, 'fetch').mockRejectedValueOnce(new Error('connection reset'));
      await expect(client.hasAllBlocksLocally(CID)).resolves.toBe(false);
    });

    it('asks offline and recursively, so it can neither fetch from the network nor stop at the root', async () => {
      const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('', { status: 200 }));
      await new KuboClient('http://kubo:5001').hasAllBlocksLocally(CID);
      const url = new URL(String(fetchMock.mock.calls[0]![0]));
      expect(url.pathname).toBe('/api/v0/refs');
      expect(Object.fromEntries(url.searchParams)).toMatchObject({ arg: CID, recursive: 'true', offline: 'true' });
    });
  });

  describe('bundle helpers', () => {
    const ROOT = 'QmRPWQYEcANkuhUjxcbr1tApnGSHrqw1vkWM29tF7eBb2d';

    it('stats a file inside a bundle by its path under the root and returns its own hash and size', async () => {
      const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ Hash: 'QmFile', Size: 300000, CumulativeSize: 300400, Type: 'file' }), { status: 200 }));
      await expect(new KuboClient('http://kubo:5001').fileStat(ROOT, 'scene-0.radc')).resolves.toEqual({ hash: 'QmFile', sizeBytes: 300000, type: 'file' });
      expect(new URL(String(fetchMock.mock.calls[0]![0])).searchParams.get('arg')).toBe(`/ipfs/${ROOT}/scene-0.radc`);
    });

    it('reports an absent file as null, but surfaces any other failure', async () => {
      const client = new KuboClient('http://kubo:5001');
      vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(new Response('{"Message":"file does not exist","Code":0,"Type":"error"}', { status: 500 }));
      await expect(client.fileStat(ROOT, 'nope.bin')).resolves.toBeNull();
      vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(new Response('{"Message":"datastore is on fire"}', { status: 500 }));
      await expect(client.fileStat(ROOT, 'scene.rad')).rejects.toThrow(/files\/stat failed/);
    });

    it('rejects a name outside the bundle grammar without making a request', async () => {
      const fetchMock = vi.spyOn(globalThis, 'fetch');
      const client = new KuboClient('http://kubo:5001');
      for (const name of ['../x', 'a/b', '..', '.hidden', '', 'x\u0000y']) {
        await expect(client.fileStat(ROOT, name), name).rejects.toThrow('kubo_bundle_name_invalid');
        await expect(client.catStream(ROOT, undefined, name), name).rejects.toThrow('kubo_bundle_name_invalid');
      }
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('reads a ranged inner file through the bundle path with offset and length', async () => {
      const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('abc', { status: 200 }));
      await new KuboClient('http://kubo:5001').catStream(ROOT, { offset: 10, length: 20 }, 'scene-0.radc');
      expect(Object.fromEntries(new URL(String(fetchMock.mock.calls[0]![0])).searchParams)).toMatchObject({ arg: `/ipfs/${ROOT}/scene-0.radc`, offset: '10', length: '20' });
    });
  });
});
