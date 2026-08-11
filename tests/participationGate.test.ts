import { afterEach, describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AppConfig } from '../src/config/schema.js';
import { NetworkParticipationGate } from '../src/participation/networkParticipationGate.js';
import { LocalStore } from '../src/state/localStore.js';

const dirs: string[] = [];
afterEach(async () => Promise.all(dirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true }))));

async function fixture(maxPinnedBytes = 20 * 1024 ** 3) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'kubus-gate-')); dirs.push(dir);
  const store = new LocalStore(path.join(dir, 'state.json')); await store.load();
  const now = new Date('2026-08-11T12:00:00.000Z');
  const config = { operatorWallet: 'wallet-1', operatorToken: 'token', maxPinnedBytes, skipPinning: false, isProduction: true, participationGraceMs: 900000 } as AppConfig;
  let kuboHealthy = true;
  const kubo = { id: async () => { if (!kuboHealthy) throw new Error('offline'); return { ID: 'peer' }; } };
  const gate = new NetworkParticipationGate({ store, config, kubo: kubo as never, now: () => now });
  gate.setSchedulerActive(true);
  await store.update((state) => {
    state.nodeId = '11111111-1111-4111-8111-111111111111';
    state.node = { id: state.nodeId!, nodeKey: 'key', endpointUrl: 'http://node', status: 'active' };
    state.policy = { version: 'availability-v2', rewardableContentSource: 'registry', maxPinnedCidsDefault: 100, minimumContributionCapacityBytes: 10 * 1024 ** 3, participationLeaseSeconds: 120, participationGraceSeconds: 600, commitmentTtlHours: 24, heartbeatIntervalMs: 60000, cidSyncIntervalMs: 300000, verification: {}, rewards: {}, statuses: {} };
    state.latestPublicPinSetSyncAt = now.toISOString(); state.latestPinReconcileAt = now.toISOString(); state.latestHeartbeatAt = now.toISOString();
  });
  return { gate, store, now, setKuboHealthy: (value: boolean) => { kuboHealthy = value; } };
}

describe('NetworkParticipationGate', () => {
  it('blocks useful compute for an unregistered node', async () => {
    const { gate, store } = await fixture();
    await store.update((state) => { state.nodeId = undefined; state.node = null; state.participation = undefined; });
    await expect(gate.assertUsefulOperation('spatial.reconstruct')).rejects.toMatchObject({ code: 'NETWORK_PARTICIPATION_REQUIRED', statusCode: 423 });
  });

  it('does not accept a one-byte or otherwise insufficient capacity commitment', async () => {
    const { gate } = await fixture(1);
    await expect(gate.assertUsefulOperation('spatial.reconstruct')).rejects.toMatchObject({ code: 'NETWORK_PARTICIPATION_REQUIRED' });
    expect((await gate.refresh()).requirements.contributionCapacity).toBe(false);
  });

  it('enters CONTRIBUTING only after verified requirements and an accepted heartbeat', async () => {
    const { gate } = await fixture();
    const verified = await gate.recordHeartbeatAccepted();
    expect(verified.state).toBe('CONTRIBUTING');
    await expect(gate.assertUsefulOperation('spatial.reconstruct')).resolves.toBeUndefined();
  });

  it('uses a degraded lease for a short outage and locks new jobs after grace', async () => {
    const { gate, now, setKuboHealthy } = await fixture();
    await gate.recordHeartbeatAccepted(); setKuboHealthy(false);
    expect((await gate.refresh()).state).toBe('DEGRADED');
    await expect(gate.assertUsefulOperation('spatial.reconstruct')).resolves.toBeUndefined();
    now.setMinutes(now.getMinutes() + 20);
    const locked = await gate.refresh();
    expect(locked.state).toBe('LOCKED');
    await expect(gate.assertUsefulOperation('spatial.reconstruct')).rejects.toMatchObject({ code: 'NETWORK_PARTICIPATION_REQUIRED' });
  });
});
