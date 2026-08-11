import { afterEach, describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AppConfig } from '../src/config/schema.js';
import { NetworkParticipationGate } from '../src/participation/networkParticipationGate.js';
import { LocalStore } from '../src/state/localStore.js';

const dirs: string[] = [];
afterEach(async () => Promise.all(dirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true }))));

async function fixture(options: {
  maxPinnedBytes?: number;
  archiveReconciled?: boolean;
  identity?: boolean;
  scheduler?: boolean;
  skipPinning?: boolean;
} = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'kubus-gate-')); dirs.push(dir);
  const statePath = path.join(dir, 'state.json');
  const store = new LocalStore(statePath); await store.load();
  const now = new Date('2026-08-11T12:00:00.000Z');
  const config = {
    operatorWallet: options.identity === false ? '' : 'wallet-1',
    operatorToken: options.identity === false ? '' : 'token',
    maxPinnedBytes: options.maxPinnedBytes ?? 20 * 1024 ** 3,
    skipPinning: options.skipPinning ?? false,
    isProduction: true,
    participationGraceMs: 900000,
  } as AppConfig;
  let kuboHealthy = true;
  const kubo = { id: async () => { if (!kuboHealthy) throw new Error('offline'); return { ID: 'peer' }; } };
  const gate = new NetworkParticipationGate({ store, config, kubo: kubo as never, now: () => now });
  gate.setSchedulerActive(options.scheduler !== false);
  await store.update((state) => {
    state.nodeId = '11111111-1111-4111-8111-111111111111';
    state.node = { id: state.nodeId!, nodeKey: 'key', endpointUrl: 'http://node', status: 'active' };
    state.policy = { version: 'availability-v2', rewardableContentSource: 'registry', maxPinnedCidsDefault: 100, minimumContributionCapacityBytes: 10 * 1024 ** 3, participationLeaseSeconds: 120, participationGraceSeconds: 600, commitmentTtlHours: 24, heartbeatIntervalMs: 60000, cidSyncIntervalMs: 300000, verification: {}, rewards: {}, statuses: {} };
    state.latestPublicPinSetSyncAt = now.toISOString();
    state.latestHeartbeatAt = now.toISOString();
    if (options.archiveReconciled !== false) {
      state.desiredCids = [{ id: 'pin-1', cid: `Qm${'a'.repeat(44)}`, role: 'record' }];
      state.pinnedCids = [state.desiredCids[0]!.cid];
      state.latestPinReconcileAt = now.toISOString();
    }
  });
  return {
    gate, store, statePath, config, kubo, now,
    setKuboHealthy: (value: boolean) => { kuboHealthy = value; },
  };
}

describe('NetworkParticipationGate', () => {
  it('keeps a node without operator identity UNCONFIGURED and denies useful work', async () => {
    const { gate } = await fixture({ identity: false });
    expect((await gate.refresh()).state).toBe('UNCONFIGURED');
    await expect(gate.assertUsefulOperation('spatial.reconstruct')).rejects.toMatchObject({ code: 'NETWORK_PARTICIPATION_REQUIRED', statusCode: 423 });
  });

  it('keeps a fresh heartbeat-only node JOINING until archive reconciliation succeeds', async () => {
    const { gate, store } = await fixture({ archiveReconciled: false });
    expect((await gate.recordHeartbeatAccepted()).state).toBe('JOINING');
    expect(store.snapshot().participation?.lastVerifiedAt).toBeUndefined();
    await expect(gate.assertUsefulOperation('spatial.reconstruct')).rejects.toMatchObject({ code: 'NETWORK_PARTICIPATION_REQUIRED' });
  });

  it('does not accept configured capacity or an empty pin plan as contribution proof', async () => {
    const { gate } = await fixture({ archiveReconciled: false, maxPinnedBytes: 100 * 1024 ** 3 });
    const snapshot = await gate.recordHeartbeatAccepted();
    expect(snapshot.requirements.contributionCapacity).toBe(true);
    expect(snapshot.requirements.actualContributionStateVerified).toBe(false);
    expect(snapshot.leaseEligible).toBe(false);
  });

  it('does not grant a useful-operation lease when pinning is skipped', async () => {
    const { gate } = await fixture({ skipPinning: true });
    expect((await gate.recordHeartbeatAccepted()).state).toBe('JOINING');
    await expect(gate.assertUsefulOperation('spatial.reconstruct')).rejects.toMatchObject({ code: 'NETWORK_PARTICIPATION_REQUIRED' });
  });

  it('enters CONTRIBUTING only after all archive checks and an accepted heartbeat coincide', async () => {
    const { gate, store } = await fixture();
    expect((await gate.refresh()).state).toBe('JOINING');
    const verified = await gate.recordHeartbeatAccepted();
    expect(verified.state).toBe('CONTRIBUTING');
    expect(verified.verificationGeneration).toBe(1);
    expect(store.snapshot().participation?.lastVerifiedAt).toBeTruthy();
    await expect(gate.assertUsefulOperation('spatial.reconstruct')).resolves.toBeUndefined();
  });

  it('allows degraded grace only after genuine prior contribution and locks after expiry', async () => {
    const { gate, now, setKuboHealthy } = await fixture();
    await gate.recordHeartbeatAccepted();
    setKuboHealthy(false);
    expect((await gate.refresh()).state).toBe('DEGRADED');
    await expect(gate.assertUsefulOperation('spatial.reconstruct')).resolves.toBeUndefined();
    now.setMinutes(now.getMinutes() + 20);
    expect((await gate.refresh()).state).toBe('LOCKED');
    await expect(gate.assertUsefulOperation('spatial.reconstruct')).rejects.toMatchObject({ code: 'NETWORK_PARTICIPATION_REQUIRED' });
  });

  it('does not turn a never-verified node into DEGRADED after restart', async () => {
    const { gate, store, statePath, config, kubo } = await fixture({ archiveReconciled: false });
    await gate.recordHeartbeatAccepted();
    await store.load();
    const restartedStore = new LocalStore(statePath); await restartedStore.load();
    const restarted = new NetworkParticipationGate({ store: restartedStore, config, kubo: kubo as never });
    restarted.setSchedulerActive(true);
    const snapshot = await restarted.refresh();
    expect(snapshot.state).toBe('JOINING');
    expect(snapshot.leaseEligible).toBe(false);
  });

  it('never makes GUI-only mode processing-ready', async () => {
    const { gate } = await fixture({ scheduler: false });
    expect((await gate.recordHeartbeatAccepted()).state).toBe('JOINING');
    await expect(gate.assertUsefulOperation('spatial.reconstruct')).rejects.toMatchObject({ code: 'NETWORK_PARTICIPATION_REQUIRED' });
  });
});
