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
  sizeBytes?: number | null;
  storageClass?: 'hot' | 'warm' | 'cold' | null;
  replicationPolicy?: Record<string, unknown> | null;
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
  scoringFormulaVersion?: string;
  archive?: Record<string, unknown>;
  rewardableContentSource: string;
  pinning?: Record<string, unknown>;
  maxPinnedCidsDefault: number;
  minimumContributionCapacityBytes?: number;
  participationLeaseSeconds?: number;
  participationGraceSeconds?: number;
  commitmentTtlHours: number;
  heartbeatIntervalMs: number;
  cidSyncIntervalMs: number;
  verification: Record<string, unknown>;
  rewards: Record<string, unknown>;
  statuses: Record<string, string[]>;
}

export interface ArchiveContributionStats {
  healthyMinutes?: number;
  verifiedPublicCidCount?: number;
  verifiedRewardableCidCount?: number;
  verifiedPublicCidHours?: number;
  verifiedRewardableCidHours?: number;
  retrievalChecksTotal?: number;
  retrievalChecksPassed?: number;
  uptimeScore?: number;
  coverageScore?: number;
  retrievalScore?: number;
  rewardableBonusScore?: number;
  rawPoints?: number;
  effectivePoints?: number;
  eligible?: boolean;
  ineligibleReason?: string | null;
  formulaVersion?: string | null;
  metadata?: Record<string, unknown>;
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
  archiveContribution?: ArchiveContributionStats | null;
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

export interface ComputeCandidate {
  nodeId: string;
  label: string;
  gpu: { vendor?: string | null; model?: string | null; totalVramBytes: number; usableVramBytes: number; tier?: string | null };
  worker: { status: string; version?: string | null; supportedJobTypes: string[] };
  queue: { running: number; queued: number; maxConcurrency: number };
  reliability: { successfulJobRate: number; completedJobs: number; failedJobs: number };
  encryptionPublicKey: string;
  signingPublicKey: string;
  protocolVersion: string;
  maxAcceptedInputBytes: number;
  score: number;
}

export interface RemoteComputeJob {
  id: string;
  requesterNodeId?: string | null;
  providerNodeId: string;
  type: string;
  protocolVersion: string;
  jobSpecVersion: string;
  requirements: Record<string, unknown>;
  inputCid: string;
  inputBytes: number;
  inputHash: string;
  inputKeyEnvelope: Record<string, unknown>;
  canonicalJobSpec: Record<string, unknown>;
  jobSpecHash: string;
  state: string;
  createdAt: string;
  expiresAt: string;
  outputManifestCid?: string | null;
  outputCids: string[];
  providerReceipt?: Record<string, unknown>;
  requesterReceipt?: Record<string, unknown>;
  verification?: Record<string, unknown>;
  failure?: Record<string, unknown>;
}
