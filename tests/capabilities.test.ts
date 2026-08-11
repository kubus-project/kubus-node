import { describe, expect, it, vi } from 'vitest';
import { CapabilityRegistry } from '../src/capabilities/registry.js';

describe('CapabilityRegistry', () => {
  it('keeps a lightweight archive node healthy without spatial tooling', async () => {
    const registry = new CapabilityRegistry({ id: async () => ({ ID: 'peer' }) } as never);
    const capabilities = await registry.refresh();
    expect(capabilities.find((item) => item.name === 'archive')).toMatchObject({ available: true, healthy: true });
    expect(capabilities.find((item) => item.name === 'spatial.reconstruction')).toMatchObject({ available: false });
    expect(registry.getWorkerHealth().status).toBe('unavailable');
  });

  it('advertises only capabilities reported by a healthy GPU worker', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({
      status: 'ready',
      gpu: { available: true, name: 'GPU' },
      capabilities: ['spatial.reconstruct', 'spatial.gaussianSplat'],
    }), { status: 200 }));
    const registry = new CapabilityRegistry({ id: async () => ({ ID: 'peer' }) } as never, 'http://worker');
    const capabilities = await registry.refresh();
    expect(capabilities.find((item) => item.name === 'spatial.reconstruction')?.available).toBe(true);
    expect(capabilities.find((item) => item.name === 'spatial.optimization')?.available).toBe(false);
    expect(capabilities.find((item) => item.name === 'compute.gpu')?.healthy).toBe(true);
  });
});
