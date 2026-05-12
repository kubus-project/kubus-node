import type { KubusApiClient } from "../backend/kubusApiClient.js";
import type { AppConfig } from "../config/schema.js";
import { getKuboHealth } from "../ipfs/health.js";
import type { KuboClient } from "../ipfs/kuboClient.js";
import type { LocalStore } from "../state/localStore.js";
import crypto from "node:crypto";

function clampRatio(value: number): number {
  return Math.min(Math.max(Number.isFinite(value) ? value : 0, 0), 1);
}

function hoursSinceStartOfDay(now = new Date()): number {
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  return Math.max((now.getTime() - start.getTime()) / 3600000, 0);
}

function buildLocalContributionEstimate(state: ReturnType<LocalStore["snapshot"]>, backendStatus?: ReturnType<LocalStore["snapshot"]>["latestStatus"]) {
  const rewardableCidSet = new Set((state.rewardableCids || []).map((item) => item.cid));
  const pinnedRewardableCidCount = (state.pinnedCids || []).filter((cid) => rewardableCidSet.has(cid)).length;
  const desiredCidCount = state.desiredCids?.length || 0;
  const publicPinSetCount = state.publicPinSetTotal ?? state.publicPinSet?.length ?? 0;
  const rewardableCidCount = state.rewardableCidTotal ?? state.rewardableCids?.length ?? 0;
  const estimatedPublicCoverage = clampRatio((state.pinnedCids?.length || 0) / Math.max(desiredCidCount || publicPinSetCount, 1));
  const estimatedRewardableCoverage = clampRatio(pinnedRewardableCidCount / Math.max(rewardableCidCount, 1));
  const online = backendStatus?.status === "healthy" || backendStatus?.status === "syncing";
  const uptimeTodayHours = online ? hoursSinceStartOfDay() : 0;
  const estimatedPublicCidHours = (state.pinnedCids?.length || 0) * uptimeTodayHours;
  const estimatedRewardableCidHours = pinnedRewardableCidCount * uptimeTodayHours;
  const estimatedContributionScore = Math.pow(
    Math.max(uptimeTodayHours + estimatedPublicCidHours + estimatedRewardableCidHours * 2, 0),
    0.85,
  );
  return {
    label: "local_estimate_only",
    uptimeTodayHours,
    publicArchiveCoverage: estimatedPublicCoverage,
    rewardableCoverage: estimatedRewardableCoverage,
    pinnedPublicCidCount: state.pinnedCids?.length || 0,
    failedPublicCidCount: Object.keys(state.failedCids || {}).length,
    pinnedRewardableCidCount,
    estimatedPublicCidHours,
    estimatedRewardableCidHours,
    retrievalFailures: Object.keys(state.failedCids || {}).length,
    estimatedContributionScore,
    backendVerified: backendStatus?.archiveContribution || null,
  };
}

export async function refreshStatus(
  api: KubusApiClient,
  kubo: KuboClient,
  store: LocalStore,
) {
  const state = store.snapshot();
  const [status, epoch, commitments] = await Promise.all([
    state.nodeId
      ? api.getNodeStatus(state.nodeId)
      : Promise.resolve(state.latestStatus),
    api.getCurrentEpoch(),
    state.nodeId
      ? api.getCurrentCommitments(state.nodeId)
      : Promise.resolve({ commitments: [] }),
  ]);
  await store.update((next) => {
    if (status) next.latestStatus = status;
    next.currentEpoch = epoch.epoch;
    next.activeCommitments = commitments.commitments;
    next.latestStatusRefreshAt = new Date().toISOString();
  });
  return { status, epoch, commitments, kubo: await getKuboHealth(kubo) };
}

export function buildStatusSummary(
  config: AppConfig,
  state: ReturnType<LocalStore["snapshot"]>,
  live?: { backendHealth?: unknown; kuboHealth?: unknown },
) {
  const backendWallet = state.latestStatus?.node?.operatorWalletAddress || null;
  const warnings = [];
  if (
    backendWallet &&
    backendWallet.toLowerCase() !== config.operatorWallet.toLowerCase()
  ) {
    warnings.push(
      `backend node wallet ${backendWallet} does not match KUBUS_OPERATOR_WALLET ${config.operatorWallet}`,
    );
  }
  return {
    backendUrl: config.apiBaseUrl,
    backendHealth: live?.backendHealth || "not_checked",
    operatorWallet: config.operatorWallet,
    nodeKeyFingerprint: state.nodeKey
      ? crypto
          .createHash("sha256")
          .update(state.nodeKey)
          .digest("hex")
          .slice(0, 16)
      : null,
    nodeId: state.nodeId || null,
    registered: Boolean(state.nodeId),
    kuboPeerId: state.peerId || null,
    kuboHealth: live?.kuboHealth || "not_checked",
    policyVersion: state.policy?.version || null,
    publicPinSetCount: state.publicPinSet?.length || 0,
    rewardableCidCount: state.rewardableCids?.length || 0,
    rewardableCidTotal: state.rewardableCidTotal ?? state.rewardableCids?.length ?? 0,
    desiredCidCount: state.desiredCids?.length || 0,
    pinnedCidCount: state.pinnedCids?.length || 0,
    failedCidCount: Object.keys(state.failedCids || {}).length,
    publicPinSetTotal: state.publicPinSetTotal ?? state.publicPinSet?.length ?? 0,
    pinnedRewardableCidCount: state.pinnedCids?.filter((cid) => (state.rewardableCids || []).some((item) => item.cid === cid)).length || 0,
    archiveContributionEstimate: buildLocalContributionEstimate(state, state.latestStatus),
    archiveContributionVerified: state.latestStatus?.archiveContribution || null,
    latestPublicPinSetSyncAt: state.latestPublicPinSetSyncAt || null,
    latestPinReconcileAt: state.latestPinReconcileAt || null,
    latestCommitmentRefreshAt: state.latestCommitmentRefreshAt || null,
    latestRewardsRefreshAt: state.latestRewardsRefreshAt || null,
    activeCommitmentCount: state.activeCommitments?.length || 0,
    lastHeartbeat: state.latestHeartbeat?.receivedAt || null,
    backendNodeStatus: state.latestStatus?.status || null,
    currentEpoch: state.currentEpoch?.epochKey || null,
    pendingKub8Rewards:
      state.rewards?.summary?.pendingKub8 ??
      state.latestStatus?.rewardSummary?.pendingKub8 ??
      0,
    gui: {
      enabled: config.guiEnabled === true,
      displayUrl: config.guiDisplayUrl || null,
      fallbackUrl: config.guiFallbackUrl || null,
      localhostOnly: !config.guiAllowRemote && ['127.0.0.1', 'localhost', '::1'].includes((config.guiHost || '').toLowerCase()),
      tokenConfigured: Boolean(config.guiToken),
    },
    warnings,
    stateUpdatedAt: state.updatedAt || null,
  };
}
