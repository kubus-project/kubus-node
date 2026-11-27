import crypto from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { KubusApiError } from '../src/backend/kubusApiClient.js';
import type { ManagedReconstruction, RemoteComputeJob } from '../src/backend/models.js';
import { LIGHTWEIGHT_MAX_BYTES, ManagedRequesterBridge, workerPrepare, type PrepareOutcome } from '../src/compute/managedRequesterBridge.js';
import { PRIVATE_OUTPUT_PROTOCOL, SPATIAL_OUTPUT_PROTOCOL } from '../src/compute/privateOutputTransport.js';
import { PROVIDER_CLEANUP_SCHEMA, cleanupAttestationMessage, type ProviderCleanupPayload } from '../src/compute/providerCleanupAttestation.js';

const nodeId = '44444444-4444-4444-8444-444444444444';
const reconstructionId = '9b6f6f0e-2d3c-4b8a-9a52-6c1f3e0d7a11';
const providerA = '66666666-6666-4666-8666-666666666666';
const providerB = '77777777-7777-4777-8777-777777777777';
const photo = Buffer.from('a photo of the artwork, eleven bytes over a chunk');
const clip = Buffer.alloc(40, 9);
const result = Buffer.alloc(50, 3);
const lightResult = Buffer.alloc(33, 5);
const BINDING = 'c'.repeat(64);
const jobId = '88888888-8888-4888-8888-888888888888';
const sha = (bytes: Buffer) => crypto.createHash('sha256').update(bytes).digest('hex');
const logger = { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() } as never;
const providerKeys = crypto.generateKeyPairSync('ed25519');
const providerKey = providerKeys.publicKey.export({ format: 'der', type: 'spki' }).toString('base64');

type Variant = { size: number; received: number; state: 'uploading' | 'ready'; sha256: string };
let dataRoot: string;
let sources: Map<string, Buffer>;
let calls: Array<{ action: string; body: Record<string, unknown> }>;
let appended: Array<{ variant: 'full' | 'lightweight'; offset: number; bytes: Buffer }>;
let jobState: string;
let providers: Array<{ nodeId: string; encryptionPublicKey: string; privateOutputProtocol: string | null; spatialOutputProtocol?: string | null }>;
let prepareOutcome: PrepareOutcome | null;
/** The files the provider's result holds, by role; `null` removes the lightweight. */
let resultFiles: { spatial_mobile: Buffer; spatial_preview: Buffer | null; spatial_archive: Buffer | null };
let blobRoles: string[];
let ackOverride: ((job: RemoteComputeJob) => RemoteComputeJob) | null;
/** The provider whose job the backend answers an acknowledgement with. */
let ackProvider = providerA;
/** A stand-in for the backend's draft store: what it has received of each artifact, and when the attempt is ready. */
let server: { full?: Variant; lightweight?: Variant; created: number; failNextAppend?: boolean; shortfall?: number };
let attestation: { payload: ProviderCleanupPayload; signature: string } | null;

function attempt(overrides: Partial<ManagedReconstruction> = {}): ManagedReconstruction {
  return {
    id: reconstructionId, artworkId: '53b99c8b-8503-545c-8a13-55f60cfb8342', attempt: 1, state: 'preparing', stage: null,
    sourceRevision: 3, sourceDigest: 'd'.repeat(64), chunkSizeBytes: 16, cancelRequested: false, computeJobId: null,
    providerNodeId: null, candidateDraftId: null, leaseExpiresAt: null,
    files: [
      { id: '11111111-1111-4111-8111-111111111111', format: 'jpeg', sizeBytes: photo.length, sha256: sha(photo) },
      { id: '22222222-2222-4222-8222-222222222222', format: 'mp4', sizeBytes: clip.length, sha256: sha(clip) },
    ],
    ...overrides,
  };
}

function job(state = jobState, provider = providerA): RemoteComputeJob {
  const base: RemoteComputeJob = {
    id: jobId, providerNodeId: provider, type: 'spatial.reconstruct', protocolVersion: 'kubus.compute/1',
    jobSpecVersion: 'kubus.spatial-job/1', requirements: {}, inputCid: 'bafyinput', inputBytes: 10, inputHash: 'a'.repeat(64),
    inputKeyEnvelope: {}, canonicalJobSpec: { processing: { outputMode: PRIVATE_OUTPUT_PROTOCOL } }, jobSpecHash: 'b'.repeat(64), state,
    createdAt: '', expiresAt: '', outputManifestCid: 'bafymanifest', outputCids: ['bafymanifest', 'bafyarchive'],
    providerReceipt: { payload: { privateOutput: { blobs: blobRoles.map(role => ({ role })) } } },
    verification: { providerSigningPublicKey: providerKey },
  };
  if (state === 'COMPLETED') base.requesterReceipt = { payload: { jobId, accepted: true, privateOutputBinding: BINDING }, signature: 'sig' };
  if (attestation && ['COMPLETED', 'FAILED', 'DISPUTED', 'CANCELLED'].includes(state)) base.providerCleanup = { state: attestation.payload.state, attestation };
  return ackOverride ? ackOverride(base) : base;
}

function draft(size: number, bytes: Buffer): Variant {
  return { size, received: 0, state: 'uploading', sha256: sha(bytes) };
}

function dto(variant: Variant) {
  return { state: variant.state as string, receivedBytes: variant.received };
}

function view() {
  const ready = server.full?.state === 'ready' && (!server.lightweight || server.lightweight.state === 'ready');
  return attempt({ state: ready ? 'ready' : 'importing' });
}

function makeBridge(prepare?: PrepareOutcome) {
  prepareOutcome = prepare ?? null;
  const api = {
    claimReconstruction: vi.fn(async () => null as ManagedReconstruction | null),
    reconstructionRetention: vi.fn(async () => ({ purge: [] as string[] })),
    readReconstructionChunk: vi.fn(async (_id: string, fileId: string, offset: number) => sources.get(fileId)!.subarray(offset, offset + 16)),
    getReconstructionComputeJob: vi.fn(async () => job()),
    appendReconstructionCandidate: vi.fn(async (_id: string, offset: number, bytes: Buffer, _nodeId: string, variant?: 'lightweight') => {
      const which = variant === 'lightweight' ? 'lightweight' : 'full';
      if (server.failNextAppend) { server.failNextAppend = false; throw new KubusApiError('boom', 500, { success: false }); }
      const target = server[which]!;
      if (offset !== target.received) throw new KubusApiError('offset', 409, { success: false, code: 'SPATIAL_DRAFT_OFFSET_MISMATCH' });
      appended.push({ variant: which, offset, bytes: Buffer.from(bytes) });
      target.received += bytes.length;
      if (target.received === target.size) target.state = 'ready';
      // A shortfall stands for a server that has not finished the second artifact by the time the pass ends.
      if (server.shortfall && which === 'lightweight' && target.state === 'ready') { target.state = 'uploading'; }
      return { reconstruction: view(), candidate: dto(target) };
    }),
    reconstructionCall: vi.fn(async (_id: string, action: string, body: Record<string, unknown>) => {
      calls.push({ action, body });
      if (action === 'progress') return attempt({ state: body.state as ManagedReconstruction['state'] });
      if (action === 'providers') return providers;
      if (action === 'compute-job') return { computeJobId: job().id };
      if (action === 'compute-job/acknowledge') return job(body.accepted ? 'COMPLETED' : 'DISPUTED', ackProvider);
      if (action === 'compute-job/cancel') return job('CANCELLED');
      if (action === 'candidate') {
        server.created += 1;
        const light = body.lightweight as { sizeBytes: number; sha256: string } | undefined;
        const full = server.full;
        if (full && (full.size !== body.sizeBytes || full.sha256 !== body.sha256)) throw new KubusApiError('conflict', 409, { success: false, code: 'SPATIAL_RECONSTRUCTION_CANDIDATE_CONFLICT' });
        server.full ??= { size: body.sizeBytes as number, received: 0, state: 'uploading', sha256: body.sha256 as string };
        if (light) server.lightweight ??= { size: light.sizeBytes, received: 0, state: 'uploading', sha256: light.sha256 };
        return { reconstruction: view(), candidate: { ...dto(server.full), lightweight: server.lightweight ? dto(server.lightweight) : null } };
      }
      return {};
    }),
  };
  const captures = { registerRemote: vi.fn(async (record: unknown) => record), removeRemote: vi.fn(async () => undefined) };
  const transport = { encryptCapture: vi.fn(async () => ({ inputCid: 'bafyinput', inputBytes: 10, inputHash: 'a'.repeat(64), inputKeyEnvelope: {}, jobSpec: { fileCount: 3 } })) };
  const staged = path.join(dataRoot, 'private', 'remote-results', job().id);
  const remote = {
    stagePrivateOutput: vi.fn(async () => {
      await fs.mkdir(staged, { recursive: true });
      await fs.writeFile(path.join(staged, 'spatial_mobile'), resultFiles.spatial_mobile);
      if (resultFiles.spatial_preview) await fs.writeFile(path.join(staged, 'spatial_preview'), resultFiles.spatial_preview);
      if (resultFiles.spatial_archive) await fs.writeFile(path.join(staged, 'spatial_archive'), resultFiles.spatial_archive);
      return { directory: staged, record: { binding: BINDING } };
    }),
    signedAcknowledgement: vi.fn(async (_job: RemoteComputeJob, accepted: boolean, reason?: string) => ({ payload: { accepted, reason }, signature: 'sig' })),
    releaseInput: vi.fn(async () => undefined),
  };
  const prepareFn = vi.fn(async ({ outputDirectory }: { outputDirectory: string }): Promise<PrepareOutcome> => {
    if (prepareOutcome) return prepareOutcome;
    const dataset = path.join(outputDirectory, 'dataset');
    await fs.mkdir(path.join(dataset, 'images'), { recursive: true });
    await fs.writeFile(path.join(dataset, 'images', 'photo_00000.jpg'), 'masked');
    await fs.writeFile(path.join(dataset, 'transforms.json'), '{"frames":[{"file_path":"images/photo_00000.jpg"}]}');
    await fs.writeFile(path.join(dataset, 'prepared.json'), '{"schema":"kubus.prepared-dataset/1"}');
    return { ok: true, datasetDirectory: dataset, inputs: [], sfm: { registeredViews: 30, submittedViews: 34 } };
  });
  const bridge = new ManagedRequesterBridge({ api: api as never, nodeId: () => nodeId, dataRoot, prepare: prepareFn, captures: captures as never, transport: transport as never, remote: remote as never, logger });
  return { bridge, api, captures, transport, remote, prepareFn };
}

function signedAttestation(overrides: Partial<ProviderCleanupPayload> = {}, key = providerKeys.privateKey): { payload: ProviderCleanupPayload; signature: string } {
  const payload: ProviderCleanupPayload = {
    schema: PROVIDER_CLEANUP_SCHEMA, jobId, providerNodeId: providerA, inputHash: 'a'.repeat(64), finalState: 'COMPLETED', receivedAt: '2026-11-27T09:00:00.000Z',
    workerStartedAt: null, workerFinishedAt: null, cancelledAt: null,
    items: { decryptedInput: 'deleted', workDirectory: 'deleted', plaintextOutputs: 'deleted', sealedOutputs: 'deleted' }, outputPins: 'released',
    state: 'complete', reason: null, completedAt: '2026-11-27T10:00:00.000Z', ...overrides,
  };
  return { payload, signature: crypto.sign(null, cleanupAttestationMessage(payload), key).toString('base64') };
}

beforeEach(async () => {
  dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'kubus-managed-requester-'));
  sources = new Map([['11111111-1111-4111-8111-111111111111', photo], ['22222222-2222-4222-8222-222222222222', clip]]);
  calls = [];
  appended = [];
  jobState = 'OUTPUT_READY';
  providers = [{ nodeId: providerA, encryptionPublicKey: 'key', privateOutputProtocol: PRIVATE_OUTPUT_PROTOCOL, spatialOutputProtocol: SPATIAL_OUTPUT_PROTOCOL }];
  resultFiles = { spatial_mobile: result, spatial_preview: null, spatial_archive: null };
  blobRoles = ['manifest', 'spatial_mobile'];
  ackOverride = null;
  ackProvider = providerA;
  server = { created: 0 };
  attestation = null;
});

afterEach(async () => { await fs.rm(dataRoot, { recursive: true, force: true }); });

const root = () => path.join(dataRoot, 'private', 'reconstructions', reconstructionId);
const processing = () => attempt({ state: 'processing', computeJobId: job().id });
const stateFile = async () => JSON.parse(await fs.readFile(path.join(root(), 'state.json'), 'utf8')) as Record<string, any>;
const actions = () => calls.map(call => call.action);

describe('managed requester bridge', () => {
  test('verified sources become a masked dataset that only leaves the Node encrypted to a provider with both output protocols', async () => {
    const { bridge, captures, transport, prepareFn } = makeBridge();
    await bridge.advance(nodeId, attempt());
    // Both files were rebuilt from 16-byte chunks and checked against the snapshot digests.
    expect(await fs.readFile(path.join(root(), 'set', 'photos', '11111111-1111-4111-8111-111111111111.jpg'))).toEqual(photo);
    expect(await fs.readFile(path.join(root(), 'set', 'videos', '22222222-2222-4222-8222-222222222222.mp4'))).toEqual(clip);
    const [{ fileIds }] = prepareFn.mock.calls[0] as unknown as [{ fileIds: Map<string, string> }];
    expect(fileIds.get('videos/22222222-2222-4222-8222-222222222222.mp4')).toBe('22222222-2222-4222-8222-222222222222');
    // The registered capture holds capture.json and the dataset, never the raw set.
    const [record] = captures.registerRemote.mock.calls[0] as unknown as [{ kind: string; directory: string }];
    expect(record.kind).toBe('prepared');
    expect((await fs.readdir(record.directory)).sort()).toEqual(['capture.json', 'dataset']);
    expect(transport.encryptCapture).toHaveBeenCalledWith(`managed-${reconstructionId}`, providerA, 'key');
    const created = calls.find(call => call.action === 'compute-job')!;
    expect(created.body).toMatchObject({ providerNodeId: providerA, jobSpec: { outputMode: PRIVATE_OUTPUT_PROTOCOL, inputMode: 'prepared' } });
  });

  test('a corrupted source chunk stops the attempt before the worker runs', async () => {
    const { bridge, prepareFn } = makeBridge();
    sources.set('11111111-1111-4111-8111-111111111111', Buffer.from('a photo of the artwork, eleven bytes over a chunX'));
    await expect(bridge.advance(nodeId, attempt())).rejects.toMatchObject({ code: 'source_digest_mismatch' });
    expect(prepareFn).not.toHaveBeenCalled();
  });

  test('too few registered views report per-file feedback instead of matching a provider, and the requester cleanup is reported too', async () => {
    const { bridge, transport } = makeBridge({ ok: false, code: 'sfm_failed', details: { submittedViews: 40, registeredViews: 11 },
      inputs: [{ fileId: '22222222-2222-4222-8222-222222222222', usable: false, usableViews: 0, reason: 'frames_too_blurry' }] });
    await bridge.advance(nodeId, attempt());
    const failure = calls.find(call => call.action === 'failure')!;
    expect(failure.body).toMatchObject({ code: 'sfm_failed', feedback: { submittedViews: 40, usableViews: 11,
      inputs: [{ fileId: '22222222-2222-4222-8222-222222222222', usable: false, usableViews: 0, reason: 'frames_too_blurry' }] } });
    expect(transport.encryptCapture).not.toHaveBeenCalled();
    expect(actions().slice(-2)).toEqual(['failure', 'cleanup']);
    expect(calls.at(-1)!.body).toEqual({ nodeId, state: 'complete' });
  });

  test('no eligible provider shows Waiting for a node, and a provider without both output protocols is never used', async () => {
    providers = [
      { nodeId: providerA, encryptionPublicKey: 'key', privateOutputProtocol: null, spatialOutputProtocol: SPATIAL_OUTPUT_PROTOCOL },
      // A legacy provider: private output, but no spatial-output/2 (it would return the raw training file).
      { nodeId: providerB, encryptionPublicKey: 'key-b', privateOutputProtocol: PRIVATE_OUTPUT_PROTOCOL },
      { nodeId: providerB, encryptionPublicKey: 'key-b', privateOutputProtocol: PRIVATE_OUTPUT_PROTOCOL, spatialOutputProtocol: 'kubus.spatial-output/1' },
    ];
    const { bridge, transport, api, prepareFn } = makeBridge();
    await bridge.advance(nodeId, attempt());
    expect(calls.filter(call => call.action === 'progress').at(-1)!.body).toMatchObject({ state: 'waiting_for_node' });
    expect(transport.encryptCapture).not.toHaveBeenCalled();
    // A later pass resumes from the prepared capture without downloading or preparing again.
    providers = [{ nodeId: providerB, encryptionPublicKey: 'key-b', privateOutputProtocol: PRIVATE_OUTPUT_PROTOCOL, spatialOutputProtocol: SPATIAL_OUTPUT_PROTOCOL }];
    const reads = api.readReconstructionChunk.mock.calls.length;
    await bridge.advance(nodeId, attempt({ state: 'waiting_for_node' }));
    expect(transport.encryptCapture).toHaveBeenCalledWith(`managed-${reconstructionId}`, providerB, 'key-b');
    expect(api.readReconstructionChunk.mock.calls.length).toBe(reads);
    expect(prepareFn).toHaveBeenCalledTimes(1);
  });

  test('a verified result is acknowledged and uploaded as the candidate, then work files go but sources stay', async () => {
    const { bridge, remote, captures } = makeBridge();
    await bridge.advance(nodeId, attempt());
    await bridge.advance(nodeId, processing());
    expect(remote.signedAcknowledgement).toHaveBeenCalledWith(expect.objectContaining({ state: 'OUTPUT_READY' }), true, undefined);
    const candidate = calls.find(call => call.action === 'candidate')!;
    expect(candidate.body).toMatchObject({ fileName: 'reconstruction.ply', format: 'ply', sizeBytes: result.length, sha256: sha(result) });
    expect(candidate.body).not.toHaveProperty('lightweight');
    expect(Buffer.concat(appended.map(item => item.bytes))).toEqual(result);
    expect(appended).toHaveLength(4);
    expect(remote.releaseInput).toHaveBeenCalled();
    expect(captures.removeRemote).toHaveBeenCalledWith(`managed-${reconstructionId}`);
    // Work files are gone; the sources and the attempt's own record (without the prepared capture) stay.
    expect((await fs.readdir(root())).sort()).toEqual(['set', 'state.json']);
    expect(await stateFile()).not.toHaveProperty('captureId');
    // The provider's decrypted result staged for verification does not outlive the attempt.
    await expect(fs.stat(path.join(dataRoot, 'private', 'remote-results', jobId))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(calls.at(-1)).toMatchObject({ action: 'cleanup', body: { state: 'complete' } });
  });

  test('a result that fails verification is disputed and the next provider is tried', async () => {
    const { bridge, remote } = makeBridge();
    await bridge.advance(nodeId, attempt());
    remote.stagePrivateOutput.mockRejectedValueOnce(Object.assign(new Error('bad'), { code: 'private_output_signature_invalid' }));
    await bridge.advance(nodeId, processing());
    expect(remote.signedAcknowledgement).toHaveBeenCalledWith(expect.anything(), false, 'output_verification_failed');
    expect(calls.find(call => call.action === 'candidate')).toBeUndefined();
    expect(calls.at(-1)!.body).toMatchObject({ state: 'waiting_for_node', stage: 'provider_lost' });
    providers = [{ nodeId: providerB, encryptionPublicKey: 'key-b', privateOutputProtocol: PRIVATE_OUTPUT_PROTOCOL, spatialOutputProtocol: SPATIAL_OUTPUT_PROTOCOL }];
    await bridge.advance(nodeId, attempt({ state: 'waiting_for_node' }));
    expect(calls.filter(call => call.action === 'providers').at(-1)!.body).toMatchObject({ excludeNodeIds: [providerA] });
  });

  test('a provider lost three times ends the attempt as failed and reports the requester cleanup', async () => {
    const { bridge, api } = makeBridge();
    await bridge.advance(nodeId, attempt());
    for (const provider of [providerA, providerB, '99999999-9999-4999-8999-999999999999']) {
      api.getReconstructionComputeJob.mockResolvedValueOnce(job('FAILED', provider));
      await bridge.advance(nodeId, processing());
    }
    expect(actions().slice(-2)).toEqual(['failure', 'cleanup']);
    expect(calls.at(-2)).toMatchObject({ action: 'failure', body: { code: 'no_provider_completed' } });
    expect(calls.at(-1)!.body).toEqual({ nodeId, state: 'complete' });
  });

  test('a cancel request cancels the provider job, releases the input, confirms, and reports the requester cleanup', async () => {
    const { bridge, remote } = makeBridge();
    await bridge.advance(nodeId, attempt());
    await bridge.advance(nodeId, attempt({ state: 'processing', computeJobId: job().id, cancelRequested: true }));
    expect(actions().slice(-3)).toEqual(['compute-job/cancel', 'cancelled', 'cleanup']);
    expect(calls.at(-1)!.body).toEqual({ nodeId, state: 'complete' });
    expect(remote.releaseInput).toHaveBeenCalledWith(expect.objectContaining({ state: 'CANCELLED' }));
    expect((await fs.readdir(root())).sort()).toEqual(['set', 'state.json']);
  });

  test('a cancel whose input release failed reports the requester cleanup as failed, not complete', async () => {
    const { bridge, remote } = makeBridge();
    await bridge.advance(nodeId, attempt());
    remote.releaseInput.mockRejectedValueOnce(new Error('kubo offline'));
    await bridge.advance(nodeId, attempt({ state: 'processing', computeJobId: job().id, cancelRequested: true }));
    expect(calls.at(-1)).toMatchObject({ action: 'cleanup', body: { state: 'failed' } });
  });

  test('a cancel that lands between two calls ends the pass quietly', async () => {
    const { bridge, api } = makeBridge();
    api.reconstructionCall.mockRejectedValueOnce(new KubusApiError('cancel', 409, { success: false, code: 'SPATIAL_RECONSTRUCTION_CANCEL_REQUESTED' }));
    await expect(bridge.advance(nodeId, attempt())).resolves.toBeUndefined();
  });

  test('retention removes the local copies of attempts the backend lists', async () => {
    const { bridge, api } = makeBridge();
    await fs.mkdir(path.join(root(), 'set'), { recursive: true });
    api.reconstructionRetention.mockResolvedValueOnce({ purge: [reconstructionId, '../escape'] });
    expect(await bridge.purgeExpired(nodeId)).toEqual([reconstructionId, '../escape']);
    await expect(fs.stat(root())).rejects.toMatchObject({ code: 'ENOENT' });
  });
});

describe('full and lightweight delivery', () => {
  const big = () => Buffer.alloc(LIGHTWEIGHT_MAX_BYTES + 1000, 7);
  const bigAttempt = (overrides: Partial<ManagedReconstruction> = {}) => attempt({ chunkSizeBytes: 8 * 1024 * 1024, state: 'processing', computeJobId: jobId, ...overrides });

  async function prepared() {
    const made = makeBridge();
    await made.bridge.advance(nodeId, attempt());
    return made;
  }

  test('both artifacts are declared in one candidate request and uploaded in turn, each to its own variant, cleanup only after ready', async () => {
    blobRoles = ['manifest', 'spatial_mobile', 'spatial_preview'];
    resultFiles = { spatial_mobile: big(), spatial_preview: lightResult, spatial_archive: null };
    const { bridge, remote } = await prepared();
    await bridge.advance(nodeId, bigAttempt());
    const candidate = calls.find(call => call.action === 'candidate')!;
    expect(candidate.body).toMatchObject({
      nodeId, fileName: 'reconstruction.ply', format: 'ply', sizeBytes: LIGHTWEIGHT_MAX_BYTES + 1000, sha256: sha(resultFiles.spatial_mobile),
      lightweight: { fileName: 'reconstruction-light.ply', format: 'ply', sizeBytes: lightResult.length, sha256: sha(lightResult) },
    });
    expect(appended.map(item => item.variant)).toEqual(['full', 'full', 'full', 'lightweight']);
    expect(Buffer.concat(appended.filter(item => item.variant === 'lightweight').map(item => item.bytes))).toEqual(lightResult);
    expect(Buffer.concat(appended.filter(item => item.variant === 'full').map(item => item.bytes)).equals(resultFiles.spatial_mobile)).toBe(true);
    expect(remote.releaseInput).toHaveBeenCalledTimes(1);
    expect(actions().at(-1)).toBe('cleanup');
    expect(calls.at(-1)!.body).toEqual({ nodeId, state: 'complete' });
  });

  test('a full file within the backend limit is its own preview, so a lightweight is not sent', async () => {
    blobRoles = ['manifest', 'spatial_mobile', 'spatial_preview'];
    resultFiles = { spatial_mobile: result, spatial_preview: lightResult, spatial_archive: null };
    const { bridge } = await prepared();
    await bridge.advance(nodeId, processing());
    expect(calls.find(call => call.action === 'candidate')!.body).not.toHaveProperty('lightweight');
    expect(appended.every(item => item.variant === 'full')).toBe(true);
    expect(calls.at(-1)).toMatchObject({ action: 'cleanup', body: { state: 'complete' } });
  });

  test('partial delivery is not ready: nothing is released, no cleanup is reported, and the next pass resumes from the server\'s counts', async () => {
    blobRoles = ['manifest', 'spatial_mobile', 'spatial_preview'];
    resultFiles = { spatial_mobile: big(), spatial_preview: lightResult, spatial_archive: null };
    const { bridge, remote, api } = await prepared();
    server.shortfall = 1;
    await expect(bridge.advance(nodeId, bigAttempt())).rejects.toMatchObject({ code: 'candidate_not_ready' });
    expect(remote.releaseInput).not.toHaveBeenCalled();
    expect(actions()).not.toContain('cleanup');
    expect(server.full!.state).toBe('ready');
    expect(server.lightweight!.state).toBe('uploading');
    // The server finished its side meanwhile; the next pass re-posts the same pair (idempotent) and sends only what is missing.
    server.shortfall = 0;
    server.lightweight!.received = 0;
    jobState = 'COMPLETED';
    const before = appended.length;
    await bridge.advance(nodeId, bigAttempt({ state: 'importing' }));
    expect(appended.slice(before).every(item => item.variant === 'lightweight')).toBe(true);
    expect(server.created).toBe(2);
    expect(api.appendReconstructionCandidate).toHaveBeenCalled();
    expect(calls.at(-1)).toMatchObject({ action: 'cleanup', body: { state: 'complete' } });
  });

  test('each file resumes at the server\'s receivedBytes, not at a local counter', async () => {
    const { bridge } = await prepared();
    server.full = { size: result.length, received: 32, state: 'uploading', sha256: sha(result) };
    await bridge.advance(nodeId, processing());
    expect(appended.map(item => item.offset)).toEqual([32, 48]);
    expect(Buffer.concat(appended.map(item => item.bytes))).toEqual(result.subarray(32));
    expect(calls.at(-1)).toMatchObject({ action: 'cleanup' });
  });

  test('the next offset is the one the server reports after each chunk', async () => {
    const { bridge, api } = await prepared();
    // The server already holds more than the 16 bytes just sent (a chunk another attempt of this pass delivered).
    api.appendReconstructionCandidate.mockImplementationOnce(async (_id, offset, bytes) => {
      appended.push({ variant: 'full', offset, bytes: Buffer.from(bytes) });
      server.full!.received = 40;
      return { reconstruction: view(), candidate: { state: 'uploading', receivedBytes: 40 } };
    });
    await bridge.advance(nodeId, processing());
    expect(appended.map(item => item.offset)).toEqual([0, 40]);
  });

  test('a server count that does not advance stops the upload instead of looping', async () => {
    const { bridge, api } = await prepared();
    api.appendReconstructionCandidate.mockResolvedValue({ reconstruction: view(), candidate: { state: 'uploading', receivedBytes: 0 } });
    await expect(bridge.advance(nodeId, processing())).rejects.toMatchObject({ code: 'candidate_progress_unreadable' });
    expect(api.appendReconstructionCandidate).toHaveBeenCalledTimes(1);
    expect(actions()).not.toContain('cleanup');
  });

  test('a duplicate delivery is idempotent, and a different file for the same attempt is a conflict that is never swallowed', async () => {
    const { bridge, remote } = await prepared();
    await bridge.advance(nodeId, processing());
    const sent = appended.length;
    jobState = 'COMPLETED';
    await bridge.advance(nodeId, attempt({ state: 'importing', computeJobId: jobId }));
    // Everything was already at the server: nothing is sent twice.
    expect(appended).toHaveLength(sent);
    expect(server.created).toBe(2);
    resultFiles = { ...resultFiles, spatial_mobile: Buffer.alloc(50, 9) };
    const releases = remote.releaseInput.mock.calls.length;
    await expect(bridge.advance(nodeId, attempt({ state: 'importing', computeJobId: jobId }))).rejects.toMatchObject({ details: { code: 'SPATIAL_RECONSTRUCTION_CANDIDATE_CONFLICT' } });
    expect(remote.releaseInput.mock.calls.length).toBe(releases);
  });

  test('a failure mid-upload leaves the attempt unreleased so the next pass resumes', async () => {
    const { bridge, remote } = await prepared();
    server.failNextAppend = true;
    await expect(bridge.advance(nodeId, processing())).rejects.toBeInstanceOf(KubusApiError);
    expect(remote.releaseInput).not.toHaveBeenCalled();
    expect(actions()).not.toContain('cleanup');
    jobState = 'COMPLETED';
    await bridge.advance(nodeId, attempt({ state: 'importing', computeJobId: jobId }));
    expect(appended.length).toBeGreaterThan(0);
    expect(Buffer.concat(appended.map(item => item.bytes))).toEqual(result);
    expect(calls.at(-1)).toMatchObject({ action: 'cleanup', body: { state: 'complete' } });
  });

  test('an oversize lightweight is a provider failure, never uploaded', async () => {
    blobRoles = ['manifest', 'spatial_mobile', 'spatial_preview'];
    resultFiles = { spatial_mobile: big(), spatial_preview: big(), spatial_archive: null };
    const { bridge } = await prepared();
    await bridge.advance(nodeId, bigAttempt());
    expect(calls.find(call => call.action === 'candidate')).toBeUndefined();
    expect(calls.find(call => call.action === 'failure')!.body).toMatchObject({ code: 'provider_output_invalid' });
    expect(actions().at(-1)).toBe('cleanup');
  });
});

describe('legacy provider output', () => {
  const legacy = () => { blobRoles = ['manifest', 'spatial_archive']; resultFiles = { spatial_mobile: result, spatial_preview: null, spatial_archive: result }; };
  const eligible = (id: string) => ({ nodeId: id, encryptionPublicKey: 'k', privateOutputProtocol: PRIVATE_OUTPUT_PROTOCOL, spatialOutputProtocol: SPATIAL_OUTPUT_PROTOCOL });

  test('a result with spatial_archive and no spatial_mobile is rejected as provider_output_outdated and never imported', async () => {
    legacy();
    const { bridge, remote } = makeBridge();
    await bridge.advance(nodeId, attempt());
    await bridge.advance(nodeId, processing());
    expect(remote.signedAcknowledgement).toHaveBeenCalledWith(expect.anything(), false, 'provider_output_outdated');
    expect(calls.find(call => call.action === 'compute-job/acknowledge')!.body).toMatchObject({ accepted: false });
    expect(calls.find(call => call.action === 'candidate')).toBeUndefined();
    expect(appended).toHaveLength(0);
    expect(calls.at(-1)!.body).toMatchObject({ state: 'waiting_for_node', stage: 'provider_lost' });
    // The provider is excluded for the rest of the attempt.
    providers = [eligible(providerB)];
    await bridge.advance(nodeId, attempt({ state: 'waiting_for_node' }));
    expect(calls.filter(call => call.action === 'providers').at(-1)!.body).toMatchObject({ excludeNodeIds: [providerA] });
  });

  test('when every provider tried returned the legacy output the attempt fails with provider_output_outdated', async () => {
    legacy();
    const { bridge, api } = makeBridge();
    await bridge.advance(nodeId, attempt());
    for (const provider of [providerA, providerB, '99999999-9999-4999-8999-999999999999']) {
      ackProvider = provider;
      api.getReconstructionComputeJob.mockResolvedValueOnce(job('OUTPUT_READY', provider));
      await bridge.advance(nodeId, processing());
    }
    expect(calls.find(call => call.action === 'candidate')).toBeUndefined();
    expect(actions().slice(-2)).toEqual(['failure', 'cleanup']);
    expect(calls.at(-2)).toMatchObject({ action: 'failure', body: { code: 'provider_output_outdated' } });
  });

  test('a mix of legacy and other losses is the generic no_provider_completed', async () => {
    const { bridge, api, remote } = makeBridge();
    await bridge.advance(nodeId, attempt());
    api.getReconstructionComputeJob.mockResolvedValueOnce(job('FAILED', providerA));
    await bridge.advance(nodeId, processing());
    legacy();
    ackProvider = providerB;
    api.getReconstructionComputeJob.mockResolvedValueOnce(job('OUTPUT_READY', providerB));
    await bridge.advance(nodeId, processing());
    api.getReconstructionComputeJob.mockResolvedValueOnce(job('FAILED', '99999999-9999-4999-8999-999999999999'));
    await bridge.advance(nodeId, processing());
    expect(remote.signedAcknowledgement).toHaveBeenCalledWith(expect.anything(), false, 'provider_output_outdated');
    expect(calls.at(-2)).toMatchObject({ action: 'failure', body: { code: 'no_provider_completed' } });
  });

  test('a COMPLETED job that holds the legacy shape is never imported (defence beyond the acknowledgement)', async () => {
    legacy();
    jobState = 'COMPLETED';
    const { bridge } = makeBridge();
    await bridge.advance(nodeId, attempt());
    await bridge.advance(nodeId, attempt({ state: 'importing', computeJobId: jobId }));
    expect(calls.find(call => call.action === 'candidate')).toBeUndefined();
    expect(calls.find(call => call.action === 'failure')!.body).toMatchObject({ code: 'provider_output_outdated' });
    expect(actions().at(-1)).toBe('cleanup');
  });
});

describe('acknowledgement consistency of a completed job', () => {
  test('a COMPLETED job whose requester receipt is missing, rejected or bound to another output is not imported', async () => {
    jobState = 'COMPLETED';
    const variants: Array<[string, (value: RemoteComputeJob) => RemoteComputeJob]> = [
      ['no receipt', value => ({ ...value, requesterReceipt: undefined })],
      ['rejection', value => ({ ...value, requesterReceipt: { payload: { jobId, accepted: false, privateOutputBinding: BINDING }, signature: 's' } })],
      ['other output', value => ({ ...value, requesterReceipt: { payload: { jobId, accepted: true, privateOutputBinding: 'd'.repeat(64) }, signature: 's' } })],
      ['other job', value => ({ ...value, requesterReceipt: { payload: { jobId: providerA, accepted: true, privateOutputBinding: BINDING }, signature: 's' } })],
    ];
    for (const [label, mutate] of variants) {
      calls = []; appended = []; server = { created: 0 };
      ackOverride = mutate;
      const { bridge } = makeBridge();
      await bridge.advance(nodeId, attempt());
      await bridge.advance(nodeId, attempt({ state: 'importing', computeJobId: jobId }));
      expect(calls.find(call => call.action === 'candidate'), label).toBeUndefined();
      expect(calls.find(call => call.action === 'failure')!.body, label).toMatchObject({ code: 'provider_output_unverified' });
      expect(appended, label).toHaveLength(0);
      await fs.rm(root(), { recursive: true, force: true });
    }
  });

  test('a COMPLETED job found while following is checked the same way', async () => {
    jobState = 'COMPLETED';
    ackOverride = value => ({ ...value, requesterReceipt: undefined });
    const { bridge } = makeBridge();
    await bridge.advance(nodeId, attempt());
    await bridge.advance(nodeId, processing());
    expect(calls.find(call => call.action === 'candidate')).toBeUndefined();
    expect(calls.find(call => call.action === 'failure')!.body).toMatchObject({ code: 'provider_output_unverified' });
  });
});

describe('provider cleanup attestation on the requester', () => {
  test('a verified statement on the finished job is recorded in the attempt state', async () => {
    attestation = signedAttestation();
    const { bridge } = makeBridge();
    await bridge.advance(nodeId, attempt());
    await bridge.advance(nodeId, processing());
    const record = (await stateFile()).providerCleanups[jobId];
    expect(record).toMatchObject({ status: 'verified', providerNodeId: providerA, finalState: 'COMPLETED',
      attestation: { state: 'complete', outputPins: 'released', finalState: 'COMPLETED', completedAt: '2026-11-27T10:00:00.000Z' } });
  });

  test('a statement that does not verify (foreign key, wrong job, wrong state) is recorded as invalid and never as a result', async () => {
    for (const bad of [signedAttestation({}, crypto.generateKeyPairSync('ed25519').privateKey), signedAttestation({ jobId: providerA }), signedAttestation({ finalState: 'FAILED' })]) {
      attestation = bad;
      calls = []; appended = []; server = { created: 0 };
      const { bridge } = makeBridge();
      await bridge.advance(nodeId, attempt());
      await bridge.advance(nodeId, processing());
      const record = (await stateFile()).providerCleanups[jobId];
      expect(record.status).toBe('invalid');
      expect(record).not.toHaveProperty('attestation');
      await fs.rm(root(), { recursive: true, force: true });
    }
  });

  test('a statement that is not there yet is awaited, and picked up by a later scan once the provider has sent it', async () => {
    const { bridge, api } = makeBridge();
    await bridge.advance(nodeId, attempt());
    await bridge.advance(nodeId, processing());
    const waiting = (await stateFile()).providerCleanups[jobId];
    expect(waiting).toMatchObject({ status: 'awaiting', attempts: 1 });
    // Not due yet: the backend is not asked again.
    const asked = api.getReconstructionComputeJob.mock.calls.length;
    await bridge.collectAttestations(nodeId);
    expect(api.getReconstructionComputeJob.mock.calls.length).toBe(asked);
    // Due, and the provider has attested.
    const state = await stateFile();
    state.providerCleanups[jobId].nextCheckAt = new Date(Date.now() - 1000).toISOString();
    await fs.writeFile(path.join(root(), 'state.json'), JSON.stringify(state));
    attestation = signedAttestation();
    jobState = 'COMPLETED';
    await bridge.collectAttestations(nodeId);
    expect((await stateFile()).providerCleanups[jobId]).toMatchObject({ status: 'verified', attestation: { state: 'complete' } });
  });

  test('a failed statement from the provider is recorded as failed, so the requester can see it', async () => {
    attestation = signedAttestation({ state: 'failed', items: { decryptedInput: 'deleted', workDirectory: 'failed', plaintextOutputs: 'failed', sealedOutputs: 'deleted' }, reason: 'work_directory_not_cleaned' });
    const { bridge } = makeBridge();
    await bridge.advance(nodeId, attempt());
    await bridge.advance(nodeId, processing());
    expect((await stateFile()).providerCleanups[jobId]).toMatchObject({ status: 'verified', attestation: { state: 'failed', reason: 'work_directory_not_cleaned' } });
  });
});

describe('provider cleanup attestation replacement and earlier jobs', () => {
  const failedStatement = { state: 'failed' as const, items: { decryptedInput: 'deleted' as const, workDirectory: 'deleted' as const, plaintextOutputs: 'deleted' as const, sealedOutputs: 'failed' as const }, outputPins: 'failed' as const, reason: 'sealed_outputs_not_cleaned' };

  async function makeDue(id = jobId) {
    const state = await stateFile();
    state.providerCleanups[id].nextCheckAt = new Date(Date.now() - 1000).toISOString();
    await fs.writeFile(path.join(root(), 'state.json'), JSON.stringify(state));
  }

  test('a failed statement later replaced by a complete one is recorded as complete', async () => {
    attestation = signedAttestation(failedStatement);
    const { bridge } = makeBridge();
    await bridge.advance(nodeId, attempt());
    await bridge.advance(nodeId, processing());
    expect((await stateFile()).providerCleanups[jobId]).toMatchObject({ status: 'verified', attestation: { state: 'failed' } });
    await makeDue();
    attestation = signedAttestation({ completedAt: '2026-11-27T11:00:00.000Z' });
    jobState = 'COMPLETED';
    await bridge.collectAttestations(nodeId);
    expect((await stateFile()).providerCleanups[jobId]).toMatchObject({ status: 'verified', attestation: { state: 'complete', completedAt: '2026-11-27T11:00:00.000Z' } });
    // A complete statement is final: a later scan neither asks again nor lets a failed one displace it.
    const record = (await stateFile()).providerCleanups[jobId];
    expect(record.nextCheckAt).toBeUndefined();
  });

  test('a replacement that does not verify, or is older, leaves the verified failed statement in place', async () => {
    attestation = signedAttestation({ ...failedStatement, completedAt: '2026-11-27T10:00:00.000Z' });
    const { bridge } = makeBridge();
    await bridge.advance(nodeId, attempt());
    await bridge.advance(nodeId, processing());
    jobState = 'COMPLETED';
    for (const bad of [signedAttestation({ completedAt: '2026-11-27T11:00:00.000Z' }, crypto.generateKeyPairSync('ed25519').privateKey), signedAttestation({ completedAt: '2026-11-27T08:00:00.000Z' })]) {
      await makeDue();
      attestation = bad;
      await bridge.collectAttestations(nodeId);
      expect((await stateFile()).providerCleanups[jobId]).toMatchObject({ status: 'verified', attestation: { state: 'failed', completedAt: '2026-11-27T10:00:00.000Z' } });
    }
  });

  test('the statement of an earlier, excluded provider job is asked for by its job id and verified against the key pinned for it', async () => {
    const earlier = '5b1f4f0e-6a43-4c64-9c7e-2d8f3f6a9a10';
    const { bridge, api } = makeBridge();
    await bridge.advance(nodeId, attempt());
    await bridge.advance(nodeId, processing());
    const state = await stateFile();
    state.providerCleanups[earlier] = { jobId: earlier, providerNodeId: providerA, finalState: 'FAILED', status: 'awaiting', attempts: 1, since: new Date().toISOString(), inputHash: 'a'.repeat(64), providerSigningPublicKey: providerKey };
    await fs.writeFile(path.join(root(), 'state.json'), JSON.stringify(state));
    // A backend that ignores the job id answers with the current job: nothing is verified from it.
    await bridge.collectAttestations(nodeId);
    expect(api.getReconstructionComputeJob).toHaveBeenLastCalledWith(reconstructionId, nodeId, earlier);
    expect((await stateFile()).providerCleanups[earlier]).toMatchObject({ status: 'awaiting', attempts: 2 });
    await makeDue(earlier);
    const statement = signedAttestation({ jobId: earlier, finalState: 'FAILED' });
    api.getReconstructionComputeJob.mockImplementation((async (_id: string, _node: string, requested?: string) => requested === earlier
      ? { ...job('FAILED'), id: earlier, verification: undefined, providerCleanup: { state: 'complete', attestation: statement } }
      : job()) as never);
    await bridge.collectAttestations(nodeId);
    expect((await stateFile()).providerCleanups[earlier]).toMatchObject({ status: 'verified', attestation: { state: 'complete', finalState: 'FAILED' } });
  });
});

describe('worker prepare stage', () => {
  test('maps typed feedback back to backend file ids and always asks for masking', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
      if (String(url).endsWith('/health')) return new Response(JSON.stringify({ status: 'ready', inputModes: ['source_set'], faceMasking: true, workerInstanceId: 'w1' }));
      const body = JSON.parse(String((init as RequestInit).body));
      expect(body.input).toEqual({ mode: 'source_set', maskFaces: { photos: true, video: true } });
      return new Response(JSON.stringify({ detail: { code: 'sfm_failed', message: 'no', details: { submittedViews: 9,
        inputs: [{ input: 'videos/b.mp4', usable: false, usableViews: 0, reason: 'frames_too_blurry' }, { input: 'photos/unknown.jpg', usable: true }] } } }), { status: 422 });
    });
    try {
      const prepare = workerPrepare({ workerUrl: 'http://worker', workerAuth: { issue: async () => 'token' } as never });
      const outcome = await prepare({ jobId: reconstructionId, captureDirectory: '/data/set', outputDirectory: '/data/out', fileIds: new Map([['videos/b.mp4', 'file-b']]) });
      expect(outcome).toEqual({ ok: false, code: 'sfm_failed', details: expect.objectContaining({ submittedViews: 9 }),
        inputs: [{ fileId: 'file-b', usable: false, usableViews: 0, reason: 'frames_too_blurry' }] });
    } finally { fetchMock.mockRestore(); }
  });

  test('refuses a worker that cannot prepare source sets', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ status: 'ready', inputModes: ['photos'], faceMasking: true, workerInstanceId: 'w1' })));
    try {
      const prepare = workerPrepare({ workerUrl: 'http://worker', workerAuth: { issue: async () => 'token' } as never });
      await expect(prepare({ jobId: reconstructionId, captureDirectory: '/a', outputDirectory: '/b', fileIds: new Map() }))
        .rejects.toMatchObject({ code: 'worker_source_set_unsupported' });
    } finally { fetchMock.mockRestore(); }
  });
});
