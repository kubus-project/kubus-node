import type {
  AvailabilityCommitment,
  AvailabilityEpoch,
  AvailabilityNode,
  AvailabilityPolicy,
  CommitmentPayload,
  HeartbeatPayload,
  NodeStatusSummary,
  RegisterNodePayload,
  RewardableCid,
  RewardsResponse,
} from './models.js';
import type { AuthProvider } from './operatorAuth.js';
import { Backoff } from '../scheduler/backoff.js';
import { sleep } from '../utils/time.js';

export class KubusApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly details?: unknown,
  ) {
    super(message);
  }
}

interface ClientOptions {
  baseUrl: string;
  auth: AuthProvider;
  timeoutMs?: number;
  retries?: number;
}

export class KubusApiClient {
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly retries: number;

  constructor(private readonly options: ClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, '');
    this.timeoutMs = options.timeoutMs ?? 10000;
    this.retries = options.retries ?? 2;
  }

  getHealth(): Promise<unknown> {
    return this.request('/health/ready', { auth: false }).catch(() => this.request('/health', { auth: false }));
  }

  getKub8Utility(): Promise<unknown> {
    return this.request('/api/availability/kub8-utility', { auth: false });
  }

  getPolicies(): Promise<AvailabilityPolicy> {
    return this.request('/api/availability/policies', { auth: false });
  }

  getRewardableCids(params: { limit?: number; offset?: number; type?: string; id?: string; cid?: string } = {}): Promise<{ count: number; records: RewardableCid[]; utility?: unknown }> {
    return this.request(`/api/availability/rewardable-cids${queryString(params)}`, { auth: false });
  }

  registerNode(payload: RegisterNodePayload): Promise<AvailabilityNode> {
    return this.request('/api/availability/nodes/register', { method: 'POST', body: payload });
  }

  getCurrentNode(): Promise<NodeStatusSummary> {
    return this.request('/api/availability/nodes/current');
  }

  getMyNodes(): Promise<{ nodes: AvailabilityNode[] }> {
    return this.request('/api/availability/nodes/me');
  }

  sendHeartbeat(payload: HeartbeatPayload): Promise<{ heartbeat: unknown; status: NodeStatusSummary }> {
    return this.request('/api/availability/heartbeat', { method: 'POST', body: payload });
  }

  sendNodeHeartbeat(nodeId: string, payload: Omit<HeartbeatPayload, 'nodeId'>): Promise<{ heartbeat: unknown; status: NodeStatusSummary }> {
    return this.request(`/api/availability/nodes/${encodeURIComponent(nodeId)}/heartbeat`, { method: 'POST', body: payload });
  }

  getNodeStatus(nodeId: string): Promise<NodeStatusSummary> {
    return this.request(`/api/availability/nodes/${encodeURIComponent(nodeId)}/status`);
  }

  getLatestHeartbeat(nodeId: string): Promise<{ heartbeat: unknown | null }> {
    return this.request(`/api/availability/nodes/${encodeURIComponent(nodeId)}/heartbeat/latest`);
  }

  createCommitment(payload: CommitmentPayload): Promise<AvailabilityCommitment> {
    return this.request('/api/availability/commitments', { method: 'POST', body: payload });
  }

  createNodeCommitment(nodeId: string, payload: CommitmentPayload): Promise<AvailabilityCommitment> {
    return this.request(`/api/availability/nodes/${encodeURIComponent(nodeId)}/commitments`, { method: 'POST', body: payload });
  }

  getCurrentCommitments(nodeId: string): Promise<{ count: number; commitments: AvailabilityCommitment[] }> {
    return this.request(`/api/availability/commitments/current?nodeId=${encodeURIComponent(nodeId)}`);
  }

  getNodeCommitments(nodeId: string): Promise<{ commitments: AvailabilityCommitment[] }> {
    return this.request(`/api/availability/nodes/${encodeURIComponent(nodeId)}/commitments`);
  }

  getCurrentEpoch(): Promise<{ epoch: AvailabilityEpoch | null }> {
    return this.request('/api/availability/epochs/current', { auth: false });
  }

  getMyRewards(params: { status?: string; limit?: number; offset?: number } = {}): Promise<RewardsResponse> {
    return this.request(`/api/availability/rewards/me${queryString(params)}`);
  }

  private async request<T>(path: string, init: { method?: string; body?: unknown; auth?: boolean } = {}): Promise<T> {
    const method = init.method ?? 'GET';
    const backoff = new Backoff(500, 5000);
    let last: unknown;
    for (let attempt = 0; attempt <= this.retries; attempt += 1) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
      try {
        const headers: Record<string, string> = { Accept: 'application/json' };
        if (init.body !== undefined) headers['Content-Type'] = 'application/json';
        if (init.auth !== false) Object.assign(headers, this.options.auth.headers());
        const response = await fetch(`${this.baseUrl}${path}`, {
          method,
          headers,
          body: init.body === undefined ? undefined : JSON.stringify(init.body),
          signal: controller.signal,
        });
        const text = await response.text();
        const parsed = text ? safeJson(text) : null;
        if (!response.ok) {
          const message = extractError(parsed) ?? `Kubus API ${method} ${path} failed with HTTP ${response.status}`;
          throw new KubusApiError(message, response.status, parsed);
        }
        return normalizeData(parsed) as T;
      } catch (error) {
        last = error;
        if (!isTransient(error) || attempt >= this.retries) throw error;
        await sleep(backoff.failure());
      } finally {
        clearTimeout(timeout);
      }
    }
    throw last instanceof Error ? last : new Error(String(last));
  }
}

function normalizeData(parsed: unknown): unknown {
  if (parsed && typeof parsed === 'object' && 'success' in parsed) {
    const obj = parsed as { success?: boolean; data?: unknown; error?: unknown };
    if (obj.success === false) throw new KubusApiError(String(obj.error || 'Kubus API error'), 400, parsed);
    return obj.data;
  }
  return parsed;
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text };
  }
}

function extractError(parsed: unknown): string | null {
  if (parsed && typeof parsed === 'object') {
    const obj = parsed as { error?: unknown; message?: unknown };
    return typeof obj.error === 'string' ? obj.error : typeof obj.message === 'string' ? obj.message : null;
  }
  return null;
}

function isTransient(error: unknown): boolean {
  if (error instanceof KubusApiError) return error.status >= 500 || error.status === 408 || error.status === 429;
  return true;
}

function queryString(params: Record<string, string | number | undefined>): string {
  const qs = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== '') qs.set(key, String(value));
  }
  const out = qs.toString();
  return out ? `?${out}` : '';
}
