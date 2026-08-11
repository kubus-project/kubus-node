import type { KuboClient } from '../ipfs/kuboClient.js';

export type CapabilityName =
  | 'archive'
  | 'localContentGateway'
  | 'spatial.reconstruction'
  | 'spatial.optimization'
  | 'spatial.gaussianSplat'
  | 'compute.gpu';

export interface CapabilityStatus {
  name: CapabilityName;
  available: boolean;
  healthy: boolean;
  reason?: string;
  metadata?: Record<string, unknown>;
}

export interface SpatialWorkerHealth {
  status: 'ready' | 'unavailable' | 'unsupported' | 'degraded';
  gpu: { available: boolean; name?: string; cuda?: string };
  capabilities: string[];
  version?: string;
  detail?: string;
}

export class CapabilityRegistry {
  private workerHealth: SpatialWorkerHealth = {
    status: 'unavailable',
    gpu: { available: false },
    capabilities: [],
    detail: 'Spatial worker is not configured',
  };

  constructor(private readonly kubo: KuboClient, private readonly workerUrl?: string) {}

  async refresh(): Promise<CapabilityStatus[]> {
    let kuboHealthy = false;
    try {
      await this.kubo.id();
      kuboHealthy = true;
    } catch {
      kuboHealthy = false;
    }
    this.workerHealth = await this.detectWorker();
    const workerReady = this.workerHealth.status === 'ready';
    const supports = (name: string) => workerReady && this.workerHealth.capabilities.includes(name);
    return [
      { name: 'archive', available: true, healthy: kuboHealthy, reason: kuboHealthy ? undefined : 'Kubo is unavailable' },
      { name: 'localContentGateway', available: true, healthy: kuboHealthy, reason: kuboHealthy ? undefined : 'Kubo is unavailable' },
      { name: 'spatial.reconstruction', available: supports('spatial.reconstruct'), healthy: workerReady, reason: workerReady ? undefined : this.workerHealth.detail },
      { name: 'spatial.optimization', available: supports('spatial.optimize'), healthy: workerReady, reason: workerReady ? undefined : this.workerHealth.detail },
      { name: 'spatial.gaussianSplat', available: supports('spatial.gaussianSplat'), healthy: workerReady, reason: workerReady ? undefined : this.workerHealth.detail },
      { name: 'compute.gpu', available: this.workerHealth.gpu.available, healthy: workerReady && this.workerHealth.gpu.available, reason: this.workerHealth.gpu.available ? undefined : this.workerHealth.detail, metadata: this.workerHealth.gpu },
    ];
  }

  getWorkerHealth(): SpatialWorkerHealth {
    return structuredClone(this.workerHealth);
  }

  private async detectWorker(): Promise<SpatialWorkerHealth> {
    if (!this.workerUrl) return this.workerHealth;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 3000);
    try {
      const response = await fetch(`${this.workerUrl}/health`, { signal: controller.signal });
      if (!response.ok) throw new Error(`worker_http_${response.status}`);
      const body = await response.json() as Partial<SpatialWorkerHealth>;
      return {
        status: body.status === 'ready' ? 'ready' : body.status === 'unsupported' ? 'unsupported' : 'degraded',
        gpu: body.gpu?.available ? body.gpu : { available: false },
        capabilities: Array.isArray(body.capabilities) ? body.capabilities.filter((item): item is string => typeof item === 'string') : [],
        version: typeof body.version === 'string' ? body.version : undefined,
        detail: typeof body.detail === 'string' ? body.detail : undefined,
      };
    } catch (error) {
      return { status: 'unavailable', gpu: { available: false }, capabilities: [], detail: String((error as Error).message || error) };
    } finally {
      clearTimeout(timeout);
    }
  }
}
