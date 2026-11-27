import crypto from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import stableStringify from 'json-stable-stringify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RemoteComputeJob } from '../src/backend/models.js';
import { ComputeIdentityService } from '../src/compute/computeIdentity.js';
import {
  PROVIDER_CLEANUP_SCHEMA, ProviderCleanupAttestor, cleanupAttestationMessage, verifyProviderCleanupAttestation,
  type ProviderCleanupPayload,
} from '../src/compute/providerCleanupAttestation.js';
import { RemoteComputeRuntime } from '../src/compute/remoteComputeRuntime.js';
import { LocalStore } from '../src/state/localStore.js';
import { canonicalPinCid } from '../src/utils/cid.js';
import { syntheticCid } from './fixtures/contentIds.js';

const jobId = '8a1d0c61-2e5d-4a3f-9d52-3f1f0f0a0b01';
const localId = 'c3c3c3c3-c3c3-4c3c-8c3c-c3c3c3c3c3c3';
const providerNodeId = '66666666-6666-4666-8666-666666666666';
const inputHash = 'a'.repeat(64);
const roots: string[] = [];
let store: LocalStore;
let identity: ComputeIdentityService;
let signingKey: string;
let clock: number;

beforeEach(async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'kubus-attestation-'));
  roots.push(root);
  store = new LocalStore(path.join(root, 'state.json'));
  await store.load();
  await store.update(state => { state.nodeId = providerNodeId; });
  identity = new ComputeIdentityService(store);
  signingKey = (await identity.publicIdentity()).signingPublicKey;
  clock = Date.parse('2026-11-27T10:00:00.000Z');
});
afterEach(async () => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});

function job(state = 'COMPLETED', extra: Record<string, unknown> = {}): RemoteComputeJob {
  return {
    id: jobId, providerNodeId, type: 'spatial.reconstruct', protocolVersion: 'kubus.compute/1', jobSpecVersion: 'kubus.spatial-job/1', requirements: {},
    inputCid: 'bafyinput', inputBytes: 10, inputHash, inputKeyEnvelope: {}, canonicalJobSpec: { processing: { outputMode: 'kubus.private-output/1' } },
    jobSpecHash: 'b'.repeat(64), state, createdAt: '2026-11-27T09:00:00.000Z', expiresAt: '', outputCids: [], verification: { providerSigningPublicKey: signingKey },
    ...extra,
  } as RemoteComputeJob;
}

/** The local journals of a provider that took the job, ran it, cleaned up and released its sealed outputs. */
async function tidyProvider(overrides: { sealedReleased?: boolean; plaintext?: 'complete' | 'blocked'; workJournal?: 'complete' | 'blocked' } = {}) {
  const cid = canonicalPinCid(syntheticCid('sealed-1'));
  await store.update(state => {
    state.remoteJobs = { [jobId]: { backendJobId: jobId, role: 'provider', state: 'OUTPUT_READY', updatedAt: '', localJobId: localId,
      cleanup: { version: 1, inputCid: 'bafyinput', expiresAt: '2030-01-01T00:00:00.000Z', requested: true, plaintext: overrides.plaintext ?? 'complete',
        inputPinReleasePending: false, receivedAt: '2026-11-27T09:01:00.000Z', decryptedInputRemoved: true } } };
    state.jobs = { [localId]: { id: localId, input: { remoteComputeJobId: jobId }, state: 'completed', startedAt: '2026-11-27T09:02:00.000Z', completedAt: '2026-11-27T09:30:00.000Z' } };
    state.jobCleanup = { [localId]: { version: 1, jobId: localId, type: 'spatial.reconstruct', state: overrides.workJournal ?? 'complete', workerAttempted: true, removed: true, updatedAt: '' } };
    state.privateComputeCids = { [cid]: { jobId, role: 'private_output', createdAt: '', pinOwner: `provider-output:${jobId}`, ...(overrides.sealedReleased === false ? {} : { releasedAt: '2026-11-27T09:40:00.000Z' }) } };
    state.managedPins = { [cid]: { cid, ownership: 'created', owners: {}, state: overrides.sealedReleased === false ? 'release_pending' : 'released', updatedAt: '' } };
  });
}

function attestor(submit: ReturnType<typeof vi.fn>) {
  return new ProviderCleanupAttestor({
    store, nodeId: () => store.snapshot().nodeId, now: () => clock,
    logger: { warn: vi.fn(), info: vi.fn() },
    sign: payload => identity.signProviderCleanup(payload), submit: submit as never,
  });
}

async function signedFor(payload: ProviderCleanupPayload) {
  return { payload, signature: await identity.signProviderCleanup(payload) };
}

function payloadFor(overrides: Partial<ProviderCleanupPayload> = {}): ProviderCleanupPayload {
  return {
    schema: PROVIDER_CLEANUP_SCHEMA, jobId, providerNodeId, inputHash, finalState: 'COMPLETED', receivedAt: '2026-11-27T09:01:00.000Z',
    workerStartedAt: null, workerFinishedAt: null, cancelledAt: null,
    items: { decryptedInput: 'deleted', workDirectory: 'deleted', plaintextOutputs: 'deleted', sealedOutputs: 'deleted' }, outputPins: 'released',
    state: 'complete', reason: null, completedAt: '2026-11-27T10:00:00.000Z', ...overrides,
  };
}

describe('provider cleanup attestation signature', () => {
  it('is signed over a domain-prefixed canonical payload that verifies against the pinned provider key', async () => {
    const attestation = await signedFor(payloadFor());
    expect(cleanupAttestationMessage(attestation.payload).toString('utf8').startsWith(`${PROVIDER_CLEANUP_SCHEMA}\n`)).toBe(true);
    expect(verifyProviderCleanupAttestation(job(), attestation)).toEqual(attestation.payload);
  });

  it('a job receipt signature cannot stand for an attestation, nor the reverse (domain separation)', async () => {
    const payload = payloadFor();
    const receiptStyle = await identity.signPayload(payload as unknown as Record<string, unknown>);
    expect(() => verifyProviderCleanupAttestation(job(), { payload, signature: receiptStyle })).toThrow('provider_cleanup_signature_invalid');
    const cleanupSignature = await identity.signProviderCleanup(payload);
    const publicKey = crypto.createPublicKey({ key: Buffer.from(signingKey, 'base64'), format: 'der', type: 'spki' });
    expect(crypto.verify(null, Buffer.from(stableStringify(payload) ?? ''), publicKey, Buffer.from(cleanupSignature, 'base64'))).toBe(false);
  });

  it('rejects a statement for another job, provider, input or state, a tampered item, an inconsistent state and a foreign key', async () => {
    const good = await signedFor(payloadFor());
    const cases: Array<[string, RemoteComputeJob | unknown, string]> = [
      ['job', job('COMPLETED', { id: '8a1d0c61-2e5d-4a3f-9d52-3f1f0f0a0b02' }), 'provider_cleanup_job_mismatch'],
      ['provider', job('COMPLETED', { providerNodeId: '77777777-7777-4777-8777-777777777777' }), 'provider_cleanup_provider_mismatch'],
      ['input', job('COMPLETED', { inputHash: 'c'.repeat(64) }), 'provider_cleanup_input_mismatch'],
      ['state', job('FAILED'), 'provider_cleanup_state_mismatch'],
      ['not terminal', job('RUNNING'), 'provider_cleanup_state_mismatch'],
      ['no key', job('COMPLETED', { verification: {} }), 'provider_cleanup_key_unavailable'],
    ];
    for (const [label, view, code] of cases) {
      expect(() => verifyProviderCleanupAttestation(view as RemoteComputeJob, good), label).toThrow(code);
    }
    const tampered = { payload: { ...good.payload, items: { ...good.payload.items, sealedOutputs: 'not_present' } }, signature: good.signature };
    expect(() => verifyProviderCleanupAttestation(job(), tampered)).toThrow('provider_cleanup_signature_invalid');
    const lying = await signedFor(payloadFor({ items: { ...payloadFor().items, workDirectory: 'failed' }, state: 'complete' }));
    expect(() => verifyProviderCleanupAttestation(job(), lying)).toThrow('provider_cleanup_state_inconsistent');
    const other = crypto.generateKeyPairSync('ed25519');
    const foreign = { payload: good.payload, signature: crypto.sign(null, cleanupAttestationMessage(good.payload), other.privateKey).toString('base64') };
    expect(() => verifyProviderCleanupAttestation(job(), foreign)).toThrow('provider_cleanup_signature_invalid');
    expect(() => verifyProviderCleanupAttestation(job(), { payload: { ...good.payload, schema: 'kubus.provider-cleanup/2' }, signature: good.signature })).toThrow('provider_cleanup_schema_invalid');
    expect(() => verifyProviderCleanupAttestation(job(), null)).toThrow('provider_cleanup_attestation_malformed');
  });
});

describe('provider cleanup attestor', () => {
  it('builds a complete statement from the journals once the job is terminal, signs it and has it accepted', async () => {
    await tidyProvider();
    const submit = vi.fn(async (_id: string, _body: unknown) => ({}));
    await attestor(submit).attest(job('COMPLETED'));
    expect(submit).toHaveBeenCalledTimes(1);
    const [id, body] = submit.mock.calls[0] as unknown as [string, { nodeId: string; attestation: { payload: ProviderCleanupPayload; signature: string } }];
    expect(id).toBe(jobId);
    expect(body.nodeId).toBe(providerNodeId);
    expect(body.attestation.payload).toMatchObject({
      schema: PROVIDER_CLEANUP_SCHEMA, jobId, providerNodeId, inputHash, finalState: 'COMPLETED', state: 'complete', reason: null, outputPins: 'released',
      items: { decryptedInput: 'deleted', workDirectory: 'deleted', plaintextOutputs: 'deleted', sealedOutputs: 'deleted' },
      receivedAt: '2026-11-27T09:01:00.000Z', workerStartedAt: '2026-11-27T09:02:00.000Z', workerFinishedAt: '2026-11-27T09:30:00.000Z', cancelledAt: null,
    });
    expect(verifyProviderCleanupAttestation(job('COMPLETED'), body.attestation).state).toBe('complete');
    expect(store.snapshot().providerCleanupAttestations?.[jobId]).toMatchObject({ status: 'accepted' });
    // Nothing is re-sent for a job whose complete statement was accepted.
    await attestor(submit).attest(job('COMPLETED'));
    expect(submit).toHaveBeenCalledTimes(1);
  });

  it('never attests a job that is not terminal, so nothing is claimed while the sealed output must still be available', async () => {
    await tidyProvider();
    const submit = vi.fn(async (_id: string, _body: unknown) => ({}));
    for (const state of ['MATCHED', 'ACCEPTED', 'INPUT_READY', 'RUNNING', 'OUTPUT_READY']) await attestor(submit).attest(job(state));
    expect(submit).not.toHaveBeenCalled();
    expect(store.snapshot().providerCleanupAttestations).toBeUndefined();
  });

  it('states a failure as failed with a reason, and replaces it only with a better statement', async () => {
    await tidyProvider({ sealedReleased: false });
    const submit = vi.fn(async (_id: string, _body: unknown) => ({}));
    const instance = attestor(submit);
    await instance.attest(job('COMPLETED'));
    expect(submit.mock.calls[0]![1]).toMatchObject({ attestation: { payload: { state: 'failed', outputPins: 'failed', items: { sealedOutputs: 'failed', decryptedInput: 'deleted' }, reason: 'sealed_outputs_not_cleaned' } } });
    // Still failing on the next poll: the same failure is not sent again.
    await instance.attest(job('COMPLETED'));
    expect(submit).toHaveBeenCalledTimes(1);
    // The operator enabled pin release and the retry succeeded: a complete statement supersedes it.
    await tidyProvider({ sealedReleased: true });
    clock += 60_000;
    await instance.attest(job('COMPLETED'));
    expect(submit).toHaveBeenCalledTimes(2);
    expect(submit.mock.calls[1]![1]).toMatchObject({ attestation: { payload: { state: 'complete', outputPins: 'released' } } });
    await instance.attest(job('COMPLETED'));
    expect(submit).toHaveBeenCalledTimes(2);
  });

  it('plaintext that is still blocked or a work directory still being cleaned is stated as failed, never as deleted', async () => {
    await tidyProvider({ plaintext: 'blocked', workJournal: 'blocked' });
    const submit = vi.fn(async (_id: string, _body: unknown) => ({}));
    await attestor(submit).attest(job('FAILED'));
    expect(submit.mock.calls[0]![1]).toMatchObject({ attestation: { payload: { finalState: 'FAILED', state: 'failed', items: { decryptedInput: 'failed', workDirectory: 'failed', plaintextOutputs: 'failed' } } } });
  });

  it('a job that was declined before any data arrived is attested as not present everywhere', async () => {
    const submit = vi.fn(async (_id: string, _body: unknown) => ({}));
    await attestor(submit).attest(job('DECLINED'));
    expect(submit.mock.calls[0]![1]).toMatchObject({ attestation: { payload: { state: 'complete', outputPins: 'not_present',
      items: { decryptedInput: 'not_present', workDirectory: 'not_present', plaintextOutputs: 'not_present', sealedOutputs: 'not_present' } } } });
  });

  it('records a cancelled job with the time it was cancelled, kept stable across retries', async () => {
    await tidyProvider();
    const submit = vi.fn(async (_id: string, _body: unknown) => { throw Object.assign(new Error('offline'), { status: 503 }); });
    const instance = attestor(submit);
    await instance.attest(job('CANCELLED'));
    const first = store.snapshot().providerCleanupAttestations![jobId]!.payload.cancelledAt;
    expect(first).toBe('2026-11-27T10:00:00.000Z');
    clock += 3_600_000;
    await instance.retryDue();
    expect(store.snapshot().providerCleanupAttestations![jobId]!.payload.cancelledAt).toBe(first);
  });

  it('keeps an unaccepted statement, retries it with growing backoff, survives a restart and stops once it is accepted', async () => {
    await tidyProvider();
    const submit = vi.fn(async (_id: string, _body: unknown) => { throw Object.assign(new Error('backend down'), { status: 503 }); });
    await attestor(submit).attest(job('COMPLETED'));
    expect(submit).toHaveBeenCalledTimes(1);
    expect(store.snapshot().providerCleanupAttestations![jobId]).toMatchObject({ status: 'pending', attempts: 1, lastError: '503' });
    // Not due yet.
    await attestor(submit).retryDue();
    expect(submit).toHaveBeenCalledTimes(1);
    // A new process (new attestor over the same persisted store) retries after the backoff.
    clock += 6_000;
    await attestor(submit).retryDue();
    expect(submit).toHaveBeenCalledTimes(2);
    const second = Date.parse(store.snapshot().providerCleanupAttestations![jobId]!.nextAttemptAt) - clock;
    expect(second).toBeGreaterThanOrEqual(10_000);
    submit.mockResolvedValueOnce({} as never);
    clock += 60_000;
    await attestor(submit).retryDue();
    expect(store.snapshot().providerCleanupAttestations![jobId]).toMatchObject({ status: 'accepted' });
    clock += 3_600_000;
    await attestor(submit).retryDue();
    expect(submit).toHaveBeenCalledTimes(3);
    // The statement sent on every retry is the one signed at the time, byte for byte.
    expect(submit.mock.calls[0]![1]).toEqual(submit.mock.calls[2]![1]);
  });

  it('a statement the backend refuses for good is not retried forever', async () => {
    await tidyProvider();
    const submit = vi.fn(async (_id: string, _body: unknown) => { throw Object.assign(new Error('bad'), { status: 422, details: { code: 'COMPUTE_CLEANUP_INVALID' } }); });
    const instance = attestor(submit);
    await instance.attest(job('COMPLETED'));
    expect(store.snapshot().providerCleanupAttestations![jobId]).toMatchObject({ status: 'rejected', lastError: 'COMPUTE_CLEANUP_INVALID' });
    clock += 86_400_000;
    await instance.retryDue();
    await instance.attest(job('COMPLETED'));
    expect(submit).toHaveBeenCalledTimes(1);
  });

  it('another provider\'s job view is never attested', async () => {
    await tidyProvider();
    const submit = vi.fn(async (_id: string, _body: unknown) => ({}));
    await attestor(submit).attest(job('COMPLETED', { providerNodeId: '77777777-7777-4777-8777-777777777777' }));
    expect(submit).not.toHaveBeenCalled();
  });
});

describe('provider runtime: sealed outputs and the attestation follow the job, not the output', () => {
  function runtime(pinRm: ReturnType<typeof vi.fn>, submit: ReturnType<typeof vi.fn>) {
    const ensureJobQuiescent = vi.fn(async () => undefined);
    const instance = new RemoteComputeRuntime({
      api: { submitProviderCleanupAttestation: submit, transitionProviderComputeJob: vi.fn(async () => ({})) } as never,
      kubo: { pinRm, pinLs: vi.fn(async () => ({ Keys: {} })), pinAdd: vi.fn() } as never,
      store, config: { localDataPath: roots[0], managedPinReleaseEnabled: true, offerRemoteCompute: true } as never, captures: {} as never,
      jobs: { ensureJobQuiescent } as never, gate: {} as never, identity, transport: {} as never,
      logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() } as never,
    });
    return instance as unknown as { handleProviderJob(job: RemoteComputeJob): Promise<void> };
  }

  async function sealedJournal() {
    const cid = canonicalPinCid(syntheticCid('sealed-1'));
    await store.update(state => {
      state.remoteJobs = { [jobId]: { backendJobId: jobId, role: 'provider', state: 'OUTPUT_READY', updatedAt: '', cleanup: { version: 1, inputCid: 'bafyinput',
        expiresAt: '2030-01-01T00:00:00.000Z', requested: true, plaintext: 'complete', inputPinReleasePending: false, receivedAt: '2026-11-27T09:01:00.000Z' } } };
      state.privateComputeCids = { [cid]: { jobId, role: 'private_output', createdAt: '', pinOwner: `provider-output:${jobId}` } };
      state.managedPins = { [cid]: { cid, ownership: 'created', owners: { [`provider-output:${jobId}`]: { createdAt: '' } }, state: 'pinned', updatedAt: '' } };
    });
    return cid;
  }

  it('keeps the sealed output pinned and says nothing while the result waits for the requester, then releases and attests once COMPLETED', async () => {
    const cid = await sealedJournal();
    const pinRm = vi.fn(async () => undefined);
    const submit = vi.fn(async (_id: string, _body: unknown) => ({}));
    const provider = runtime(pinRm, submit);
    await provider.handleProviderJob(job('OUTPUT_READY'));
    await provider.handleProviderJob(job('OUTPUT_READY'));
    expect(pinRm).not.toHaveBeenCalled();
    expect(submit).not.toHaveBeenCalled();
    expect(store.snapshot().managedPins?.[cid]?.state).toBe('pinned');
    expect(store.snapshot().privateComputeCids?.[cid]?.releasedAt).toBeUndefined();

    await provider.handleProviderJob(job('COMPLETED'));
    expect(pinRm).toHaveBeenCalledWith(cid);
    expect(submit).toHaveBeenCalledTimes(1);
    expect(submit.mock.calls[0]![1]).toMatchObject({ nodeId: providerNodeId, attestation: { payload: { finalState: 'COMPLETED', outputPins: 'released', items: { sealedOutputs: 'deleted' } } } });
  });

  it('a failed unpin on a terminal job is attested as failed and still surfaces as a failure to retry', async () => {
    await sealedJournal();
    const pinRm = vi.fn(async () => { throw Object.assign(new Error('rpc offline'), { kuboResponseComplete: true }); });
    const submit = vi.fn(async (_id: string, _body: unknown) => ({}));
    await expect(runtime(pinRm, submit).handleProviderJob(job('FAILED'))).rejects.toThrow('rpc offline');
    expect(submit.mock.calls[0]![1]).toMatchObject({ attestation: { payload: { finalState: 'FAILED', state: 'failed', outputPins: 'failed' } } });
  });
});
