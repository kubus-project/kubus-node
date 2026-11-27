import { afterEach, describe, expect, it, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { LocalStore } from '../src/state/localStore.js';
import { CaptureStore } from '../src/captures/captureStore.js';
import { JobRuntime } from '../src/jobs/jobRuntime.js';
import { RemoteComputeRuntime } from '../src/compute/remoteComputeRuntime.js';
import type { RemoteRuntimeRecord } from '../src/compute/providerCleanup.js';
import type { RemoteComputeJob } from '../src/backend/models.js';
import { syntheticCid } from './fixtures/contentIds.js';

// Provider capacity is counted from the Node's own job records, so a record that keeps the state of a job the backend has
// already ended takes a slot for good. These tests pin the record to what the backend reports.

const HOUR = 60 * 60_000;
const ids = ['11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222', '33333333-3333-4333-8333-333333333333', '44444444-4444-4444-8444-444444444444'];
const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});

/** A record as an older Node left it: the job ran, the cleanup journal finished, the state still says RUNNING. */
function staleRecord(id: string, overrides: Partial<RemoteRuntimeRecord> = {}, leaseEnd = Date.now() + HOUR): RemoteRuntimeRecord {
  return {
    backendJobId: id, captureId: `remote-${id}`, role: 'provider', state: 'RUNNING', updatedAt: new Date(Date.now() - 2 * HOUR).toISOString(),
    cleanup: { version: 1, inputCid: syntheticCid(`input-${id}`), expiresAt: new Date(leaseEnd).toISOString(), requested: true, plaintext: 'complete', inputPinReleasePending: false, pinOwner: `provider-input:${id}` },
    ...overrides,
  };
}

function backendJob(id: string, state: string): RemoteComputeJob {
  return {
    id, type: 'spatial.optimize', state, inputCid: syntheticCid(`input-${id}`), inputHash: 'synthetic-hash', inputBytes: 5, inputKeyEnvelope: {},
    expiresAt: new Date(Date.now() + HOUR).toISOString(),
  } as RemoteComputeJob;
}

async function fixture(records: RemoteRuntimeRecord[]) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'kubus-provider-records-'));
  roots.push(root);
  const store = new LocalStore(path.join(root, 'state.json'));
  await store.load();
  await store.update((state) => {
    state.nodeId = 'synthetic-node';
    for (const record of records) (state.remoteJobs ??= {})[record.backendJobId] = record;
  });
  const captures = new CaptureStore(root, store);
  const warn = vi.fn();
  const api = {
    getProviderComputeJobs: vi.fn(async () => ({ jobs: [] as RemoteComputeJob[] })),
    transitionProviderComputeJob: vi.fn(async (_id: string, payload: { state: string }) => ({ state: payload.state })),
  };
  const jobs = new JobRuntime({
    store, captureStore: captures, kubo: {} as never, logger: { warn } as never, dataRoot: root, concurrency: 0,
    participationGate: { assertUsefulOperation: async () => undefined } as never, workerAuth: { issue: async () => 'synthetic' } as never,
  });
  const decrypt = vi.fn(async (_encrypted: unknown, _envelope: unknown, directory: string) => {
    await fs.mkdir(directory, { recursive: true });
    await fs.writeFile(path.join(directory, 'capture.json'), JSON.stringify({ schema: 'kubus.capture/1', artworkId: 'synthetic-art', files: [] }));
  });
  const runtime = new RemoteComputeRuntime({
    store, captures, jobs,
    config: { localDataPath: root, offerRemoteCompute: true, remoteComputePaused: false, remoteComputeMaxConcurrency: 1, remoteComputeMaxQueueDepth: 2,
      remoteComputeMaxInputBytes: 1024, operatorToken: 'synthetic-token', managedPinReleaseEnabled: true } as never,
    kubo: { pinAdd: async () => undefined, pinRm: async () => undefined, pinLs: async () => ({ Keys: {} }), cat: async () => new Uint8Array(5) } as never,
    api: api as never, transport: { decryptToDirectory: decrypt } as never, identity: {} as never,
    gate: { assertUsefulOperation: async () => undefined } as never, logger: { warn, info: () => undefined } as never,
  });
  const poll = () => (runtime as unknown as { pollProvider: () => Promise<number> }).pollProvider();
  const record = (id: string) => store.snapshot().remoteJobs?.[id] as RemoteRuntimeRecord;
  return { store, api, poll, record, warn, runtime };
}

const declined = (api: Awaited<ReturnType<typeof fixture>>['api']) =>
  api.transitionProviderComputeJob.mock.calls.filter(([, payload]) => (payload as { state: string }).state === 'DECLINED');

describe('a provider record takes the state the backend reports for its job', () => {
  it('records every terminal state, and a fourth job is accepted after three have ended (it was declined as provider_capacity_full)', async () => {
    const [cancelled, failed, expired, fresh] = ids as [string, string, string, string];
    const { api, poll, record } = await fixture([cancelled, failed, expired].map(id => staleRecord(id)));
    // The new job comes first in the list on purpose: the three ended ones must already be free when it is counted.
    api.getProviderComputeJobs.mockResolvedValueOnce({ jobs: [backendJob(fresh, 'MATCHED'), backendJob(cancelled, 'CANCELLED'), backendJob(failed, 'FAILED'), backendJob(expired, 'EXPIRED')] });
    await poll();
    expect([cancelled, failed, expired].map(id => record(id).state)).toEqual(['CANCELLED', 'FAILED', 'EXPIRED']);
    expect(declined(api)).toEqual([]);
    expect(api.transitionProviderComputeJob).toHaveBeenCalledWith(fresh, expect.objectContaining({ state: 'ACCEPTED' }));
    expect(record(fresh)).toMatchObject({ role: 'provider', state: 'RUNNING' });
  });

  it('the same list with the three jobs still running is declined as provider_capacity_full', async () => {
    const [a, b, c, fresh] = ids as [string, string, string, string];
    const running = (id: string) => staleRecord(id, { cleanup: { ...staleRecord(id).cleanup!, requested: false, plaintext: 'pending' } });
    const { api, poll, record } = await fixture([a, b, c].map(running));
    api.getProviderComputeJobs.mockResolvedValueOnce({ jobs: [backendJob(fresh, 'MATCHED'), ...[a, b, c].map(id => backendJob(id, 'RUNNING'))] });
    await poll();
    expect(declined(api)).toHaveLength(1);
    expect(declined(api)[0]![1]).toMatchObject({ metadata: { code: 'provider_capacity_full' } });
    expect(record(a).state).toBe('RUNNING');
  });

  it.each(['CANCELLED', 'FAILED', 'EXPIRED', 'DECLINED', 'COMPLETED', 'DISPUTED'])('records %s', async (state) => {
    const id = ids[0]!;
    const { api, poll, record } = await fixture([staleRecord(id)]);
    api.getProviderComputeJobs.mockResolvedValueOnce({ jobs: [backendJob(id, state)] });
    await poll();
    expect(record(id).state).toBe(state);
  });

  it('records the state even when the cleanup throws, and leaves the cleanup journal to say it is blocked', async () => {
    const id = ids[0]!;
    // A record whose capture id does not belong to the job: the cleanup refuses it, as it would any foreign directory.
    const { api, poll, record, runtime } = await fixture([staleRecord(id, { captureId: 'remote-someone-else', cleanup: { ...staleRecord(id).cleanup!, requested: false, plaintext: 'pending' } })]);
    api.getProviderComputeJobs.mockResolvedValueOnce({ jobs: [backendJob(id, 'CANCELLED')] });
    await poll();
    expect(record(id).state).toBe('CANCELLED');
    expect(record(id).cleanup).toMatchObject({ plaintext: 'blocked', reason: 'provider_cleanup_retry_required' });
    // The journal, not the record state, is what keeps a new job from being accepted while plaintext may remain.
    expect(runtime.cleanupDiagnostics().plaintextBlocked).toBe(1);
  });

  it('does not rewrite a record whose state already matches', async () => {
    const id = ids[0]!;
    const { api, poll, record, runtime } = await fixture([staleRecord(id, { state: 'CANCELLED' })]);
    const write = vi.spyOn(runtime as unknown as { updateRecord: () => Promise<void> }, 'updateRecord');
    api.getProviderComputeJobs.mockResolvedValueOnce({ jobs: [backendJob(id, 'CANCELLED')] });
    await poll();
    expect(record(id).state).toBe('CANCELLED');
    expect(write).not.toHaveBeenCalled();
  });
});

describe('records for jobs the backend no longer lists', () => {
  it('releases a capacity-holding record whose lease ended long ago, and keeps its cleanup journal as it was', async () => {
    const [gone, live, recent, fresh] = ids as [string, string, string, string];
    const journal = staleRecord(gone).cleanup;
    const { api, poll, record } = await fixture([
      staleRecord(gone, {}, Date.now() - HOUR),
      staleRecord(live, {}, Date.now() + HOUR),
      staleRecord(recent, {}, Date.now() - 60_000),
    ]);
    api.getProviderComputeJobs.mockResolvedValueOnce({ jobs: [backendJob(fresh, 'MATCHED')] });
    await poll();
    expect(record(gone)).toMatchObject({ state: 'EXPIRED', reconciled: 'absent_past_lease' });
    expect(record(gone).cleanup).toMatchObject({ ...journal, expiresAt: expect.any(String) });
    // A lease still running, or ended a minute ago (the backend's own expiry sweep has not necessarily listed it yet), is kept.
    expect(record(live).state).toBe('RUNNING');
    expect(record(recent).state).toBe('RUNNING');
  });

  it('three stale records from an older version no longer fill the provider: the next job is accepted', async () => {
    const [a, b, c, fresh] = ids as [string, string, string, string];
    const { api, poll, record } = await fixture([a, b, c].map(id => staleRecord(id, {}, Date.now() - 3 * HOUR)));
    api.getProviderComputeJobs.mockResolvedValueOnce({ jobs: [backendJob(fresh, 'MATCHED')] });
    await poll();
    expect(declined(api)).toEqual([]);
    expect(api.transitionProviderComputeJob).toHaveBeenCalledWith(fresh, expect.objectContaining({ state: 'ACCEPTED' }));
    expect(record(a).state).toBe('EXPIRED');
  });

  it('a record from before the cleanup journal has no lease: it is released only after a week', async () => {
    const [old, young] = ids as [string, string];
    const legacy = (id: string, age: number): RemoteRuntimeRecord => ({ backendJobId: id, role: 'provider', state: 'RUNNING', updatedAt: new Date(Date.now() - age).toISOString() });
    const { api, poll, record } = await fixture([legacy(old, 8 * 24 * HOUR), legacy(young, 24 * HOUR)]);
    api.getProviderComputeJobs.mockResolvedValueOnce({ jobs: [] });
    await poll();
    expect(record(old).state).toBe('EXPIRED');
    expect(record(young).state).toBe('RUNNING');
  });

  it('a failed list leaves every record alone: absence is only read from a list the backend returned', async () => {
    const id = ids[0]!;
    const { api, poll, record } = await fixture([staleRecord(id, {}, Date.now() - 3 * HOUR)]);
    api.getProviderComputeJobs.mockRejectedValueOnce(new Error('backend unavailable'));
    await poll();
    expect(record(id).state).toBe('RUNNING');
  });
});
