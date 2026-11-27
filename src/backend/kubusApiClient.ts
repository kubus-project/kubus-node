import type {
  AvailabilityCommitment,
  AvailabilityEpoch,
  AvailabilityNode,
  AvailabilityPolicy,
  CommitmentPayload,
  HeartbeatPayload,
  NodeStatusSummary,
  PinSetResponse,
  RegisterNodePayload,
  RewardableCid,
  RewardsResponse,
  ComputeCandidate,
  ManagedReconstruction,
  RemoteComputeJob,
} from './models.js';
import type { AuthProvider } from './operatorAuth.js';
import { Backoff } from '../scheduler/backoff.js';
import { sleep } from '../utils/time.js';
import type { NodeAuthorization } from '../identity/remoteAttach.js';

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

  getPublicPinSet(params: {
    limit?: number;
    offset?: number;
    entityType?: string;
    entityId?: string;
    cid?: string;
    role?: string;
    family?: string;
    verificationClass?: string;
    rewardableOnly?: boolean;
    changedSince?: string;
  } = {}): Promise<PinSetResponse> {
    return this.request(`/api/availability/public-pin-set${queryString(params)}`, { auth: false });
  }

  registerNode(payload: RegisterNodePayload): Promise<AvailabilityNode> {
    return this.request('/api/availability/nodes/register', { method: 'POST', body: payload });
  }

  createIdentityChallenge(nodeId: string, publicKey: string): Promise<NodeAuthorization> {
    return this.request(`/api/availability/nodes/${encodeURIComponent(nodeId)}/identity-challenges`, {
      method: 'POST', body: { publicKey },
    });
  }

  consumeNodeAuthorization(nodeId: string, id: string, body: Record<string, unknown>): Promise<{ authorized: boolean; kind: string; nodeId: string; deviceId?: string }> {
    return this.request(`/api/availability/nodes/${encodeURIComponent(nodeId)}/authorizations/${encodeURIComponent(id)}/consume`, {
      method: 'POST', body,
    });
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

  publishExistingSpatial(payload: Record<string, unknown>, userAuthorization: string): Promise<unknown> {
    return this.request('/api/publications/spatial/cid', { method: 'POST', body: payload, authorization: userAuthorization });
  }

  getComputeCandidates(params: { type?: string; minimumVramBytes?: number; inputBytes?: number; privateOutput?: boolean }, userAuthorization: string): Promise<{ nodes: ComputeCandidate[]; protocolVersion: string }> {
    return this.request(`/api/compute/nodes/available${queryString(params)}`, { authorization: userAuthorization });
  }

  createRemoteComputeJob(payload: Record<string, unknown>, userAuthorization: string): Promise<RemoteComputeJob> {
    return this.request('/api/compute/jobs', { method: 'POST', body: payload, authorization: userAuthorization });
  }

  getRemoteComputeJob(jobId: string, userAuthorization: string): Promise<RemoteComputeJob> {
    return this.request(`/api/compute/jobs/${encodeURIComponent(jobId)}`, { authorization: userAuthorization });
  }

  acknowledgeRemoteComputeJob(jobId: string, payload: Record<string, unknown>, userAuthorization: string): Promise<RemoteComputeJob> {
    return this.request(`/api/compute/jobs/${encodeURIComponent(jobId)}/acknowledge`, { method: 'POST', body: payload, authorization: userAuthorization });
  }

  cancelRemoteComputeJob(jobId: string, userAuthorization: string): Promise<RemoteComputeJob> {
    return this.request(`/api/compute/jobs/${encodeURIComponent(jobId)}/cancel`, { method: 'POST', body: {}, authorization: userAuthorization });
  }

  getProviderComputeJobs(nodeId: string, states: string[] = []): Promise<{ jobs: RemoteComputeJob[] }> {
    return this.request(`/api/compute/provider/jobs?nodeId=${encodeURIComponent(nodeId)}&states=${encodeURIComponent(states.join(','))}`);
  }

  getProviderComputeRewards(nodeId: string): Promise<{ role: string; formulaVersion: string; pendingKub8: number; settledKub8: number; verifiedComputeUnits: number; recordCount: number; settlement: string }> {
    return this.request(`/api/compute/provider/rewards?nodeId=${encodeURIComponent(nodeId)}`);
  }

  transitionProviderComputeJob(jobId: string, payload: Record<string, unknown>): Promise<RemoteComputeJob> {
    return this.request(`/api/compute/provider/jobs/${encodeURIComponent(jobId)}/transition`, { method: 'POST', body: payload });
  }

  submitProviderComputeOutput(jobId: string, payload: Record<string, unknown>): Promise<RemoteComputeJob> {
    return this.request(`/api/compute/provider/jobs/${encodeURIComponent(jobId)}/output`, { method: 'POST', body: payload });
  }

  /** The provider's signed statement of what it did with a finished job's data; only the job's provider may send it. */
  submitProviderCleanupAttestation(jobId: string, payload: { nodeId: string; attestation: { payload: unknown; signature: string } }): Promise<unknown> {
    return this.request(`/api/compute/provider/jobs/${encodeURIComponent(jobId)}/cleanup`, { method: 'POST', body: payload });
  }

  // Managed requester bridge. These use the Node's own operator token and always name this node; the backend
  // accepts only the configured pilot requester owned by that operator.
  claimReconstruction(nodeId: string): Promise<ManagedReconstruction | null> {
    return this.request('/api/spatial/reconstruction-bridge/claim', { method: 'POST', body: { nodeId } });
  }

  reconstructionRetention(nodeId: string): Promise<{ purge: string[] }> {
    return this.request(`/api/spatial/reconstruction-bridge/retention${queryString({ nodeId })}`);
  }

  readReconstructionChunk(id: string, fileId: string, offset: number, nodeId: string): Promise<Buffer> {
    return this.binary(`/api/spatial/reconstruction-bridge/${encodeURIComponent(id)}/files/${encodeURIComponent(fileId)}/chunks/${offset}${queryString({ nodeId })}`, 'GET');
  }

  /** A JSON bridge action (`progress`, `providers`, `compute-job`, `compute-job/acknowledge`, ...). */
  reconstructionCall<T>(id: string, action: string, body: Record<string, unknown>): Promise<T> {
    if (!/^[a-z-]+(\/[a-z-]+)?$/.test(action)) throw new Error('reconstruction_bridge_action_invalid');
    return this.request(`/api/spatial/reconstruction-bridge/${encodeURIComponent(id)}/${action}`, { method: 'POST', body });
  }

  getReconstructionComputeJob(id: string, nodeId: string): Promise<RemoteComputeJob> {
    return this.request(`/api/spatial/reconstruction-bridge/${encodeURIComponent(id)}/compute-job${queryString({ nodeId })}`);
  }

  async appendReconstructionCandidate(id: string, offset: number, bytes: Buffer, nodeId: string): Promise<{ reconstruction: ManagedReconstruction; candidate: { state: string } }> {
    const response = await this.binary(`/api/spatial/reconstruction-bridge/${encodeURIComponent(id)}/candidate/chunks/${offset}${queryString({ nodeId })}`, 'PUT', bytes);
    return normalizeData(safeJson(response.toString('utf8'))) as { reconstruction: ManagedReconstruction; candidate: { state: string } };
  }

  /** One bounded binary exchange (a 4 MiB chunk either way), retried like JSON requests. */
  private async binary(path: string, method: 'GET' | 'PUT', body?: Buffer): Promise<Buffer> {
    const backoff = new Backoff(500, 5000);
    let last: unknown;
    for (let attempt = 0; attempt <= this.retries; attempt += 1) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), Math.max(this.timeoutMs, 60_000));
      try {
        const headers: Record<string, string> = { Accept: method === 'GET' ? 'application/octet-stream' : 'application/json', ...this.options.auth.headers() };
        if (body) headers['Content-Type'] = 'application/octet-stream';
        const response = await fetch(`${this.baseUrl}${path}`, { method, headers, body: body ? new Uint8Array(body) : undefined, signal: controller.signal });
        const bytes = Buffer.from(await response.arrayBuffer());
        if (!response.ok) {
          const parsed = safeJson(bytes.toString('utf8'));
          throw new KubusApiError(extractError(parsed) ?? `Kubus API ${method} ${path} failed with HTTP ${response.status}`, response.status, parsed);
        }
        return bytes;
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

  private async request<T>(path: string, init: { method?: string; body?: unknown; auth?: boolean; authorization?: string } = {}): Promise<T> {
    const method = init.method ?? 'GET';
    const backoff = new Backoff(500, 5000);
    let last: unknown;
    for (let attempt = 0; attempt <= this.retries; attempt += 1) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
      try {
        const headers: Record<string, string> = { Accept: 'application/json' };
        if (init.body !== undefined) headers['Content-Type'] = 'application/json';
        if (init.authorization) headers.Authorization = init.authorization;
        else if (init.auth !== false) Object.assign(headers, this.options.auth.headers());
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

function queryString(params: Record<string, string | number | boolean | undefined>): string {
  const qs = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== '') qs.set(key, String(value));
  }
  const out = qs.toString();
  return out ? `?${out}` : '';
}
