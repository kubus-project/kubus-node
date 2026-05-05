import { describe, expect, it, vi, afterEach } from 'vitest';
import { KubusApiClient, KubusApiError } from '../src/backend/kubusApiClient.js';
import { BearerAuthProvider } from '../src/backend/operatorAuth.js';

afterEach(() => vi.restoreAllMocks());

describe('KubusApiClient', () => {
  it('constructs bearer requests and unwraps data', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ success: true, data: { ok: true } })));
    const client = new KubusApiClient({ baseUrl: 'http://api.test', auth: new BearerAuthProvider('secret'), retries: 0 });
    await expect(client.getCurrentNode()).resolves.toEqual({ ok: true });
    expect(fetchMock).toHaveBeenCalledWith('http://api.test/api/availability/nodes/current', expect.objectContaining({
      headers: expect.objectContaining({ Authorization: 'Bearer secret' }),
    }));
  });

  it('does not retry validation failures', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ success: false, error: 'bad' }), { status: 400 }));
    const client = new KubusApiClient({ baseUrl: 'http://api.test', auth: new BearerAuthProvider('secret'), retries: 2 });
    await expect(client.getCurrentNode()).rejects.toBeInstanceOf(KubusApiError);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('fetches the public pin set separately from rewardable cids', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({
      success: true,
      data: {
        count: 1,
        records: [{ id: 'cid-1', cid: 'bafymanifest', role: 'manifest', isRewardable: false }],
      },
    })));
    const client = new KubusApiClient({ baseUrl: 'http://api.test', auth: new BearerAuthProvider('secret'), retries: 0 });

    await expect(client.getPublicPinSet({ limit: 25, entityType: 'artwork' })).resolves.toMatchObject({
      count: 1,
      records: [{ cid: 'bafymanifest', role: 'manifest' }],
    });
    expect(fetchMock).toHaveBeenCalledWith(
      'http://api.test/api/availability/public-pin-set?limit=25&entityType=artwork',
      expect.objectContaining({ method: 'GET' }),
    );
  });
});
