import { promises as fs } from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import type {
  AvailabilityCommitment,
  AvailabilityEpoch,
  AvailabilityHeartbeat,
  AvailabilityNode,
  AvailabilityPolicy,
  NodeStatusSummary,
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
  rewardableCids: RewardableCid[];
  desiredCids: RewardableCid[];
  pinnedCids: string[];
  failedCids: Record<string, { error: string; at: string }>;
  activeCommitments: AvailabilityCommitment[];
  latestHeartbeat?: AvailabilityHeartbeat;
  latestStatus?: NodeStatusSummary;
  currentEpoch?: AvailabilityEpoch | null;
  rewards?: RewardsResponse;
  node?: AvailabilityNode | null;
  updatedAt?: string;
}

const emptyState = (): LocalState => ({
  version: 1,
  rewardableCids: [],
  desiredCids: [],
  pinnedCids: [],
  failedCids: {},
  activeCommitments: [],
});

export class LocalStore {
  private state: LocalState | null = null;
  private writeChain: Promise<void> = Promise.resolve();

  constructor(private readonly filePath: string) {}

  async load(): Promise<LocalState> {
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
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
    if (!this.state) await this.load();
    await mutator(this.state as LocalState);
    (this.state as LocalState).updatedAt = new Date().toISOString();
    const next = this.snapshot();
    this.writeChain = this.writeChain.then(() => this.atomicWrite(next));
    await this.writeChain;
    return next;
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
    const tmp = path.join(dir, `.${path.basename(this.filePath)}.${process.pid}.${Date.now()}.tmp`);
    await fs.writeFile(tmp, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
    await fs.rename(tmp, this.filePath);
  }
}
