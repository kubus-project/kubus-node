import { afterEach, describe, expect, it, vi } from 'vitest';
import { probeRetrieval, RETRIEVAL_AVAILABLE_STATES } from '../src/ipfs/retrieval.js';
import type { KuboClient } from '../src/ipfs/kuboClient.js';

const CID = 'bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi';
const GATEWAY = 'https://gateway.example.test';

function kubo(overrides: Partial<{ pinLs: () => Promise<unknown>; blockStat: () => Promise<unknown> }> = {}): KuboClient {
  return {
    pinLs: overrides.pinLs ?? (() => Promise.reject(new Error('not pinned'))),
    blockStat: overrides.blockStat ?? (() => Promise.reject(new Error('not local'))),
  } as unknown as KuboClient;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('probeRetrieval — typed states never collapse a transport failure into "missing"', () => {
  it('invalid_cid for something that is not CID-shaped', async () => {
    const probe = await probeRetrieval(kubo(), GATEWAY, 'not a cid!!');
    expect(probe.state).toBe('invalid_cid');
  });

  it('pinned when the local pin set has it', async () => {
    const probe = await probeRetrieval(kubo({ pinLs: () => Promise.resolve({}) }), GATEWAY, CID);
    expect(probe.state).toBe('pinned');
  });

  it('local_retrievable when not pinned but the local block exists', async () => {
    const probe = await probeRetrieval(kubo({ blockStat: () => Promise.resolve({}) }), GATEWAY, CID);
    expect(probe.state).toBe('local_retrievable');
  });

  it('gateway_retrievable when the gateway answers 200/206', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 200 })));
    const probe = await probeRetrieval(kubo(), GATEWAY, CID);
    expect(probe.state).toBe('gateway_retrievable');
  });

  it('gateway_not_found is distinct from a generic HTTP error — the gateway answered', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 404 })));
    const probe = await probeRetrieval(kubo(), GATEWAY, CID);
    expect(probe.state).toBe('gateway_not_found');
    expect(probe.httpStatus).toBe(404);
  });

  it('gateway_http_error for a non-404 failure status', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 503 })));
    const probe = await probeRetrieval(kubo(), GATEWAY, CID);
    expect(probe.state).toBe('gateway_http_error');
    expect(probe.httpStatus).toBe(503);
  });

  it('gateway_timeout for the probe\'s own abort — not "missing"', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init?: { signal?: AbortSignal }) => {
        return new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => {
            const err = new Error('The operation was aborted');
            err.name = 'AbortError';
            reject(err);
          });
        });
      }),
    );
    vi.useFakeTimers();
    const probePromise = probeRetrieval(kubo(), GATEWAY, CID);
    await vi.advanceTimersByTimeAsync(5000);
    const probe = await probePromise;
    expect(probe.state).toBe('gateway_timeout');
  });

  it('gateway_unreachable for a DNS/connection-level failure — not "missing", not a false positive for content absence', async () => {
    const dnsFailure = Object.assign(new TypeError('fetch failed'), {
      cause: { code: 'ENOTFOUND' },
    });
    vi.stubGlobal('fetch', vi.fn(async () => { throw dnsFailure; }));
    const probe = await probeRetrieval(kubo(), GATEWAY, CID);
    expect(probe.state).toBe('gateway_unreachable');
    expect(probe.errorClass).toBe('ENOTFOUND');
  });

  it('gateway_unreachable still classifies a bare thrown error without a cause code', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('fetch failed'); }));
    const probe = await probeRetrieval(kubo(), GATEWAY, CID);
    expect(probe.state).toBe('gateway_unreachable');
  });

  it('RETRIEVAL_AVAILABLE_STATES covers exactly the "confirmed available" outcomes', () => {
    expect(RETRIEVAL_AVAILABLE_STATES).toEqual(['pinned', 'local_retrievable', 'gateway_retrievable']);
  });
});
