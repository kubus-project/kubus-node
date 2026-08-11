import type { AppConfig } from '../config/schema.js';
import type { KuboClient } from '../ipfs/kuboClient.js';
import { localError } from '../localApi/pairingService.js';
import type { LocalStore } from '../state/localStore.js';

export type ParticipationState = 'UNCONFIGURED' | 'JOINING' | 'CONTRIBUTING' | 'DEGRADED' | 'LOCKED';

export interface ParticipationSnapshot {
  state: ParticipationState;
  reason: string;
  leaseEligible: boolean;
  leaseExpiresAt?: string;
  graceExpiresAt?: string;
  requirements: Record<string, boolean>;
}

export class NetworkParticipationGate {
  private schedulerActive = false;
  private latest: ParticipationSnapshot = {
    state: 'UNCONFIGURED', reason: 'operator_identity_unconfigured', leaseEligible: false, requirements: {},
  };

  constructor(private readonly deps: { store: LocalStore; config: AppConfig; kubo: KuboClient; now?: () => Date }) {}

  setSchedulerActive(active: boolean): void {
    this.schedulerActive = active;
  }

  snapshot(): ParticipationSnapshot {
    return structuredClone(this.latest);
  }

  async refresh(): Promise<ParticipationSnapshot> {
    const now = (this.deps.now ?? (() => new Date()))();
    const state = this.deps.store.snapshot();
    const policyMinimum = Math.max(Number(state.policy?.minimumContributionCapacityBytes || 0), 1);
    const freshnessMs = Math.max(Number(state.policy?.cidSyncIntervalMs || 300000) * 3, 5 * 60 * 1000);
    const fresh = (value?: string) => Boolean(value && now.getTime() - new Date(value).getTime() <= freshnessMs);
    let kuboHealthy = false;
    try { await this.deps.kubo.id(); kuboHealthy = true; } catch { kuboHealthy = false; }
    const requirements = {
      operatorIdentity: Boolean(this.deps.config.operatorWallet && this.deps.config.operatorToken),
      registered: Boolean(state.nodeId && state.node && ['active', 'registered'].includes(state.node.status)),
      backendPolicy: Boolean(state.policy?.version),
      kuboHealthy,
      publicPinningEnabled: !this.deps.config.skipPinning,
      contributionCapacity: this.deps.config.maxPinnedBytes >= policyMinimum,
      canonicalPinSetSynchronized: fresh(state.latestPublicPinSetSyncAt),
      pinReconciliationHealthy: fresh(state.latestPinReconcileAt) && Object.keys(state.failedCids).length <= Math.max(1, Math.floor(state.desiredCids.length * 0.25)),
      schedulerActive: this.schedulerActive,
      heartbeatAccepted: fresh(state.latestHeartbeatAt),
      productionPinningSafe: !(this.deps.config.isProduction && this.deps.config.skipPinning),
    };
    const missing = Object.entries(requirements).filter(([, ok]) => !ok).map(([name]) => name);
    const persisted = state.participation;
    const leaseExpiresMs = persisted?.leaseExpiresAt ? new Date(persisted.leaseExpiresAt).getTime() : 0;
    const graceExpiresMs = persisted?.graceExpiresAt ? new Date(persisted.graceExpiresAt).getTime() : 0;
    let next: ParticipationSnapshot;
    if (!requirements.operatorIdentity || !requirements.backendPolicy) {
      next = { state: 'UNCONFIGURED', reason: missing[0] || 'unconfigured', leaseEligible: false, requirements };
    } else if (missing.length === 0) {
      next = { state: 'CONTRIBUTING', reason: 'verified_archive_participation', leaseEligible: true, leaseExpiresAt: persisted?.leaseExpiresAt, graceExpiresAt: persisted?.graceExpiresAt, requirements };
    } else if (leaseExpiresMs > now.getTime()) {
      next = { state: 'DEGRADED', reason: missing.join(','), leaseEligible: true, leaseExpiresAt: persisted?.leaseExpiresAt, graceExpiresAt: persisted?.graceExpiresAt, requirements };
    } else if (graceExpiresMs > now.getTime()) {
      next = { state: 'DEGRADED', reason: missing.join(','), leaseEligible: true, leaseExpiresAt: persisted?.leaseExpiresAt, graceExpiresAt: persisted?.graceExpiresAt, requirements };
    } else if (persisted?.lastVerifiedAt) {
      next = { state: 'LOCKED', reason: missing.join(','), leaseEligible: false, leaseExpiresAt: persisted?.leaseExpiresAt, graceExpiresAt: persisted?.graceExpiresAt, requirements };
    } else {
      next = { state: 'JOINING', reason: missing.join(','), leaseEligible: false, requirements };
    }
    this.latest = next;
    await this.deps.store.update((draft) => {
      draft.participation = { ...draft.participation, state: next.state, reason: next.reason, leaseExpiresAt: next.leaseExpiresAt, graceExpiresAt: next.graceExpiresAt };
    });
    return this.snapshot();
  }

  async recordHeartbeatAccepted(): Promise<ParticipationSnapshot> {
    const now = (this.deps.now ?? (() => new Date()))();
    const state = this.deps.store.snapshot();
    const leaseSeconds = Math.max(Number(state.policy?.participationLeaseSeconds || 180), 30);
    const graceSeconds = Math.max(Number(state.policy?.participationGraceSeconds || this.deps.config.participationGraceMs / 1000), 60);
    await this.deps.store.update((draft) => {
      draft.participation = {
        state: 'CONTRIBUTING', reason: 'heartbeat_accepted', lastVerifiedAt: now.toISOString(),
        leaseExpiresAt: new Date(now.getTime() + leaseSeconds * 1000).toISOString(),
        graceExpiresAt: new Date(now.getTime() + (leaseSeconds + graceSeconds) * 1000).toISOString(),
      };
    });
    return this.refresh();
  }

  async assertUsefulOperation(operation: string): Promise<void> {
    const snapshot = await this.refresh();
    if (!snapshot.leaseEligible || !['CONTRIBUTING', 'DEGRADED'].includes(snapshot.state)) {
      throw localError(423, 'NETWORK_PARTICIPATION_REQUIRED', {
        operation, participationState: snapshot.state, reason: snapshot.reason,
        message: 'Active public archive participation is required for new spatial compute jobs.',
      });
    }
  }
}
