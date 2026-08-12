import { afterEach, describe, expect, it, vi } from 'vitest';
import { CapabilityRegistry } from '../src/capabilities/registry.js';

const kubo = { id: async () => ({ ID: 'peer' }) } as never;

function readyResponse(overrides: Record<string, unknown> = {}) {
  return new Response(JSON.stringify({
    status: 'ready',
    gpu: { available: true, name: 'GPU' },
    capabilities: ['spatial.reconstruct', 'spatial.gaussianSplat'],
    ...overrides,
  }), { status: 200 });
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('CapabilityRegistry', () => {
  it('keeps a lightweight archive node healthy without spatial tooling', async () => {
    const registry = new CapabilityRegistry(kubo);
    const capabilities = await registry.refresh();
    expect(capabilities.find((item) => item.name === 'archive')).toMatchObject({ available: true, healthy: true });
    expect(capabilities.find((item) => item.name === 'spatial.reconstruction')).toMatchObject({ available: false });
    // Never configured, distinct from a configured worker that failed a probe.
    expect(registry.getWorkerHealth().status).toBe('unconfigured');
  });

  it('advertises only capabilities reported by a healthy GPU worker', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(readyResponse());
    const registry = new CapabilityRegistry(kubo, 'http://worker');
    const capabilities = await registry.refresh();
    expect(capabilities.find((item) => item.name === 'spatial.reconstruction')?.available).toBe(true);
    expect(capabilities.find((item) => item.name === 'spatial.optimization')?.available).toBe(false);
    expect(capabilities.find((item) => item.name === 'compute.gpu')?.healthy).toBe(true);
  });

  it('reports the worker as ready once a first refresh succeeds', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(readyResponse());
    const registry = new CapabilityRegistry(kubo, 'http://worker');
    expect(registry.getWorkerHealth().status).toBe('unavailable');
    await registry.refresh();
    expect(registry.getWorkerHealth().status).toBe('ready');
  });

  it('recovers to ready once a worker that started unreachable comes online', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
      .mockRejectedValueOnce(new Error('connect ECONNREFUSED'))
      .mockResolvedValueOnce(readyResponse());
    const registry = new CapabilityRegistry(kubo, 'http://worker');
    await registry.refresh();
    expect(registry.getWorkerHealth().status).toBe('unavailable');
    await registry.refreshIfStale(0);
    expect(registry.getWorkerHealth().status).toBe('ready');
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it('drops out of ready once a previously healthy worker disappears', async () => {
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(readyResponse())
      .mockRejectedValueOnce(new Error('connect ECONNREFUSED'));
    const registry = new CapabilityRegistry(kubo, 'http://worker');
    await registry.refresh();
    expect(registry.getWorkerHealth().status).toBe('ready');
    await registry.refreshIfStale(0);
    expect(registry.getWorkerHealth().status).toBe('unavailable');
  });

  it('serves cached state within the TTL instead of issuing another probe', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(readyResponse());
    const registry = new CapabilityRegistry(kubo, 'http://worker');
    await registry.refreshIfStale(60_000);
    await registry.refreshIfStale(60_000);
    await registry.refreshIfStale(60_000);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(registry.getWorkerHealth().status).toBe('ready');
  });

  it('shares one in-flight probe across concurrent refreshIfStale callers', async () => {
    let resolveFetch!: (value: Response) => void;
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(
      () => new Promise((resolve) => { resolveFetch = resolve; }),
    );
    const registry = new CapabilityRegistry(kubo, 'http://worker');
    const calls = [registry.refreshIfStale(), registry.refreshIfStale(), registry.refreshIfStale()];
    // Let the pending kubo.id() microtask resolve so detectWorker() actually
    // reaches fetch() and installs resolveFetch before we call it.
    await new Promise((resolve) => setTimeout(resolve, 0));
    resolveFetch(readyResponse());
    await Promise.all(calls);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('lets an explicit refresh() ignore the TTL', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(readyResponse());
    const registry = new CapabilityRegistry(kubo, 'http://worker');
    await registry.refreshIfStale(60_000);
    await registry.refresh();
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it('treats a malformed worker response as unavailable without crashing', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('not json', { status: 200 }));
    const registry = new CapabilityRegistry(kubo, 'http://worker');
    await expect(registry.refresh()).resolves.toBeDefined();
    const worker = registry.getWorkerHealth();
    expect(worker.status).toBe('unavailable');
    expect(worker.detail).toBeTruthy();
  });

  it('treats a probe timeout as unavailable with a clear diagnostic detail', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation((_input, init) => new Promise((_resolve, reject) => {
      const signal = (init as { signal?: AbortSignal })?.signal;
      signal?.addEventListener('abort', () => reject(new DOMException('The operation was aborted', 'AbortError')));
    }));
    const registry = new CapabilityRegistry(kubo, 'http://worker');
    await registry.refresh();
    const worker = registry.getWorkerHealth();
    expect(worker.status).toBe('unavailable');
    expect(worker.detail).toBeTruthy();
  }, 10000);
});
