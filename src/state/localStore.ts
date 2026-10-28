import { promises as fs } from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import type { ManagedPinRecord } from '../ipfs/managedPins.js';
import type { JobCleanupRecord } from '../jobs/jobCleanup.js';
import type {
  AvailabilityCommitment,
  AvailabilityEpoch,
  AvailabilityHeartbeat,
  AvailabilityNode,
  AvailabilityPolicy,
  NodeStatusSummary,
  PublicPinSetRecord,
  RewardableCid,
  RewardsResponse,
} from '../backend/models.js';

export interface LocalState {
  version: 1;
  nodeKey?: string;
  nodeId?: string;
  registeredAt?: string;
  peerId?: string;
  policy?: AvailabilityPolicy;
  publicPinSet: PublicPinSetRecord[];
  rewardableCids: RewardableCid[];
  desiredCids: PublicPinSetRecord[];
  pinnedCids: string[];
  managedPins?: Record<string, ManagedPinRecord>;
  failedCids: Record<string, { error: string; at: string }>;
  publicPinSetTotal?: number;
  /** Authoritative completeness marker for the last canonical pin-set sync. */
  publicPinSetComplete?: boolean;
  rewardableCidTotal?: number;
  latestPublicPinSetSyncAt?: string;
  latestPinReconcileAt?: string;
  latestCommitmentRefreshAt?: string;
  latestHeartbeatAt?: string;
  latestStatusRefreshAt?: string;
  latestRewardsRefreshAt?: string;
  commitmentSkipReasons?: Record<string, string>;
  activeCommitments: AvailabilityCommitment[];
  latestHeartbeat?: AvailabilityHeartbeat;
  latestStatus?: NodeStatusSummary;
  currentEpoch?: AvailabilityEpoch | null;
  rewards?: RewardsResponse;
  computeRewards?: { role: string; formulaVersion: string; pendingKub8: number; settledKub8: number; verifiedComputeUnits: number; recordCount: number; settlement: string };
  node?: AvailabilityNode | null;
  pairingSessions?: Record<string, {
    secretHash: string;
    createdAt: string;
    expiresAt: string;
    usedAt?: string;
  }>;
  localCredentials?: Record<string, {
    tokenHash: string;
    label?: string;
    scopes: string[];
    createdAt: string;
    lastUsedAt?: string;
    revokedAt?: string;
  }>;
  jobs?: Record<string, unknown>;
  jobCleanup?: Record<string, JobCleanupRecord>;
  captures?: Record<string, unknown>;
  spatial?: Record<string, unknown>;
  participation?: {
    state: 'UNCONFIGURED' | 'JOINING' | 'CONTRIBUTING' | 'DEGRADED' | 'LOCKED';
    reason?: string;
    lastVerifiedAt?: string;
    leaseExpiresAt?: string;
    graceExpiresAt?: string;
    verificationGeneration?: number;
  };
  computeIdentity?: {
    encryptionPublicKey: string;
    encryptionPrivateKey: string;
    signingPublicKey: string;
    signingPrivateKey: string;
    createdAt: string;
  };
  remoteJobs?: Record<string, unknown>;
  computeProviderSettings?: {
    enabled: boolean;
    paused: boolean;
    maxConcurrency: number;
    maxQueueDepth: number;
    maxAcceptedInputBytes: number;
    minimumFreeVramBytes: number;
  };
  privateComputeCids?: Record<string, { jobId?: string; role: 'encrypted_input' | 'private_output'; createdAt: string; expiresAt?: string; releasedAt?: string; pinOwner?: string }>;

  /**
   * Why the optional remote-compute capabilities are or are not currently usable.
   *
   * A 401 or 403 from the compute provider routes is a standing fact about this
   * node's credential, not a transient outage: the operator token is invalid,
   * revoked, expired, or simply does not carry `compute:jobs:read`. Retrying
   * cannot change any of those. Recording the verdict here is what lets the
   * runtime stop asking, survive a restart without re-learning it the hard way,
   * and tell the operator what to actually do.
   *
   * `credentialFingerprint` is a salted hash of the operator token, never the
   * token. It exists so a rotated credential is recognisable as a *different*
   * one: a blocked state recorded against a credential that is no longer in use
   * says nothing about the new one, so polling resumes on its own.
   *
   * Scoped to remote compute only. Archive participation, local processing and
   * the GUI have their own scopes and are unaffected by this.
   */
  computeAuthorization?: {
    state: 'OK' | 'AUTHORIZATION_REQUIRED';
    /** 401 or 403 — an invalid credential and a valid one lacking scope are different problems. */
    status?: number;
    /** The scope the backend said was missing, when it said so. */
    missingScope?: string;
    /** Which capability observed it, so one failure does not mute the other. */
    surface?: 'provider_jobs' | 'provider_rewards';
    observedAt?: string;
    /** Salted hash of the operator token in use when this was observed. Never the token. */
    credentialFingerprint?: string;
    /** Last time this node was successfully authorized for remote compute. */
    lastAuthorizedAt?: string;
  };

  updatedAt?: string;
}

const emptyState = (): LocalState => ({
  version: 1,
  publicPinSet: [],
  rewardableCids: [],
  desiredCids: [],
  pinnedCids: [],
  failedCids: {},
  activeCommitments: [],
  pairingSessions: {},
  localCredentials: {},
  jobs: {},
  captures: {},
  spatial: {},
  remoteJobs: {},
  privateComputeCids: {},
});

export class LocalStore {
  private state: LocalState | null = null;
  private writeChain: Promise<void> = Promise.resolve();
  private readOnly = false;

  constructor(private readonly filePath: string) {}

  async load({ readOnly = false }: { readOnly?: boolean } = {}): Promise<LocalState> {
    this.readOnly = readOnly;
    if (!readOnly) await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    try {
      const raw = await fs.readFile(this.filePath, 'utf8');
      const parsed = JSON.parse(raw) as LocalState;
      if (parsed.version !== 1) throw new Error('Unsupported state version');
      this.state = { ...emptyState(), ...parsed };
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') {
        this.state = emptyState();
      } else {
        if (readOnly) throw new Error('state_snapshot_unavailable');
        const backup = `${this.filePath}.corrupt-${Date.now()}`;
        try {
          await fs.rename(this.filePath, backup);
        } catch {
          // Best effort: keep startup moving with fresh state after detecting corruption.
        }
        this.state = emptyState();
      }
    }
    return this.snapshot();
  }

  snapshot(): LocalState {
    return JSON.parse(JSON.stringify(this.state ?? emptyState())) as LocalState;
  }

  async update(mutator: (state: LocalState) => void | Promise<void>): Promise<LocalState> {
    if (this.readOnly) throw new Error('state_store_read_only');
    // Serialize the mutation as well as the write. An async mutator must see
    // the last committed state, and its candidate must remain invisible until
    // persistence succeeds. Never leave a failed candidate in live memory.
    const transaction = this.writeChain.then(async () => {
      if (!this.state) await this.load();
      const candidate = this.snapshot();
      await mutator(candidate);
      candidate.updatedAt = new Date().toISOString();
      // Detach from references retained by a mutator before committing.
      const next = JSON.parse(JSON.stringify(candidate)) as LocalState;
      await this.atomicWrite(next);
      this.state = next;
      return this.snapshot();
    });
    // Recover only the scheduling tail: this caller still receives its own
    // failure, while subsequent independent transactions can retry normally.
    this.writeChain = transaction.then(() => undefined, () => undefined);
    return transaction;
  }

  async getOrCreateNodeKey(provided?: string | null): Promise<string> {
    const existing = this.snapshot().nodeKey;
    if (provided && provided.trim()) {
      await this.update((state) => {
        state.nodeKey = provided.trim();
      });
      return provided.trim();
    }
    if (existing) return existing;
    const generated = `kubus-node-${crypto.randomBytes(24).toString('hex')}`;
    await this.update((state) => {
      state.nodeKey = generated;
    });
    return generated;
  }

  private async atomicWrite(next: LocalState): Promise<void> {
    const dir = path.dirname(this.filePath);
    await fs.mkdir(dir, { recursive: true });
    const tmp = path.join(dir, `.${path.basename(this.filePath)}.${process.pid}.${crypto.randomUUID()}.tmp`);
    try {
      await fs.writeFile(tmp, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
      await fs.rename(tmp, this.filePath);
    } finally {
      // Remove only this write's temporary file; never touch the committed
      // state file when persistence fails. Preserve the original error.
      await fs.rm(tmp, { force: true }).catch(() => undefined);
    }
  }
}
