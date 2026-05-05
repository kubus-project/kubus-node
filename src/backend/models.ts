export type NodeStatus = 'registered' | 'active' | 'paused' | 'retired';
export type HeartbeatStatus = 'healthy' | 'degraded' | 'offline' | 'syncing';
export type CommitmentStatus = 'active' | 'paused' | 'expired' | 'revoked';

export interface AvailabilityNode {
  id: string;
  operatorWalletAddress?: string;
  nodeKey: string;
  endpointUrl: string;
  label?: string | null;
  status: NodeStatus;
  metadata?: Record<string, unknown>;
  registeredAt?: string | null;
  lastSeenAt?: string | null;
  updatedAt?: string | null;
}

export interface RewardableCid {
  id: string;
  cid: string;
  cidUri?: string | null;
  rewardRole?: string | null;
  verificationClass?: string | null;
  retrievalHint?: string | null;
  metadata?: Record<string, unknown>;
  isActive?: boolean;
  createdAt?: string | null;
  objectType?: string | null;
  objectId?: string | null;
  version?: number;
  assetPath?: string | null;
  displayOrder?: number;
}

export interface PublicPinSetRecord {
  id: string;
  cid: string;
  cidUri?: string | null;
  role: string;
  family?: string | null;
  objectType?: string | null;
  objectId?: string | null;
  version?: number;
  assetPath?: string | null;
  isCanonical?: boolean;
  isRewardable?: boolean;
  rewardableCidId?: string | null;
  rewardRole?: string | null;
  verificationClass?: string | null;
  retrievalHint?: string | null;
  metadata?: Record<string, unknown>;
  publishedAt?: string | null;
  updatedAt?: string | null;
}

export interface PinSetResponse {
  count: number;
  limit?: number;
  offset?: number;
  records: PublicPinSetRecord[];
}

export interface AvailabilityPolicy {
  version: string;
  rewardableContentSource: string;
  pinning?: Record<string, unknown>;
  maxPinnedCidsDefault: number;
  commitmentTtlHours: number;
  heartbeatIntervalMs: number;
  cidSyncIntervalMs: number;
  verification: Record<string, unknown>;
  rewards: Record<string, unknown>;
  statuses: Record<string, string[]>;
}

export interface AvailabilityCommitment {
  id: string;
  nodeId: string;
  rewardableCidId: string;
  cid: string;
  manifestCid?: string | null;
  status: CommitmentStatus;
  expiresAt?: string | null;
  metadata?: Record<string, unknown>;
}

export interface AvailabilityHeartbeat {
  id: string;
  nodeId: string;
  peerId?: string | null;
  agentVersion?: string | null;
  kuboHealth?: Record<string, unknown>;
  storage?: Record<string, unknown>;
  trackedCidCount: number;
  pinnedCidCount: number;
  failedCidCount: number;
  rewardableCidCount?: number;
  status: HeartbeatStatus;
  metadata?: Record<string, unknown>;
  receivedAt?: string | null;
}

export interface NodeStatusSummary {
  node: AvailabilityNode | null;
  status: HeartbeatStatus;
  stale?: boolean;
  latestHeartbeat?: AvailabilityHeartbeat | null;
  activeCommitmentCount: number;
  activeCommitments: AvailabilityCommitment[];
  rewardSummary?: RewardSummary | null;
}

export interface AvailabilityEpoch {
  id: string;
  epochKey: string;
  startsAt: string;
  endsAt: string;
  status: string;
  rewardPoolKub8: number;
}

export interface RewardSummary {
  pendingKub8: number;
  settledKub8: number;
  noRewardEpochs: number;
}

export interface RewardsResponse {
  count: number;
  limit: number;
  offset: number;
  summary: RewardSummary;
  rewards: unknown[];
}

export interface RegisterNodePayload {
  nodeKey: string;
  endpointUrl: string;
  label?: string;
  status?: 'registered' | 'active' | 'paused';
  metadata?: Record<string, unknown>;
}

export interface HeartbeatPayload {
  nodeId: string;
  peerId?: string | null;
  agentVersion?: string;
  kuboHealth?: Record<string, unknown>;
  storage?: Record<string, unknown>;
  trackedCidCount?: number;
  pinnedCidCount?: number;
  failedCidCount?: number;
  rewardableCidCount?: number;
  status?: HeartbeatStatus;
  metadata?: Record<string, unknown>;
}

export interface CommitmentPayload {
  nodeId?: string;
  rewardableCidId?: string;
  cid?: string;
  expiresAt?: string;
  metadata?: Record<string, unknown>;
}
