import type { KuboClient } from '../ipfs/kuboClient.js';

export type CapabilityName =
  | 'archive'
  | 'localContentGateway'
  | 'spatial.reconstruction'
  | 'spatial.optimization'
  | 'spatial.gaussianSplat'
  | 'compute.gpu'
  | 'compute.remoteJobs';

export interface CapabilityStatus {
  name: CapabilityName;
  available: boolean;
  healthy: boolean;
  reason?: string;
  metadata?: Record<string, unknown>;
}

export interface SpatialWorkerHealth {
  status: 'ready' | 'unavailable' | 'unsupported' | 'degraded' | 'unconfigured';
  gpu: { available: boolean; name?: string; vendor?: string; model?: string; cuda?: string; totalVramBytes?: number; usableVramBytes?: number; tier?: string };
  capabilities: string[];
  version?: string;
  detail?: string;
}

/** Default staleness budget for {@link CapabilityRegistry.refreshIfStale}. */
const DEFAULT_REFRESH_TTL_MS = 5000;

/**
 * The single authoritative source of runtime capability state (Kubo health,
 * spatial worker health, derived capability flags) for this kubus Node
 * process. GUI, local API, heartbeat and job eligibility all read through the
 * same instance so they can never disagree about whether the worker is up.
 *
 * Probing is demand-driven rather than a background timer: callers ask for
 * fresh-enough state via `refreshIfStale`, and concurrent callers share a
 * single in-flight probe instead of hammering the worker.
 */
export class CapabilityRegistry {
  private workerHealth: SpatialWorkerHealth;
  private capabilitiesSnapshot: CapabilityStatus[];
  private lastRefreshAt = 0;
  private refreshPromise: Promise<CapabilityStatus[]> | null = null;

  constructor(private readonly kubo: KuboClient, private readonly workerUrl?: string) {
    // "Never configured" and "configured but not yet probed" are different
    // situations for the operator: the former is a normal archive-only node,
    // the latter should read as "not responding" the moment a probe fails.
    this.workerHealth = this.workerUrl
      ? { status: 'unavailable', gpu: { available: false }, capabilities: [], detail: 'Spatial worker has not been probed yet' }
      : { status: 'unconfigured', gpu: { available: false }, capabilities: [], detail: 'Spatial worker is not configured' };
    this.capabilitiesSnapshot = this.buildCapabilities(this.workerHealth, false);
  }

  /** Force a fresh probe. Concurrent callers share one in-flight probe. */
  async refresh(): Promise<CapabilityStatus[]> {
    if (!this.refreshPromise) {
      this.refreshPromise = this.performRefresh().finally(() => {
        this.refreshPromise = null;
      });
    }
    return this.refreshPromise;
  }

  /**
   * Return cached state when it is younger than `maxAgeMs`; otherwise probe.
   * Pass `0` to always force a fresh probe (still concurrency-safe).
   */
  async refreshIfStale(maxAgeMs = DEFAULT_REFRESH_TTL_MS): Promise<CapabilityStatus[]> {
    if (this.refreshPromise) return this.refreshPromise;
    if (this.lastRefreshAt > 0 && Date.now() - this.lastRefreshAt < maxAgeMs) return this.capabilitiesSnapshot;
    return this.refresh();
  }

  getWorkerHealth(): SpatialWorkerHealth {
    return structuredClone(this.workerHealth);
  }

  /** Last computed capability list, without triggering a probe. */
  getCapabilities(): CapabilityStatus[] {
    return structuredClone(this.capabilitiesSnapshot);
  }

  private async performRefresh(): Promise<CapabilityStatus[]> {
    let kuboHealthy = false;
    try {
      await this.kubo.id();
      kuboHealthy = true;
    } catch {
      kuboHealthy = false;
    }
    this.workerHealth = await this.detectWorker();
    this.capabilitiesSnapshot = this.buildCapabilities(this.workerHealth, kuboHealthy);
    this.lastRefreshAt = Date.now();
    return this.capabilitiesSnapshot;
  }

  private buildCapabilities(workerHealth: SpatialWorkerHealth, kuboHealthy: boolean): CapabilityStatus[] {
    const workerReady = workerHealth.status === 'ready';
    const supports = (name: string) => workerReady && workerHealth.capabilities.includes(name);
    return [
      { name: 'archive', available: true, healthy: kuboHealthy, reason: kuboHealthy ? undefined : 'Kubo is unavailable' },
      { name: 'localContentGateway', available: true, healthy: kuboHealthy, reason: kuboHealthy ? undefined : 'Kubo is unavailable' },
      { name: 'spatial.reconstruction', available: supports('spatial.reconstruct'), healthy: workerReady, reason: workerReady ? undefined : workerHealth.detail },
      { name: 'spatial.optimization', available: supports('spatial.optimize'), healthy: workerReady, reason: workerReady ? undefined : workerHealth.detail },
      { name: 'spatial.gaussianSplat', available: supports('spatial.gaussianSplat'), healthy: workerReady, reason: workerReady ? undefined : workerHealth.detail },
      { name: 'compute.gpu', available: workerHealth.gpu.available, healthy: workerReady && workerHealth.gpu.available, reason: workerHealth.gpu.available ? undefined : workerHealth.detail, metadata: workerHealth.gpu },
      { name: 'compute.remoteJobs', available: workerHealth.gpu.available, healthy: workerReady && workerHealth.gpu.available, reason: workerReady ? undefined : workerHealth.detail },
    ];
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
