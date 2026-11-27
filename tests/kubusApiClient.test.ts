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

  it('posts a provider cleanup attestation to the cleanup route of its job with the node id', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ success: true, data: { accepted: true } })));
    const client = new KubusApiClient({ baseUrl: 'http://api.test', auth: new BearerAuthProvider('secret'), retries: 0 });
    const body = { nodeId: 'node-1', attestation: { payload: { jobId: 'job-1' }, signature: 'sig' } };
    await client.submitProviderCleanupAttestation('job-1', body);
    expect(fetchMock).toHaveBeenCalledWith('http://api.test/api/compute/provider/jobs/job-1/cleanup', expect.objectContaining({
      method: 'POST', body: JSON.stringify(body), headers: expect.objectContaining({ Authorization: 'Bearer secret' }),
    }));
  });

  it('sends a candidate chunk for the full file by default and for the lightweight with variant=lightweight', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response(JSON.stringify({ success: true, data: { reconstruction: {}, candidate: { state: 'uploading', receivedBytes: 3 } } })));
    const client = new KubusApiClient({ baseUrl: 'http://api.test', auth: new BearerAuthProvider('secret'), retries: 0 });
    await client.appendReconstructionCandidate('rec-1', 0, Buffer.from('abc'), 'node-1');
    await client.appendReconstructionCandidate('rec-1', 7, Buffer.from('abc'), 'node-1', 'lightweight');
    expect(fetchMock.mock.calls.map(call => call[0])).toEqual([
      'http://api.test/api/spatial/reconstruction-bridge/rec-1/candidate/chunks/0?nodeId=node-1',
      'http://api.test/api/spatial/reconstruction-bridge/rec-1/candidate/chunks/7?nodeId=node-1&variant=lightweight',
    ]);
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
