import { describe, expect, it, vi, afterEach } from 'vitest';
import { KuboClient } from '../src/ipfs/kuboClient.js';
import { syntheticCid } from './fixtures/contentIds.js';
import { canonicalPinCid } from '../src/utils/cid.js';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';

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
  it('marks network loss, incomplete responses and gateway errors as uncertain unpin outcomes', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockRejectedValueOnce(new Error('synthetic network loss'))
      .mockResolvedValueOnce(new Response('upstream timeout', { status: 504 }))
      .mockResolvedValueOnce(new Response('invalid success JSON', { status: 200 }));
    const client = new KuboClient('http://kubo:5001');
    for (let i = 0; i < 3; i++) await expect(client.pinRm(syntheticCid('outcome-unknown'))).rejects.toMatchObject({ outcomeUncertain: true, message: 'kubo_pin_release_outcome_uncertain' });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });
  it('distinguishes a completed direct RPC rejection from an unknown outcome', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('not pinned', { status: 500 }));
    await expect(new KuboClient('http://kubo:5001').pinRm(syntheticCid('absent-pin'))).rejects.toMatchObject({ kuboResponseComplete: true });
  });
  it('does not assume a client timeout stopped a still-running server operation', async () => {
    let finish: (() => void) | undefined;
    let completed = 0;
    const server = createServer((_request, response) => {
      finish = () => { completed++; response.end('{"Pins":[]}'); };
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    try {
      const client = new KuboClient(`http://127.0.0.1:${(server.address() as AddressInfo).port}`, 1000);
      const outcome = expect(client.pinRm(syntheticCid('delayed-synthetic-unpin'))).rejects.toMatchObject({ outcomeUncertain: true });
      await vi.waitFor(() => expect(finish).toBeTypeOf('function'));
      await outcome;
      expect(completed).toBe(0);
      finish!();
      expect(completed).toBe(1);
    } finally {
      server.closeAllConnections();
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
  });
});
