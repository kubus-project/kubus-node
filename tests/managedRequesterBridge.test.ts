import crypto from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { KubusApiError } from '../src/backend/kubusApiClient.js';
import type { ManagedReconstruction, RemoteComputeJob } from '../src/backend/models.js';
import { DEFAULT_LEASE_RENEW_MS, LIGHTWEIGHT_MAX_BYTES, ManagedRequesterBridge, workerCancelPrepare, workerPrepare, type ManagedRequesterDeps, type PrepareOutcome } from '../src/compute/managedRequesterBridge.js';
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
/** What the worker wrote into dataset/prepared.json; `null` writes no file. Clean by default: masking ran and nothing is flagged. */
let preparedRecord: Record<string, unknown> | null;
const cleanLook = { images: 0, weakExcluded: 0, largeBelowCertain: 0, items: [] as unknown[] };
const cleanRecord = () => ({ schema: 'kubus.prepared-dataset/1', faceMasking: { photos: { ran: true, needsLook: { ...cleanLook } }, video: { ran: true, needsLook: { ...cleanLook } } } });
const flaggedRecord = () => ({ schema: 'kubus.prepared-dataset/1', faceMasking: { photos: { ran: true, needsLook: { images: 1, weakExcluded: 0, largeBelowCertain: 1, items: [{ image: 7, largeBelowCertain: 1, file: 'dataset/images/photo_00006.jpg' }] } }, video: { ran: true, needsLook: { ...cleanLook } } } });

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

function makeBridge(prepare?: PrepareOutcome, extra: Partial<ManagedRequesterDeps> = {}) {
  prepareOutcome = prepare ?? null;
  const api = {
    claimReconstruction: vi.fn(async () => null as ManagedReconstruction | null),
    reconstructionRetention: vi.fn(async () => ({ purge: [] as string[] })),
    ackReconstructionRetention: vi.fn(async (_nodeId: string, _ids: string[]) => ({ acknowledged: _ids.length })),
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
      // Same shape as the backend bridge (spatialReconstructionService.appendCandidate): the full draft at the top
      // level and the companion under `lightweight`, whichever variant the chunk was for.
      return { reconstruction: view(), candidate: { ...dto(server.full!), lightweight: server.lightweight ? dto(server.lightweight) : null } };
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
  let encryptions = 0;
  const transport = { encryptCapture: vi.fn(async (_captureId: string, _provider: string, _key: string) => {
    encryptions += 1;
    return { inputCid: `bafyinput${encryptions}`, inputBytes: 10 + encryptions, inputHash: encryptions.toString(16).padStart(64, 'e'), inputKeyEnvelope: { context: `envelope-${encryptions}` }, jobSpec: { fileCount: 3 } };
  }) };
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
    releaseInput: vi.fn(async (_job?: RemoteComputeJob): Promise<{ released: boolean; reason?: string } | undefined> => undefined),
    releaseUnusedInput: vi.fn(async (_cid: string): Promise<{ released: boolean; reason?: string } | undefined> => undefined),
    releaseInputsOwnedBy: vi.fn(async (_owner: string): Promise<{ released: boolean; reason?: string } | undefined> => undefined),
  };
  const prepareFn = vi.fn(async ({ outputDirectory }: { outputDirectory: string }): Promise<PrepareOutcome> => {
    if (prepareOutcome) return prepareOutcome;
    const dataset = path.join(outputDirectory, 'dataset');
    await fs.mkdir(path.join(dataset, 'images'), { recursive: true });
    await fs.writeFile(path.join(dataset, 'images', 'photo_00000.jpg'), 'masked');
    await fs.writeFile(path.join(dataset, 'transforms.json'), '{"frames":[{"file_path":"images/photo_00000.jpg"}]}');
    if (preparedRecord) await fs.writeFile(path.join(dataset, 'prepared.json'), JSON.stringify(preparedRecord));
    return { ok: true, datasetDirectory: dataset, inputs: [], sfm: { registeredViews: 30, submittedViews: 34 } };
  });
  const cancelPrepare = vi.fn(async (_jobId: string) => undefined);
  const bridge = new ManagedRequesterBridge({ api: api as never, nodeId: () => nodeId, dataRoot, prepare: prepareFn, cancelPrepare, captures: captures as never, transport: transport as never, remote: remote as never, logger, ...extra });
  return { bridge, api, captures, transport, remote, prepareFn, cancelPrepare };
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
  preparedRecord = cleanRecord();
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
    expect(transport.encryptCapture).toHaveBeenCalledWith(`managed-${reconstructionId}`, providerA, 'key', expect.objectContaining({ pinOwner: expect.stringMatching(/^requester-input:/) }));
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
    expect(transport.encryptCapture).toHaveBeenCalledWith(`managed-${reconstructionId}`, providerB, 'key-b', expect.anything());
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
    // Only a real attempt id is purged (and acknowledged); anything else the backend lists is ignored.
    expect(await bridge.purgeExpired(nodeId)).toEqual([reconstructionId]);
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
      return { reconstruction: view(), candidate: { state: 'uploading', receivedBytes: 40, lightweight: null } };
    });
    await bridge.advance(nodeId, processing());
    expect(appended.map(item => item.offset)).toEqual([0, 40]);
  });

  test('a server count that does not advance stops the upload instead of looping', async () => {
    const { bridge, api } = await prepared();
    api.appendReconstructionCandidate.mockResolvedValue({ reconstruction: view(), candidate: { state: 'uploading', receivedBytes: 0, lightweight: null } });
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
    expect((await stateFile()).providerCleanups[earlier]).toMatchObject({ status: 'awaiting', attempts: 2, code: 'provider_job_view_unavailable' });
    await makeDue(earlier);
    const statement = signedAttestation({ jobId: earlier, finalState: 'FAILED' });
    api.getReconstructionComputeJob.mockImplementation((async (_id: string, _node: string, requested?: string) => requested === earlier
      ? { ...job('FAILED'), id: earlier, verification: undefined, providerCleanup: { state: 'complete', attestation: statement } }
      : job()) as never);
    await bridge.collectAttestations(nodeId);
    expect((await stateFile()).providerCleanups[earlier]).toMatchObject({ status: 'verified', attestation: { state: 'complete', finalState: 'FAILED' } });
    expect((await stateFile()).providerCleanups[earlier].code).toBeUndefined();
  });
});

describe('encrypted input reuse', () => {
  const providerOf = (id: string, key = 'key') => ({ nodeId: id, encryptionPublicKey: key, privateOutputProtocol: PRIVATE_OUTPUT_PROTOCOL, spatialOutputProtocol: SPATIAL_OUTPUT_PROTOCOL });
  const jobCalls = () => calls.filter(call => call.action === 'compute-job');
  /** Makes the next `count` compute-job calls fail the way a lost or refused request does. */
  function failJobCalls(api: ReturnType<typeof makeBridge>['api'], count: number) {
    const original = api.reconstructionCall.getMockImplementation()!;
    let left = count;
    api.reconstructionCall.mockImplementation(async (id: string, action: string, body: Record<string, unknown>) => {
      if (action === 'compute-job' && left > 0) { left -= 1; calls.push({ action, body }); throw new KubusApiError('unavailable', 503, { success: false }); }
      return original(id, action, body);
    });
  }
  const pending = async () => (await stateFile()).pendingInput as Record<string, any> | undefined;

  test('a compute-job that keeps failing for the same provider encrypts once and re-sends the identical input', async () => {
    const { bridge, api, transport, remote } = makeBridge();
    failJobCalls(api, 2);
    await expect(bridge.advance(nodeId, attempt())).rejects.toThrow('unavailable');
    await expect(bridge.advance(nodeId, attempt({ state: 'waiting_for_node' }))).rejects.toThrow('unavailable');
    await bridge.advance(nodeId, attempt({ state: 'waiting_for_node' }));
    expect(transport.encryptCapture).toHaveBeenCalledTimes(1);
    const sent = jobCalls().map(call => call.body);
    expect(sent).toHaveLength(3);
    expect(sent[1]).toEqual(sent[0]);
    expect(sent[2]).toEqual(sent[0]);
    expect(sent[0]).toMatchObject({ providerNodeId: providerA, inputCid: 'bafyinput1', inputKeyEnvelope: { context: 'envelope-1' } });
    // The job exists now: its input belongs to the job and is released with it, not as an unused one.
    expect(await pending()).toBeUndefined();
    expect(remote.releaseUnusedInput).not.toHaveBeenCalled();
  });

  test('the descriptor is stored in the attempt state with the capture, provider and provider key it was made for', async () => {
    const { bridge, api } = makeBridge();
    failJobCalls(api, 1);
    await expect(bridge.advance(nodeId, attempt())).rejects.toThrow('unavailable');
    expect(await pending()).toMatchObject({
      captureId: `managed-${reconstructionId}`, providerNodeId: providerA, providerEncryptionPublicKey: 'key', inputCid: 'bafyinput1', inputBytes: 11,
      inputKeyEnvelope: { context: 'envelope-1' }, jobSpec: { fileCount: 3 },
    });
  });

  test('a different provider releases the unused input pin and encrypts for the new one', async () => {
    const { bridge, api, transport, remote } = makeBridge();
    failJobCalls(api, 1);
    await expect(bridge.advance(nodeId, attempt())).rejects.toThrow('unavailable');
    providers = [providerOf(providerB, 'key-b')];
    await bridge.advance(nodeId, attempt({ state: 'waiting_for_node' }));
    expect(remote.releaseUnusedInput).toHaveBeenCalledTimes(1);
    expect(remote.releaseUnusedInput).toHaveBeenCalledWith('bafyinput1');
    expect(transport.encryptCapture).toHaveBeenLastCalledWith(`managed-${reconstructionId}`, providerB, 'key-b', expect.anything());
    expect(jobCalls().at(-1)!.body).toMatchObject({ providerNodeId: providerB, inputCid: 'bafyinput2' });
    expect(await pending()).toBeUndefined();
  });

  test('a changed provider key re-encrypts and releases the old input', async () => {
    const { bridge, api, transport, remote } = makeBridge();
    failJobCalls(api, 1);
    await expect(bridge.advance(nodeId, attempt())).rejects.toThrow('unavailable');
    providers = [providerOf(providerA, 'rotated-key')];
    await bridge.advance(nodeId, attempt({ state: 'waiting_for_node' }));
    expect(transport.encryptCapture).toHaveBeenCalledTimes(2);
    expect(transport.encryptCapture).toHaveBeenLastCalledWith(`managed-${reconstructionId}`, providerA, 'rotated-key', expect.anything());
    expect(remote.releaseUnusedInput).toHaveBeenCalledWith('bafyinput1');
    expect(jobCalls().at(-1)!.body).toMatchObject({ providerNodeId: providerA, inputCid: 'bafyinput2' });
  });

  test('a restart reuses the stored descriptor instead of encrypting again', async () => {
    const first = makeBridge();
    failJobCalls(first.api, 1);
    await expect(first.bridge.advance(nodeId, attempt())).rejects.toThrow('unavailable');
    const second = makeBridge();
    await second.bridge.advance(nodeId, attempt({ state: 'waiting_for_node' }));
    expect(second.transport.encryptCapture).not.toHaveBeenCalled();
    expect(second.remote.releaseUnusedInput).not.toHaveBeenCalled();
    const sent = jobCalls().map(call => call.body);
    expect(sent[1]).toEqual(sent[0]);
  });

  test('a provider that disappears keeps the descriptor for its return, and the pin is released when the attempt ends', async () => {
    const { bridge, api, remote } = makeBridge();
    failJobCalls(api, 1);
    await expect(bridge.advance(nodeId, attempt())).rejects.toThrow('unavailable');
    providers = [];
    await bridge.advance(nodeId, attempt({ state: 'waiting_for_node' }));
    expect(await pending()).toMatchObject({ inputCid: 'bafyinput1' });
    await bridge.advance(nodeId, attempt({ state: 'waiting_for_node', cancelRequested: true }));
    expect(remote.releaseUnusedInput).toHaveBeenCalledWith('bafyinput1');
    expect(await pending()).toBeUndefined();
  });

  describe('a request whose answer was lost may still have created the job', () => {
    /** The backend commits the job and then the answer is lost: the call runs, and the caller sees a failure. */
    function loseResponses(api: ReturnType<typeof makeBridge>['api'], count: number) {
      const original = api.reconstructionCall.getMockImplementation()!;
      let left = count;
      api.reconstructionCall.mockImplementation(async (id: string, action: string, body: Record<string, unknown>) => {
        const out = await original(id, action, body);
        if (action === 'compute-job' && left > 0) { left -= 1; throw new KubusApiError('response lost', 503, { success: false }); }
        return out;
      });
    }
    /** The job the backend created from the first input, as the Node sees it when it asks. */
    const bound = (cid = 'bafyinput1') => ({ ...job('MATCHED' as never, providerA), inputCid: cid }) as RemoteComputeJob;
    const notFound = () => new KubusApiError('no job', 404, { success: false });

    test('a provider change does not unpin the input of a job the backend already created, and the same job is bound', async () => {
      const { bridge, api, transport, remote } = makeBridge();
      loseResponses(api, 1);
      await expect(bridge.advance(nodeId, attempt())).rejects.toThrow('response lost');
      api.getReconstructionComputeJob.mockResolvedValue(bound());
      providers = [providerOf(providerB, 'key-b'), providerOf(providerA)];
      await bridge.advance(nodeId, attempt({ state: 'waiting_for_node' }));
      expect(remote.releaseUnusedInput).not.toHaveBeenCalled();
      expect(transport.encryptCapture).toHaveBeenCalledTimes(1);
      expect(jobCalls()).toHaveLength(2);
      expect(jobCalls().at(-1)!.body).toMatchObject({ providerNodeId: providerA, inputCid: 'bafyinput1' });
      expect(await pending()).toBeUndefined();
    });

    test('an input no job holds (the backend has no job for the attempt) is still released on a provider change', async () => {
      const { bridge, api, remote } = makeBridge();
      failJobCalls(api, 1);
      await expect(bridge.advance(nodeId, attempt())).rejects.toThrow('unavailable');
      api.getReconstructionComputeJob.mockRejectedValue(notFound());
      providers = [providerOf(providerB, 'key-b')];
      await bridge.advance(nodeId, attempt({ state: 'waiting_for_node' }));
      expect(remote.releaseUnusedInput).toHaveBeenCalledWith('bafyinput1');
      expect(jobCalls().at(-1)!.body).toMatchObject({ providerNodeId: providerB, inputCid: 'bafyinput2' });
    });

    test('when the backend cannot say whether a job holds the input, nothing is released and nothing new is encrypted', async () => {
      const { bridge, api, transport, remote } = makeBridge();
      failJobCalls(api, 1);
      await expect(bridge.advance(nodeId, attempt())).rejects.toThrow('unavailable');
      api.getReconstructionComputeJob.mockRejectedValue(new KubusApiError('down', 503, { success: false }));
      providers = [providerOf(providerB, 'key-b')];
      await expect(bridge.advance(nodeId, attempt({ state: 'waiting_for_node' }))).rejects.toThrow('down');
      expect(remote.releaseUnusedInput).not.toHaveBeenCalled();
      expect(transport.encryptCapture).toHaveBeenCalledTimes(1);
      expect(await pending()).toMatchObject({ inputCid: 'bafyinput1' });
    });

    test('a cancel in that window cancels the job the backend holds and releases its input as the job input', async () => {
      const { bridge, api, remote } = makeBridge();
      loseResponses(api, 1);
      await expect(bridge.advance(nodeId, attempt())).rejects.toThrow('response lost');
      api.getReconstructionComputeJob.mockResolvedValue(bound());
      await bridge.advance(nodeId, attempt({ state: 'waiting_for_node', cancelRequested: true }));
      expect(actions().slice(-3)).toEqual(['compute-job/cancel', 'cancelled', 'cleanup']);
      expect(remote.releaseInput).toHaveBeenCalledTimes(1);
      expect(remote.releaseUnusedInput).not.toHaveBeenCalled();
      expect(calls.at(-1)!.body).toEqual({ nodeId, state: 'complete' });
      expect(await pending()).toBeUndefined();
    });

    test('an attempt that ends while a job holds the stored input never releases it as an unused one', async () => {
      const { bridge, api, remote } = makeBridge();
      loseResponses(api, 1);
      await expect(bridge.advance(nodeId, attempt())).rejects.toThrow('response lost');
      api.getReconstructionComputeJob.mockResolvedValue(bound());
      await bridge.advance(nodeId, attempt({ state: 'processing', computeJobId: jobId }));
      // follow() found the job holding the input and cleared the descriptor.
      expect(await pending()).toBeUndefined();
      expect(remote.releaseUnusedInput).not.toHaveBeenCalled();
    });

    test('a job view without an input CID does not clear the stored descriptor', async () => {
      const { bridge, api } = makeBridge();
      failJobCalls(api, 1);
      await expect(bridge.advance(nodeId, attempt())).rejects.toThrow('unavailable');
      api.getReconstructionComputeJob.mockResolvedValue({ ...job('RUNNING'), inputCid: undefined } as unknown as RemoteComputeJob);
      await bridge.advance(nodeId, attempt({ state: 'processing', computeJobId: jobId }));
      expect(await pending()).toMatchObject({ inputCid: 'bafyinput1' });
    });
  });

  describe('a stored input that cannot be released', () => {
    test('does not stop matching: the next provider is tried and the pin stays on a retry list', async () => {
      const { bridge, api, transport, remote } = makeBridge();
      failJobCalls(api, 1);
      await expect(bridge.advance(nodeId, attempt())).rejects.toThrow('unavailable');
      remote.releaseUnusedInput.mockRejectedValueOnce(Object.assign(new Error('pin_release_outcome_requires_review'), { code: 'pin_release_outcome_requires_review' }));
      providers = [providerOf(providerB, 'key-b')];
      await bridge.advance(nodeId, attempt({ state: 'waiting_for_node' }));
      expect(transport.encryptCapture).toHaveBeenCalledTimes(2);
      expect(jobCalls().at(-1)!.body).toMatchObject({ providerNodeId: providerB, inputCid: 'bafyinput2' });
      expect(await pending()).toBeUndefined();
      expect((await stateFile()).unusedInputs).toEqual(['bafyinput1']);
    });

    test('is retried when the attempt ends, and reports the cleanup as failed while it still fails', async () => {
      const { bridge, api, remote } = makeBridge();
      failJobCalls(api, 1);
      await expect(bridge.advance(nodeId, attempt())).rejects.toThrow('unavailable');
      remote.releaseUnusedInput.mockRejectedValueOnce(new Error('kubo offline')).mockRejectedValueOnce(new Error('kubo offline'));
      providers = [providerOf(providerB, 'key-b')];
      await bridge.advance(nodeId, attempt({ state: 'waiting_for_node' }));
      await bridge.advance(nodeId, attempt({ state: 'waiting_for_node', cancelRequested: true }));
      expect(calls.at(-1)).toMatchObject({ action: 'cleanup', body: { state: 'failed' } });
      expect((await stateFile()).unusedInputs).toEqual(['bafyinput1']);
      // A later pass (the pin can be released now) clears the list.
      await bridge.advance(nodeId, attempt({ state: 'waiting_for_node', cancelRequested: true }));
      expect(calls.at(-1)).toMatchObject({ action: 'cleanup', body: { state: 'complete' } });
      expect((await stateFile()).unusedInputs ?? []).toEqual([]);
    });

    test('is retried on the next matching pass too', async () => {
      const { bridge, api, remote } = makeBridge();
      failJobCalls(api, 2);
      await expect(bridge.advance(nodeId, attempt())).rejects.toThrow('unavailable');
      remote.releaseUnusedInput.mockRejectedValueOnce(new Error('kubo offline'));
      providers = [providerOf(providerB, 'key-b')];
      await expect(bridge.advance(nodeId, attempt({ state: 'waiting_for_node' }))).rejects.toThrow('unavailable');
      expect(remote.releaseUnusedInput).toHaveBeenCalledTimes(1);
      await bridge.advance(nodeId, attempt({ state: 'waiting_for_node' }));
      expect(remote.releaseUnusedInput).toHaveBeenCalledTimes(2);
      expect((await stateFile()).unusedInputs ?? []).toEqual([]);
    });
  });

  test('a stored input made for a different capture is released and encrypted again', async () => {
    const { bridge, api, transport, remote } = makeBridge();
    failJobCalls(api, 1);
    await expect(bridge.advance(nodeId, attempt())).rejects.toThrow('unavailable');
    const state = await stateFile();
    state.pendingInput.captureId = 'managed-some-earlier-capture';
    await fs.writeFile(path.join(root(), 'state.json'), JSON.stringify(state));
    await bridge.advance(nodeId, attempt({ state: 'waiting_for_node' }));
    expect(remote.releaseUnusedInput).toHaveBeenCalledWith('bafyinput1');
    expect(transport.encryptCapture).toHaveBeenCalledTimes(2);
    expect(jobCalls().at(-1)!.body).toMatchObject({ inputCid: 'bafyinput2' });
  });

  describe('the attempt record', () => {
    const garbage = '{"excludedProviders":[],"captureId":"managed-9b6f6f0e-2d3c-4b8a-9a52-6c';

    test('is never replaced by an empty one when it cannot be read: nothing is prepared or encrypted over it', async () => {
      const { bridge, api, captures, transport, prepareFn } = makeBridge();
      failJobCalls(api, 1);
      await expect(bridge.advance(nodeId, attempt())).rejects.toThrow('unavailable');
      await fs.writeFile(path.join(root(), 'state.json'), garbage);
      const registered = captures.registerRemote.mock.calls.length;
      await bridge.advance(nodeId, attempt({ state: 'waiting_for_node' }));
      expect(captures.registerRemote.mock.calls.length).toBe(registered);
      expect(transport.encryptCapture).toHaveBeenCalledTimes(1);
      expect(prepareFn).toHaveBeenCalledTimes(1);
      // The unreadable record itself is left in place for review.
      expect(await fs.readFile(path.join(root(), 'state.json'), 'utf8')).toBe(garbage);
    });

    test('is reported to the backend as a failed attempt instead of wedging every later claim', async () => {
      const { bridge, api } = makeBridge();
      failJobCalls(api, 1);
      await expect(bridge.advance(nodeId, attempt())).rejects.toThrow('unavailable');
      await fs.writeFile(path.join(root(), 'state.json'), garbage);
      await bridge.advance(nodeId, attempt({ state: 'waiting_for_node' }));
      // The platform failed, not the capture: a code an operator may retry.
      expect(calls.at(-1)).toMatchObject({ action: 'failure', body: { nodeId, code: 'requester_unavailable' } });
      expect(warned()).toHaveBeenCalledWith(expect.objectContaining({ code: 'reconstruction_state_unreadable' }), expect.any(String));
      // When even the report fails, the pass fails (and is tried again), rather than the attempt being forgotten.
      api.reconstructionCall.mockRejectedValueOnce(new KubusApiError('backend down', 503, { success: false }));
      await expect(bridge.advance(nodeId, attempt({ state: 'processing', computeJobId: jobId }))).rejects.toThrow('backend down');
    });

    test('is written through a temporary file that does not stay behind', async () => {
      const { bridge, api } = makeBridge();
      failJobCalls(api, 1);
      await expect(bridge.advance(nodeId, attempt())).rejects.toThrow('unavailable');
      const names = await fs.readdir(root());
      expect(names.filter(name => name.includes('.tmp'))).toEqual([]);
      expect(JSON.parse(await fs.readFile(path.join(root(), 'state.json'), 'utf8')).pendingInput.inputCid).toBe('bafyinput1');
    });
  });

  describe('terminal paths release an input no job holds', () => {
    /** A stored descriptor that no job uses, as left by a crash between encrypting and creating the job. */
    async function leave(cid = 'bafystale') {
      const state = await stateFile();
      state.pendingInput = { captureId: state.captureId, providerNodeId: providerA, providerEncryptionPublicKey: 'key', inputCid: cid, inputBytes: 5, inputHash: 'f'.repeat(64), inputKeyEnvelope: {}, jobSpec: {} };
      await fs.writeFile(path.join(root(), 'state.json'), JSON.stringify(state));
    }

    test('cancelled', async () => {
      const { bridge, api, remote } = makeBridge();
      failJobCalls(api, 1);
      await expect(bridge.advance(nodeId, attempt())).rejects.toThrow('unavailable');
      await bridge.advance(nodeId, attempt({ state: 'waiting_for_node', cancelRequested: true }));
      expect(actions().slice(-2)).toEqual(['cancelled', 'cleanup']);
      expect(remote.releaseUnusedInput).toHaveBeenCalledWith('bafyinput1');
      expect(calls.at(-1)!.body).toEqual({ nodeId, state: 'complete' });
      expect(await pending()).toBeUndefined();
    });

    test('ready', async () => {
      const { bridge, remote } = makeBridge();
      await bridge.advance(nodeId, attempt());
      await leave();
      await bridge.advance(nodeId, processing());
      expect(remote.releaseInput).toHaveBeenCalled();
      expect(remote.releaseUnusedInput).toHaveBeenCalledWith('bafystale');
      expect(await pending()).toBeUndefined();
    });

    test('failed', async () => {
      const { bridge, api, remote } = makeBridge();
      await bridge.advance(nodeId, attempt());
      await leave();
      for (const provider of [providerA, providerB, '99999999-9999-4999-8999-999999999999']) {
        api.getReconstructionComputeJob.mockResolvedValueOnce(job('FAILED', provider));
        await bridge.advance(nodeId, processing());
      }
      expect(calls.at(-2)).toMatchObject({ action: 'failure', body: { code: 'no_provider_completed' } });
      expect(remote.releaseUnusedInput).toHaveBeenCalledWith('bafystale');
      expect(remote.releaseUnusedInput).toHaveBeenCalledTimes(1);
      expect(await pending()).toBeUndefined();
    });

    test('needs more views', async () => {
      const { bridge, remote } = makeBridge();
      await bridge.advance(nodeId, attempt());
      await leave();
      // The prepared capture is gone, so matching prepares again, and that preparation reports too few views.
      const state = await stateFile(); delete state.captureId;
      await fs.writeFile(path.join(root(), 'state.json'), JSON.stringify(state));
      prepareOutcome = { ok: false, code: 'too_few_views', inputs: [], details: { registeredViews: 3, requiredViews: 20 } };
      await bridge.advance(nodeId, attempt({ state: 'waiting_for_node' }));
      expect(calls.some(call => call.action === 'failure' && call.body.code === 'too_few_views')).toBe(true);
      expect(remote.releaseUnusedInput).toHaveBeenCalledWith('bafystale');
      expect(await pending()).toBeUndefined();
    });

    test('a release that fails is reported as a failed requester cleanup and the descriptor stays for review', async () => {
      const { bridge, api, remote } = makeBridge();
      failJobCalls(api, 1);
      await expect(bridge.advance(nodeId, attempt())).rejects.toThrow('unavailable');
      remote.releaseUnusedInput.mockRejectedValueOnce(new Error('kubo offline'));
      await bridge.advance(nodeId, attempt({ state: 'waiting_for_node', cancelRequested: true }));
      expect(calls.at(-1)).toMatchObject({ action: 'cleanup', body: { state: 'failed' } });
      // The pin stays on the retry list (the descriptor itself is not needed once nothing will send it).
      expect((await stateFile()).unusedInputs).toEqual(['bafyinput1']);
    });
  });
});

const warned = () => (logger as unknown as { warn: ReturnType<typeof vi.fn> }).warn;
const resetAttempt = async () => { calls = []; await fs.rm(path.join(dataRoot, 'private'), { recursive: true, force: true }); };

describe('face review gate', () => {
  const flaggedInputs = [
    { fileId: '11111111-1111-4111-8111-111111111111', usable: true, usableViews: 1, reason: null, faceReview: 2 },
    { fileId: '22222222-2222-4222-8222-222222222222', usable: true, usableViews: 5, reason: null },
  ];
  /** Prepare writes a dataset (with `preparedRecord`) and returns these inputs. */
  function makeFlagged(inputs = flaggedInputs) {
    const made = makeBridge();
    made.prepareFn.mockImplementation(async ({ outputDirectory }: { outputDirectory: string }): Promise<PrepareOutcome> => {
      const dataset = path.join(outputDirectory, 'dataset');
      await fs.mkdir(path.join(dataset, 'images'), { recursive: true });
      await fs.writeFile(path.join(dataset, 'images', 'photo_00000.jpg'), 'masked');
      await fs.writeFile(path.join(dataset, 'transforms.json'), '{}');
      if (preparedRecord) await fs.writeFile(path.join(dataset, 'prepared.json'), JSON.stringify(preparedRecord));
      return { ok: true, datasetDirectory: dataset, inputs, sfm: { registeredViews: 30, submittedViews: 34 } };
    });
    return made;
  }

  test('a dataset with an image flagged for a human look never leaves the Node: no capture, no encryption, no provider', async () => {
    preparedRecord = flaggedRecord();
    const { bridge, captures, transport } = makeFlagged();
    await bridge.advance(nodeId, attempt());
    expect(transport.encryptCapture).not.toHaveBeenCalled();
    expect(captures.registerRemote).not.toHaveBeenCalled();
    expect(actions()).not.toContain('providers');
    expect(actions()).not.toContain('compute-job');
    expect(actions().slice(-2)).toEqual(['failure', 'cleanup']);
    // The per-file feedback names the flagged source file with the reason `face_review`; the other file is as it was.
    const failure = calls.find(call => call.action === 'failure')!.body as { code: string; feedback: { inputs: Array<Record<string, unknown>> } };
    expect(failure.code).toBe('face_review_required');
    expect(failure.feedback.inputs).toEqual([
      { fileId: '11111111-1111-4111-8111-111111111111', usable: false, usableViews: 1, reason: 'face_review' },
      { fileId: '22222222-2222-4222-8222-222222222222', usable: true, usableViews: 5 },
    ]);
    // The masked dataset does not stay behind: only the sources and the attempt's record do.
    expect((await fs.readdir(root())).sort()).toEqual(['set', 'state.json']);
    expect(calls.at(-1)!.body).toEqual({ nodeId, state: 'complete' });
  });

  test('a flag of any kind stops it, in a video part too, and a truncated list counts', async () => {
    for (const record of [
      { photos: { ran: true, needsLook: { ...cleanLook, weakExcluded: 1 } } },
      { photos: { ran: true, needsLook: { ...cleanLook } }, video: { ran: true, needsLook: { ...cleanLook, images: 2, items: [{}, {}] } } },
      { video: { ran: true, needsLook: { ...cleanLook, itemsTruncated: true } } },
    ]) {
      await resetAttempt();
      preparedRecord = { schema: 'kubus.prepared-dataset/1', faceMasking: record };
      const { bridge, transport } = makeFlagged();
      await bridge.advance(nodeId, attempt());
      expect(calls.find(call => call.action === 'failure')!.body).toMatchObject({ code: 'face_review_required' });
      expect(transport.encryptCapture).not.toHaveBeenCalled();
    }
  });

  test('a clean record goes on to a provider as before', async () => {
    const { bridge, transport } = makeFlagged();
    await bridge.advance(nodeId, attempt());
    expect(transport.encryptCapture).toHaveBeenCalledTimes(1);
    expect(actions()).not.toContain('failure');
  });

  test('a record that is missing, or does not show that masking ran, is refused and never sent', async () => {
    for (const record of [null, { schema: 'kubus.prepared-dataset/1' }, { schema: 'kubus.prepared-dataset/1', faceMasking: null }, { schema: 'kubus.prepared-dataset/1', faceMasking: {} },
      { schema: 'kubus.prepared-dataset/1', faceMasking: { photos: { ran: true } } }]) {
      await resetAttempt();
      preparedRecord = record;
      const { bridge, transport } = makeFlagged();
      await bridge.advance(nodeId, attempt());
      expect(calls.find(call => call.action === 'failure')!.body, JSON.stringify(record)).toMatchObject({ code: 'face_masking_failed' });
      expect(transport.encryptCapture).not.toHaveBeenCalled();
    }
  });

  test('a record that is not JSON is refused too', async () => {
    const { bridge, transport, prepareFn } = makeBridge();
    prepareFn.mockImplementation(async ({ outputDirectory }: { outputDirectory: string }): Promise<PrepareOutcome> => {
      const dataset = path.join(outputDirectory, 'dataset');
      await fs.mkdir(dataset, { recursive: true });
      await fs.writeFile(path.join(dataset, 'prepared.json'), '{"faceMasking": ');
      return { ok: true, datasetDirectory: dataset, inputs: [], sfm: {} };
    });
    await bridge.advance(nodeId, attempt());
    expect(calls.find(call => call.action === 'failure')!.body).toMatchObject({ code: 'face_masking_failed' });
    expect(transport.encryptCapture).not.toHaveBeenCalled();
  });

  test('a prepared capture from an earlier version is checked again before it is encrypted', async () => {
    const { bridge, transport } = makeBridge();
    providers = [];
    await bridge.advance(nodeId, attempt());
    // Prepared and registered while no provider was eligible; the stored dataset now carries a flag.
    await fs.writeFile(path.join(root(), 'capture', 'dataset', 'prepared.json'), JSON.stringify(flaggedRecord()));
    providers = [{ nodeId: providerA, encryptionPublicKey: 'key', privateOutputProtocol: PRIVATE_OUTPUT_PROTOCOL, spatialOutputProtocol: SPATIAL_OUTPUT_PROTOCOL }];
    await bridge.advance(nodeId, attempt({ state: 'waiting_for_node' }));
    expect(transport.encryptCapture).not.toHaveBeenCalled();
    expect(calls.find(call => call.action === 'failure')!.body).toMatchObject({ code: 'face_review_required' });
    expect(actions().slice(-2)).toEqual(['failure', 'cleanup']);
  });

  test('a provider that refused the dataset for a face review ends the attempt for good: no other provider is tried', async () => {
    const { bridge, api, remote, transport } = makeBridge();
    await bridge.advance(nodeId, attempt());
    api.getReconstructionComputeJob.mockResolvedValueOnce({ ...job('FAILED'), failure: { code: 'provider_face_review_required' } });
    await bridge.advance(nodeId, processing());
    expect(calls.find(call => call.action === 'failure')!.body).toMatchObject({ code: 'face_review_required' });
    expect(actions().slice(-2)).toEqual(['failure', 'cleanup']);
    expect(actions().filter(action => action === 'providers')).toHaveLength(1);
    expect(transport.encryptCapture).toHaveBeenCalledTimes(1);
    // The provider's input pin is released and its cleanup statement is still looked for.
    expect(remote.releaseInput).toHaveBeenCalledWith(expect.objectContaining({ state: 'FAILED' }));
    expect((await stateFile()).providerCleanups[jobId]).toMatchObject({ providerNodeId: providerA, status: 'awaiting' });
    expect((await stateFile()).excludedProviders ?? []).toEqual([]);
  });

  test('the provider failure code is read from the job view wherever the backend puts it', async () => {
    for (const failure of [{ code: 'provider_face_review_required' }, { metadata: { code: 'provider_face_review_required' } }, { reason: 'provider_face_review_required' }]) {
      await resetAttempt();
      const { bridge, api } = makeBridge();
      await bridge.advance(nodeId, attempt());
      api.getReconstructionComputeJob.mockResolvedValueOnce({ ...job('FAILED'), failure });
      await bridge.advance(nodeId, processing());
      expect(calls.find(call => call.action === 'failure')!.body, JSON.stringify(failure)).toMatchObject({ code: 'face_review_required' });
    }
  });

  test('any other provider failure still excludes that provider and tries the next', async () => {
    const { bridge, api } = makeBridge();
    await bridge.advance(nodeId, attempt());
    api.getReconstructionComputeJob.mockResolvedValueOnce({ ...job('FAILED'), failure: { code: 'worker_failed' } });
    await bridge.advance(nodeId, processing());
    expect(calls.find(call => call.action === 'failure')).toBeUndefined();
    expect(calls.at(-1)!.body).toMatchObject({ state: 'waiting_for_node', stage: 'provider_lost' });
  });
});

describe('transient failures are not verification failures', () => {
  test('a result that cannot be fetched or stored is retried on a later pass without acknowledging anything', async () => {
    const { bridge, remote } = makeBridge();
    await bridge.advance(nodeId, attempt());
    for (const error of [Object.assign(new Error('ENOSPC: no space left on device'), { code: 'ENOSPC' }), new Error('Kubo cat failed with HTTP 503'),
      new DOMException('The operation was aborted due to timeout', 'TimeoutError'), Object.assign(new Error('output_fetch_stalled'), { code: 'output_fetch_stalled' })]) {
      remote.stagePrivateOutput.mockRejectedValueOnce(error);
      await expect(bridge.advance(nodeId, processing())).rejects.toBe(error);
    }
    // Nothing was signed, nothing was sent: the job is not disputed and no provider is excluded.
    expect(remote.signedAcknowledgement).not.toHaveBeenCalled();
    expect(actions()).not.toContain('compute-job/acknowledge');
    expect((await stateFile()).excludedProviders).toEqual([]);
    // The next pass fetches it and goes on.
    await bridge.advance(nodeId, processing());
    expect(remote.signedAcknowledgement).toHaveBeenCalledWith(expect.objectContaining({ state: 'OUTPUT_READY' }), true, undefined);
    expect(calls.find(call => call.action === 'candidate')).toBeDefined();
  });

  test('a result that is wrong is still rejected with a signed, final answer', async () => {
    for (const error of [Object.assign(new Error('x'), { code: 'private_output_signature_invalid' }), new Error('private_output_digest_mismatch'), new Error('Unsupported state or unable to authenticate data'), new Error('spatial_manifest_variant_invalid')]) {
      await resetAttempt();
      const { bridge, remote } = makeBridge();
      await bridge.advance(nodeId, attempt());
      remote.stagePrivateOutput.mockRejectedValueOnce(error);
      await bridge.advance(nodeId, processing());
      expect(remote.signedAcknowledgement, error.message).toHaveBeenCalledWith(expect.anything(), false, 'output_verification_failed');
    }
  });
});

describe('lease renewal while preparing', () => {
  const slow = (ms: number) => async ({ outputDirectory }: { outputDirectory: string }): Promise<PrepareOutcome> => {
    await new Promise(resolve => setTimeout(resolve, ms));
    const dataset = path.join(outputDirectory, 'dataset');
    await fs.mkdir(path.join(dataset, 'images'), { recursive: true });
    await fs.writeFile(path.join(dataset, 'prepared.json'), JSON.stringify(cleanRecord()));
    return { ok: true, datasetDirectory: dataset, inputs: [], sfm: { registeredViews: 30, submittedViews: 34 } };
  };
  const posing = () => calls.filter(call => call.action === 'progress' && call.body.stage === 'solving_poses');

  test('a long prepare renews the lease on an interval, not just at its start and end', async () => {
    const { bridge, prepareFn } = makeBridge(undefined, { leaseRenewMs: 20 });
    prepareFn.mockImplementation(slow(130));
    await bridge.advance(nodeId, attempt());
    // One report when the stage starts, and renewals on top of it while the worker runs.
    expect(posing().length).toBeGreaterThanOrEqual(4);
    // The timer does not outlive the prepare.
    const settled = posing().length;
    await new Promise(resolve => setTimeout(resolve, 80));
    expect(posing().length).toBe(settled);
  });

  test('a renewal that fails is logged and does not fail the prepare', async () => {
    const { bridge, prepareFn, api } = makeBridge(undefined, { leaseRenewMs: 20 });
    prepareFn.mockImplementation(slow(100));
    const original = api.reconstructionCall.getMockImplementation()!;
    let renewals = 0;
    api.reconstructionCall.mockImplementation(async (id: string, action: string, body: Record<string, unknown>) => {
      if (action === 'progress' && body.stage === 'solving_poses') { renewals += 1; if (renewals > 1) throw new KubusApiError('unavailable', 503, { success: false }); }
      return original(id, action, body);
    });
    await bridge.advance(nodeId, attempt());
    expect(renewals).toBeGreaterThan(1);
    expect(warned()).toHaveBeenCalledWith(expect.objectContaining({ code: 'managed_requester_lease_renewal_failed' }), expect.any(String));
    expect(actions()).toContain('compute-job');
  });

  test('a cancel the backend reports during the prepare is acted on once it ends', async () => {
    const { bridge, prepareFn, api } = makeBridge(undefined, { leaseRenewMs: 20 });
    prepareFn.mockImplementation(slow(80));
    const original = api.reconstructionCall.getMockImplementation()!;
    api.reconstructionCall.mockImplementation(async (id: string, action: string, body: Record<string, unknown>) => {
      if (action === 'progress' && ['solving_poses', 'prepared'].includes(String(body.stage))) return { ...attempt({ state: 'preparing' }), cancelRequested: true };
      return original(id, action, body);
    });
    await bridge.advance(nodeId, attempt());
    expect(actions()).not.toContain('providers');
    expect(actions().slice(-2)).toEqual(['cancelled', 'cleanup']);
  });

  test('the renewal interval defaults to under the five minutes the contract allows', () => {
    expect(DEFAULT_LEASE_RENEW_MS).toBeLessThanOrEqual(5 * 60_000);
  });
});

describe('a prepare that was cut off by a restart', () => {
  const prepareJobIds = (prepareFn: ReturnType<typeof makeBridge>['prepareFn']) => prepareFn.mock.calls.map(call => (call[0] as unknown as { jobId: string }).jobId);

  test('each prepare run has its own worker job id, never the reconstruction id', async () => {
    const { bridge, prepareFn } = makeBridge();
    await bridge.advance(nodeId, attempt());
    const [id] = prepareJobIds(prepareFn);
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(id).not.toBe(reconstructionId);
    // Finished: nothing is left to cancel on a later pass.
    expect((await stateFile()).prepareJobId).toBeUndefined();
  });

  test('a prepare that ended without an answer is cancelled on the worker before its directory is touched, then runs again', async () => {
    const first = makeBridge();
    first.prepareFn.mockRejectedValueOnce(Object.assign(new Error('fetch failed'), { code: 'ECONNRESET' }));
    await expect(first.bridge.advance(nodeId, attempt())).rejects.toThrow('fetch failed');
    const [orphan] = prepareJobIds(first.prepareFn);
    expect((await stateFile()).prepareJobId).toBe(orphan);
    // A leftover of the orphaned run in the work directory.
    await fs.mkdir(path.join(root(), 'prepare-1', 'dataset'), { recursive: true });
    await fs.writeFile(path.join(root(), 'prepare-1', 'dataset', 'orphan'), 'x');
    // The restarted Node.
    const second = makeBridge();
    const order: string[] = [];
    second.cancelPrepare.mockImplementation(async () => { order.push(`cancel:${await fs.stat(path.join(root(), 'prepare-1', 'dataset', 'orphan')).then(() => 'dir-present', () => 'dir-gone')}`); });
    await second.bridge.advance(nodeId, attempt());
    expect(second.cancelPrepare).toHaveBeenCalledTimes(1);
    expect(second.cancelPrepare).toHaveBeenCalledWith(orphan);
    expect(order).toEqual(['cancel:dir-present']);
    const [fresh] = prepareJobIds(second.prepareFn);
    expect(fresh).not.toBe(orphan);
    expect(actions()).toContain('compute-job');
    expect((await stateFile()).prepareJobId).toBeUndefined();
  });

  test('when the worker cannot be asked to cancel, the work directory is left alone and the pass is retried later', async () => {
    const first = makeBridge();
    first.prepareFn.mockRejectedValueOnce(new Error('fetch failed'));
    await expect(first.bridge.advance(nodeId, attempt())).rejects.toThrow();
    await fs.mkdir(path.join(root(), 'prepare-1', 'dataset'), { recursive: true });
    await fs.writeFile(path.join(root(), 'prepare-1', 'dataset', 'orphan'), 'x');
    const second = makeBridge();
    second.cancelPrepare.mockRejectedValueOnce(new Error('worker_not_quiescent'));
    await expect(second.bridge.advance(nodeId, attempt())).rejects.toThrow('worker_not_quiescent');
    expect(second.prepareFn).not.toHaveBeenCalled();
    expect(await fs.readFile(path.join(root(), 'prepare-1', 'dataset', 'orphan'), 'utf8')).toBe('x');
    // The next pass asks again.
    await second.bridge.advance(nodeId, attempt());
    expect(second.cancelPrepare).toHaveBeenCalledTimes(2);
    expect(second.prepareFn).toHaveBeenCalledTimes(1);
  });

  test('a typed prepare failure is an answer: nothing is left to cancel', async () => {
    const { bridge, cancelPrepare } = makeBridge({ ok: false, code: 'sfm_failed', details: {}, inputs: [] });
    await bridge.advance(nodeId, attempt());
    expect((await stateFile()).prepareJobId).toBeUndefined();
    expect(cancelPrepare).not.toHaveBeenCalled();
  });
});

describe('the encrypted input is never orphaned by a crash', () => {
  test('the pin owner is recorded before encrypting and handed to the transport', async () => {
    const { bridge, transport } = makeBridge();
    let recorded: string | undefined;
    transport.encryptCapture.mockImplementationOnce((async (...args: unknown[]) => {
      recorded = (await stateFile()).encryptingOwner;
      expect((args[3] as { pinOwner: string }).pinOwner).toBe(recorded);
      return { inputCid: 'bafyinput1', inputBytes: 11, inputHash: 'e'.repeat(64), inputKeyEnvelope: { context: 'envelope-1' }, jobSpec: { fileCount: 3 } };
    }) as never);
    await bridge.advance(nodeId, attempt());
    expect(recorded).toMatch(/^requester-input:[0-9a-f-]{36}$/);
    // Once the descriptor is stored the owner is not "in flight" any more.
    expect((await stateFile()).encryptingOwner).toBeUndefined();
  });

  test('a crash between encrypting and storing the descriptor releases that pin before encrypting again', async () => {
    const first = makeBridge();
    first.transport.encryptCapture.mockRejectedValueOnce(new Error('process died'));
    await expect(first.bridge.advance(nodeId, attempt())).rejects.toThrow('process died');
    const owner = (await stateFile()).encryptingOwner as string;
    expect(owner).toMatch(/^requester-input:/);
    const second = makeBridge();
    await second.bridge.advance(nodeId, attempt({ state: 'waiting_for_node' }));
    expect(second.remote.releaseInputsOwnedBy).toHaveBeenCalledWith(owner);
    const [, , , options] = second.transport.encryptCapture.mock.calls[0] as unknown as [string, string, string, { pinOwner: string }];
    expect(options.pinOwner).not.toBe(owner);
    expect((await stateFile()).unusedInputs ?? []).toEqual([]);
    expect((await stateFile()).encryptingOwner).toBeUndefined();
  });

  test('an owner whose pin cannot be released yet stays on the retry list and is reported as not clean', async () => {
    const first = makeBridge();
    first.transport.encryptCapture.mockRejectedValueOnce(new Error('process died'));
    await expect(first.bridge.advance(nodeId, attempt())).rejects.toThrow();
    const owner = (await stateFile()).encryptingOwner as string;
    const second = makeBridge();
    second.remote.releaseInputsOwnedBy.mockRejectedValueOnce(new Error('kubo offline'));
    await second.bridge.advance(nodeId, attempt({ state: 'waiting_for_node', cancelRequested: true }));
    expect((await stateFile()).unusedInputs).toEqual([owner]);
    expect(calls.at(-1)).toMatchObject({ action: 'cleanup', body: { state: 'failed' } });
  });
});

describe('requester cleanup is only complete when the pin was released', () => {
  test('a job input whose pin release is switched off is not reported as complete, and is retried', async () => {
    const { bridge, remote } = makeBridge();
    await bridge.advance(nodeId, attempt());
    remote.releaseInput.mockResolvedValueOnce({ released: false, reason: 'pin_release_activation_required' });
    await bridge.advance(nodeId, processing());
    expect(calls.at(-1)).toMatchObject({ action: 'cleanup', body: { state: 'pending' } });
    expect((await stateFile()).unusedInputs).toEqual(['bafyinput']);
    expect((await stateFile()).requesterCleanup).toBe('pending');
    // Pin release is switched on later: the sweep releases it and reports the cleanup complete.
    await bridge.sweep(nodeId);
    expect(remote.releaseUnusedInput).toHaveBeenCalledWith('bafyinput');
    expect(calls.at(-1)).toMatchObject({ action: 'cleanup', body: { state: 'complete' } });
    expect((await stateFile()).unusedInputs ?? []).toEqual([]);
    expect((await stateFile()).requesterCleanup).toBe('complete');
    // Nothing more to do on later sweeps.
    const reported = calls.length;
    await bridge.sweep(nodeId);
    expect(calls.length).toBe(reported);
  });

  test('an unused input held because release is switched off is pending, not failed and not complete', async () => {
    const { bridge, api, remote } = makeBridge();
    const original = api.reconstructionCall.getMockImplementation()!;
    let left = 1;
    api.reconstructionCall.mockImplementation(async (id: string, action: string, body: Record<string, unknown>) => {
      if (action === 'compute-job' && left > 0) { left -= 1; throw new KubusApiError('unavailable', 503, { success: false }); }
      return original(id, action, body);
    });
    await expect(bridge.advance(nodeId, attempt())).rejects.toThrow('unavailable');
    remote.releaseUnusedInput.mockResolvedValue({ released: false, reason: 'pin_release_activation_required' });
    await bridge.advance(nodeId, attempt({ state: 'waiting_for_node', cancelRequested: true }));
    expect(calls.at(-1)).toMatchObject({ action: 'cleanup', body: { state: 'pending' } });
  });

  test('a release that threw is a failed cleanup, which a later sweep retries even though no pass claims the attempt again', async () => {
    const { bridge, remote } = makeBridge();
    await bridge.advance(nodeId, attempt());
    remote.releaseInput.mockRejectedValueOnce(new Error('kubo offline'));
    await bridge.advance(nodeId, processing());
    expect(calls.at(-1)).toMatchObject({ action: 'cleanup', body: { state: 'failed' } });
    expect((await stateFile()).unusedInputs).toEqual(['bafyinput']);
    remote.releaseUnusedInput.mockRejectedValueOnce(new Error('kubo offline'));
    await bridge.sweep(nodeId);
    expect(calls.at(-1)).toMatchObject({ action: 'cleanup', body: { state: 'failed' } });
    expect((await stateFile()).unusedInputs).toEqual(['bafyinput']);
    await bridge.sweep(nodeId);
    expect(calls.at(-1)).toMatchObject({ action: 'cleanup', body: { state: 'complete' } });
  });
});

describe('retention purge', () => {
  const stagedDir = (id = jobId) => path.join(dataRoot, 'private', 'remote-results', id);

  /** An attempt that finished (ready): it left a record with the provider job, and a staged result is put back. */
  async function finished() {
    const made = makeBridge();
    await made.bridge.advance(nodeId, attempt());
    await made.bridge.advance(nodeId, processing());
    await fs.mkdir(stagedDir(), { recursive: true });
    await fs.writeFile(path.join(stagedDir(), 'spatial_mobile'), 'plaintext reconstruction');
    return made;
  }

  test('removes the attempt root, the staged results and the capture record, then acknowledges the purge to the backend', async () => {
    const { bridge, api, captures } = await finished();
    api.reconstructionRetention.mockResolvedValueOnce({ purge: [reconstructionId] });
    expect(await bridge.purgeExpired(nodeId)).toEqual([reconstructionId]);
    await expect(fs.stat(root())).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(fs.stat(stagedDir())).rejects.toMatchObject({ code: 'ENOENT' });
    expect(captures.removeRemote).toHaveBeenCalledWith(`managed-${reconstructionId}`);
    expect(api.ackReconstructionRetention).toHaveBeenCalledWith(nodeId, [reconstructionId]);
  });

  test('a staged result the attempt never recorded as finished (a crash while verifying) is removed too', async () => {
    const { bridge, api, remote } = makeBridge();
    await bridge.advance(nodeId, attempt());
    remote.stagePrivateOutput.mockImplementationOnce(async () => { await fs.mkdir(stagedDir(), { recursive: true }); throw new Error('process died'); });
    await expect(bridge.advance(nodeId, processing())).rejects.toThrow('process died');
    expect((await stateFile()).stagedJobs).toEqual([jobId]);
    api.reconstructionRetention.mockResolvedValueOnce({ purge: [reconstructionId] });
    await bridge.purgeExpired(nodeId);
    await expect(fs.stat(stagedDir())).rejects.toMatchObject({ code: 'ENOENT' });
  });

  test('releases the input pins the attempt still owns before it acknowledges, job-held ones included', async () => {
    const { bridge, api, remote } = makeBridge();
    await bridge.advance(nodeId, attempt());
    // The job was created from this input: it is recorded as held, whatever happens to the attempt afterwards.
    expect((await stateFile()).heldInputs).toEqual(['bafyinput1']);
    api.reconstructionRetention.mockResolvedValueOnce({ purge: [reconstructionId] });
    await bridge.purgeExpired(nodeId);
    expect(remote.releaseUnusedInput).toHaveBeenCalledWith('bafyinput1');
    expect(api.ackReconstructionRetention).toHaveBeenCalledWith(nodeId, [reconstructionId]);
    await expect(fs.stat(root())).rejects.toMatchObject({ code: 'ENOENT' });
  });

  test('an attempt whose pin cannot be released yet is kept and not acknowledged, and is tried again on the next purge', async () => {
    const { bridge, api, remote } = await finished();
    const state = await stateFile();
    await fs.writeFile(path.join(root(), 'state.json'), JSON.stringify({ ...state, unusedInputs: ['bafyleft'] }));
    api.reconstructionRetention.mockResolvedValue({ purge: [reconstructionId] });
    remote.releaseUnusedInput.mockResolvedValueOnce({ released: false, reason: 'pin_release_activation_required' });
    expect(await bridge.purgeExpired(nodeId)).toEqual([]);
    expect(api.ackReconstructionRetention).not.toHaveBeenCalled();
    expect((await fs.stat(path.join(root(), 'state.json'))).isFile()).toBe(true);
    // The staged result and the capture are gone regardless: only the unreleased pin keeps the record.
    await expect(fs.stat(stagedDir())).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await bridge.purgeExpired(nodeId)).toEqual([reconstructionId]);
    expect(api.ackReconstructionRetention).toHaveBeenCalledWith(nodeId, [reconstructionId]);
    await expect(fs.stat(root())).rejects.toMatchObject({ code: 'ENOENT' });
  });

  test('a release that throws is kept and not acknowledged', async () => {
    const { bridge, api, remote } = await finished();
    const state = await stateFile();
    await fs.writeFile(path.join(root(), 'state.json'), JSON.stringify({ ...state, unusedInputs: ['bafyleft'] }));
    api.reconstructionRetention.mockResolvedValueOnce({ purge: [reconstructionId] });
    remote.releaseUnusedInput.mockRejectedValueOnce(new Error('kubo offline'));
    expect(await bridge.purgeExpired(nodeId)).toEqual([]);
    expect(api.ackReconstructionRetention).not.toHaveBeenCalled();
    expect((await fs.stat(root())).isDirectory()).toBe(true);
  });

  test('an unreadable record is neither purged nor acknowledged, and does not stop the others', async () => {
    const other = '1b6f6f0e-2d3c-4b8a-9a52-6c1f3e0d7a22';
    await fs.mkdir(path.join(dataRoot, 'private', 'reconstructions', other, 'set'), { recursive: true });
    const { bridge, api } = await finished();
    await fs.writeFile(path.join(root(), 'state.json'), '{"half');
    api.reconstructionRetention.mockResolvedValueOnce({ purge: [reconstructionId, other] });
    expect(await bridge.purgeExpired(nodeId)).toEqual([other]);
    expect(api.ackReconstructionRetention).toHaveBeenCalledWith(nodeId, [other]);
    expect(await fs.readFile(path.join(root(), 'state.json'), 'utf8')).toBe('{"half');
  });

  test('an attempt that was already purged is acknowledged (the earlier acknowledgement was lost)', async () => {
    const { bridge, api } = makeBridge();
    api.reconstructionRetention.mockResolvedValueOnce({ purge: [reconstructionId] });
    expect(await bridge.purgeExpired(nodeId)).toEqual([reconstructionId]);
    expect(api.ackReconstructionRetention).toHaveBeenCalledWith(nodeId, [reconstructionId]);
  });

  test('a failed acknowledgement is logged, not thrown: the backend lists the attempt again next time', async () => {
    const { bridge, api } = await finished();
    api.reconstructionRetention.mockResolvedValueOnce({ purge: [reconstructionId] });
    api.ackReconstructionRetention.mockRejectedValueOnce(new KubusApiError('unavailable', 503, { success: false }));
    await expect(bridge.purgeExpired(nodeId)).resolves.toEqual([reconstructionId]);
    expect(warned()).toHaveBeenCalledWith(expect.objectContaining({ code: 'managed_requester_retention_ack_failed' }), expect.any(String));
  });

  test('ids that are not attempt ids are never touched or acknowledged, and acknowledgements go out in batches of 100', async () => {
    const { bridge, api } = makeBridge();
    const ids = Array.from({ length: 120 }, (_, index) => `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`);
    api.reconstructionRetention.mockResolvedValueOnce({ purge: [...ids, '../escape'] });
    const purged = await bridge.purgeExpired(nodeId);
    expect(purged).toEqual(ids);
    expect(api.ackReconstructionRetention.mock.calls.map(call => call[1].length)).toEqual([100, 20]);
  });
});

describe('attempts that can no longer be claimed', () => {
  const stagedDir = () => path.join(dataRoot, 'private', 'remote-results', jobId);
  const HOUR = 60 * 60_000;
  const rewrite = async (change: Record<string, unknown>) => fs.writeFile(path.join(root(), 'state.json'), JSON.stringify({ ...(await stateFile()), ...change }));

  /** A mid-import attempt (result staged, a job-held input) that the requester then stopped advancing. */
  async function abandoned() {
    const made = makeBridge(undefined, { abandonedAfterMs: 6 * HOUR });
    await made.bridge.advance(nodeId, attempt());
    await fs.mkdir(stagedDir(), { recursive: true });
    await fs.writeFile(path.join(stagedDir(), 'spatial_mobile'), 'plaintext reconstruction');
    await rewrite({ stagedJobs: [jobId] });
    return made;
  }
  const age = (ms: number) => rewrite({ lastAdvancedAt: new Date(Date.now() - ms).toISOString() });

  test('after hours without a pass, its staged plaintext result, capture, pins and work files are removed and the cleanup is reported', async () => {
    const { bridge, remote, captures } = await abandoned();
    await age(7 * HOUR);
    const before = calls.length;
    await bridge.sweep(nodeId);
    await expect(fs.stat(stagedDir())).rejects.toMatchObject({ code: 'ENOENT' });
    expect(remote.releaseUnusedInput).toHaveBeenCalledWith('bafyinput1');
    expect(captures.removeRemote).toHaveBeenCalledWith(`managed-${reconstructionId}`);
    expect((await fs.readdir(root())).sort()).toEqual(['set', 'state.json']);
    expect(calls.slice(before).at(-1)).toMatchObject({ action: 'cleanup', body: { state: 'complete' } });
    expect((await stateFile()).requesterCleanup).toBe('complete');
    // Reported once.
    const reported = calls.length;
    await bridge.sweep(nodeId);
    expect(calls.length).toBe(reported);
  });

  test('an attempt that was advanced recently is never swept', async () => {
    const { bridge, remote } = await abandoned();
    await age(HOUR);
    await bridge.sweep(nodeId);
    expect((await fs.stat(stagedDir())).isDirectory()).toBe(true);
    expect(remote.releaseUnusedInput).not.toHaveBeenCalled();
  });

  test('an attempt that already reported its cleanup is not swept again', async () => {
    const { bridge } = await abandoned();
    await rewrite({ requesterCleanup: 'complete', lastAdvancedAt: new Date(Date.now() - 20 * HOUR).toISOString() });
    await bridge.sweep(nodeId);
    expect((await fs.stat(stagedDir())).isDirectory()).toBe(true);
  });

  test('the sweep reports pending when a pin could not be released yet, and tries again later', async () => {
    const { bridge, remote } = await abandoned();
    await age(7 * HOUR);
    remote.releaseUnusedInput.mockResolvedValueOnce({ released: false, reason: 'pin_release_activation_required' });
    const before = calls.length;
    await bridge.sweep(nodeId);
    expect(calls.slice(before).at(-1)).toMatchObject({ action: 'cleanup', body: { state: 'pending' } });
    await bridge.sweep(nodeId);
    expect(calls.at(-1)).toMatchObject({ action: 'cleanup', body: { state: 'complete' } });
  });

  test('a pass stamps the attempt so that an active one is not mistaken for abandoned', async () => {
    const { bridge } = makeBridge();
    await bridge.advance(nodeId, attempt());
    expect(Date.now() - Date.parse((await stateFile()).lastAdvancedAt)).toBeLessThan(5000);
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

  test('carries the per-input count of images flagged for a face review, and binds its token to this exact request', async () => {
    const issue = vi.fn(async () => 'token');
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async url => {
      if (String(url).endsWith('/health')) return new Response(JSON.stringify({ status: 'ready', inputModes: ['source_set'], faceMasking: true, workerInstanceId: 'w1' }));
      return new Response(JSON.stringify({ prepared: { path: 'dataset', sfm: { registeredViews: 30 }, inputs: [
        { input: 'photos/a.jpg', usable: true, usableViews: 1, faceReview: 3 }, { input: 'photos/b.jpg', usable: true, usableViews: 1, faceReview: 0 }, { input: 'videos/c.mp4', usable: true, usableViews: 4 }] } }));
    });
    try {
      const prepare = workerPrepare({ workerUrl: 'http://worker', workerAuth: { issue } as never });
      const outcome = await prepare({ jobId: jobId, captureDirectory: '/data/set', outputDirectory: '/data/out', fileIds: new Map([['photos/a.jpg', 'file-a'], ['photos/b.jpg', 'file-b'], ['videos/c.mp4', 'file-c']]) });
      expect(outcome).toMatchObject({ ok: true, inputs: [
        { fileId: 'file-a', usable: true, usableViews: 1, faceReview: 3 }, { fileId: 'file-b', usable: true, usableViews: 1 }, { fileId: 'file-c', usable: true, usableViews: 4 }] });
      expect((outcome as { inputs: Array<Record<string, unknown>> }).inputs[1]).not.toHaveProperty('faceReview');
      expect(issue).toHaveBeenCalledWith(jobId, 'spatial.reconstruct', {
        purpose: 'process', captureDirectory: '/data/set', outputDirectory: '/data/out', input: { mode: 'source_set', maskFaces: { photos: true, video: true } },
      });
    } finally { fetchMock.mockRestore(); }
  });

  describe('stopping a prepare run on the worker', () => {
    const health = () => new Response(JSON.stringify({ status: 'ready', workerInstanceId: 'w1' }));

    test('asks the worker to cancel the job with a cancel-only token and waits for its quiescent receipt', async () => {
      const issue = vi.fn(async () => 'token');
      const requests: Array<{ url: string; body?: Record<string, unknown> }> = [];
      const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
        requests.push({ url: String(url), body: init?.body ? JSON.parse(String(init.body)) : undefined });
        if (String(url).endsWith('/health')) return health();
        return new Response(JSON.stringify({ jobId, quiescent: true, cleanupProtocol: 1, workerInstanceId: 'w1' }));
      });
      try {
        await workerCancelPrepare({ workerUrl: 'http://worker', workerAuth: { issue } as never })(jobId);
        expect(requests.at(-1)).toEqual({ url: 'http://worker/v1/jobs/cancel', body: { jobId, type: 'spatial.reconstruct', workerInstanceId: 'w1' } });
        expect(issue).toHaveBeenCalledWith(jobId, 'spatial.reconstruct', { purpose: 'cancel' });
      } finally { fetchMock.mockRestore(); }
    });

    test('throws unless the worker confirms the right job is quiescent', async () => {
      for (const receipt of [{ jobId: 'other', quiescent: true, cleanupProtocol: 1, workerInstanceId: 'w1' }, { jobId, quiescent: false, cleanupProtocol: 1, workerInstanceId: 'w1' },
        { jobId, quiescent: true, cleanupProtocol: 2, workerInstanceId: 'w1' }, { jobId, quiescent: true, cleanupProtocol: 1, workerInstanceId: 'w2' }]) {
        const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async url => (String(url).endsWith('/health') ? health() : new Response(JSON.stringify(receipt))));
        try {
          await expect(workerCancelPrepare({ workerUrl: 'http://worker', workerAuth: { issue: async () => 'token' } as never })(jobId)).rejects.toMatchObject({ code: 'worker_quiescence_unverified' });
        } finally { fetchMock.mockRestore(); }
      }
      const failing = vi.spyOn(globalThis, 'fetch').mockImplementation(async url => (String(url).endsWith('/health') ? health() : new Response('{}', { status: 503 })));
      try {
        await expect(workerCancelPrepare({ workerUrl: 'http://worker', workerAuth: { issue: async () => 'token' } as never })(jobId)).rejects.toMatchObject({ code: 'worker_quiescence_unverified' });
      } finally { failing.mockRestore(); }
    });

    test('throws when the worker cannot be reached', async () => {
      const fetchMock = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('connect ECONNREFUSED'));
      try {
        await expect(workerCancelPrepare({ workerUrl: 'http://worker', workerAuth: { issue: async () => 'token' } as never })(jobId)).rejects.toThrow('ECONNREFUSED');
      } finally { fetchMock.mockRestore(); }
    });
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
