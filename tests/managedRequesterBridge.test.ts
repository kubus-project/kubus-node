import crypto from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { KubusApiError } from '../src/backend/kubusApiClient.js';
import type { ManagedReconstruction, RemoteComputeJob } from '../src/backend/models.js';
import { ManagedRequesterBridge, workerPrepare, type PrepareOutcome } from '../src/compute/managedRequesterBridge.js';
import { PRIVATE_OUTPUT_PROTOCOL } from '../src/compute/privateOutputTransport.js';

const nodeId = '44444444-4444-4444-8444-444444444444';
const reconstructionId = '9b6f6f0e-2d3c-4b8a-9a52-6c1f3e0d7a11';
const providerA = '66666666-6666-4666-8666-666666666666';
const providerB = '77777777-7777-4777-8777-777777777777';
const photo = Buffer.from('a photo of the artwork, eleven bytes over a chunk');
const clip = Buffer.alloc(40, 9);
const result = Buffer.alloc(50, 3);
const sha = (bytes: Buffer) => crypto.createHash('sha256').update(bytes).digest('hex');
const logger = { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() } as never;

let dataRoot: string;
let sources: Map<string, Buffer>;
let calls: Array<{ action: string; body: Record<string, unknown> }>;
let jobState: string;
let providers: Array<{ nodeId: string; encryptionPublicKey: string; privateOutputProtocol: string | null }>;
let uploaded: Buffer[];
let prepareOutcome: PrepareOutcome | null;

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
  return {
    id: '88888888-8888-4888-8888-888888888888', providerNodeId: provider, type: 'spatial.reconstruct', protocolVersion: 'kubus.compute/1',
    jobSpecVersion: 'kubus.spatial-job/1', requirements: {}, inputCid: 'bafyinput', inputBytes: 10, inputHash: 'a'.repeat(64),
    inputKeyEnvelope: {}, canonicalJobSpec: { processing: { outputMode: PRIVATE_OUTPUT_PROTOCOL } }, jobSpecHash: 'b'.repeat(64), state,
    createdAt: '', expiresAt: '', outputManifestCid: 'bafymanifest', outputCids: ['bafymanifest', 'bafyarchive'],
    providerReceipt: { payload: { privateOutput: { blobs: [{ role: 'manifest' }, { role: 'spatial_archive' }] } } },
  };
}

function makeBridge(prepare?: PrepareOutcome) {
  prepareOutcome = prepare ?? null;
  const api = {
    claimReconstruction: vi.fn(async () => null as ManagedReconstruction | null),
    reconstructionRetention: vi.fn(async () => ({ purge: [] as string[] })),
    readReconstructionChunk: vi.fn(async (_id: string, fileId: string, offset: number) => sources.get(fileId)!.subarray(offset, offset + 16)),
    getReconstructionComputeJob: vi.fn(async () => job()),
    appendReconstructionCandidate: vi.fn(async (_id: string, offset: number, bytes: Buffer) => {
      uploaded.push(Buffer.from(bytes));
      return { reconstruction: attempt({ state: 'importing' }), candidate: { state: offset + bytes.length === result.length ? 'ready' : 'uploading' } };
    }),
    reconstructionCall: vi.fn(async (_id: string, action: string, body: Record<string, unknown>) => {
      calls.push({ action, body });
      if (action === 'progress') return attempt({ state: body.state as ManagedReconstruction['state'] });
      if (action === 'providers') return providers;
      if (action === 'compute-job') return { computeJobId: job().id };
      if (action === 'compute-job/acknowledge') return job(body.accepted ? 'COMPLETED' : 'DISPUTED');
      if (action === 'compute-job/cancel') return job('CANCELLED');
      if (action === 'candidate') return { reconstruction: attempt({ state: 'importing' }), candidate: { receivedBytes: 0, state: 'uploading' } };
      return {};
    }),
  };
  const captures = { registerRemote: vi.fn(async (record: unknown) => record), removeRemote: vi.fn(async () => undefined) };
  const transport = { encryptCapture: vi.fn(async () => ({ inputCid: 'bafyinput', inputBytes: 10, inputHash: 'a'.repeat(64), inputKeyEnvelope: {}, jobSpec: { fileCount: 3 } })) };
  const staged = path.join(dataRoot, 'private', 'remote-results', job().id);
  const remote = {
    stagePrivateOutput: vi.fn(async () => {
      await fs.mkdir(staged, { recursive: true });
      await fs.writeFile(path.join(staged, 'spatial_archive'), result);
      return { directory: staged, record: {} };
    }),
    signedAcknowledgement: vi.fn(async (_job: RemoteComputeJob, accepted: boolean) => ({ payload: { accepted }, signature: 'sig' })),
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

beforeEach(async () => {
  dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'kubus-managed-requester-'));
  sources = new Map([['11111111-1111-4111-8111-111111111111', photo], ['22222222-2222-4222-8222-222222222222', clip]]);
  calls = [];
  jobState = 'OUTPUT_READY';
  providers = [{ nodeId: providerA, encryptionPublicKey: 'key', privateOutputProtocol: PRIVATE_OUTPUT_PROTOCOL }];
  uploaded = [];
});

afterEach(async () => { await fs.rm(dataRoot, { recursive: true, force: true }); });

const root = () => path.join(dataRoot, 'private', 'reconstructions', reconstructionId);

describe('managed requester bridge', () => {
  test('verified sources become a masked dataset that only leaves the Node encrypted to a private-output provider', async () => {
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

  test('too few registered views report per-file feedback instead of matching a provider', async () => {
    const { bridge, transport } = makeBridge({ ok: false, code: 'sfm_failed', details: { submittedViews: 40, registeredViews: 11 },
      inputs: [{ fileId: '22222222-2222-4222-8222-222222222222', usable: false, usableViews: 0, reason: 'frames_too_blurry' }] });
    await bridge.advance(nodeId, attempt());
    const failure = calls.find(call => call.action === 'failure')!;
    expect(failure.body).toMatchObject({ code: 'sfm_failed', feedback: { submittedViews: 40, usableViews: 11,
      inputs: [{ fileId: '22222222-2222-4222-8222-222222222222', usable: false, usableViews: 0, reason: 'frames_too_blurry' }] } });
    expect(transport.encryptCapture).not.toHaveBeenCalled();
  });

  test('no eligible provider shows Waiting for a node, and a provider without the private-output protocol is never used', async () => {
    providers = [{ nodeId: providerA, encryptionPublicKey: 'key', privateOutputProtocol: null }];
    const { bridge, transport, api, prepareFn } = makeBridge();
    await bridge.advance(nodeId, attempt());
    expect(calls.filter(call => call.action === 'progress').at(-1)!.body).toMatchObject({ state: 'waiting_for_node' });
    expect(transport.encryptCapture).not.toHaveBeenCalled();
    // A later pass resumes from the prepared capture without downloading or preparing again.
    providers = [{ nodeId: providerB, encryptionPublicKey: 'key-b', privateOutputProtocol: PRIVATE_OUTPUT_PROTOCOL }];
    const reads = api.readReconstructionChunk.mock.calls.length;
    await bridge.advance(nodeId, attempt({ state: 'waiting_for_node' }));
    expect(transport.encryptCapture).toHaveBeenCalledWith(`managed-${reconstructionId}`, providerB, 'key-b');
    expect(api.readReconstructionChunk.mock.calls.length).toBe(reads);
    expect(prepareFn).toHaveBeenCalledTimes(1);
  });

  test('a verified result is acknowledged and uploaded as the candidate, then work files go but sources stay', async () => {
    const { bridge, remote, captures } = makeBridge();
    await bridge.advance(nodeId, attempt());
    await bridge.advance(nodeId, attempt({ state: 'processing', computeJobId: job().id }));
    expect(remote.signedAcknowledgement).toHaveBeenCalledWith(expect.objectContaining({ state: 'OUTPUT_READY' }), true, undefined);
    const candidate = calls.find(call => call.action === 'candidate')!;
    expect(candidate.body).toMatchObject({ format: 'ply', sizeBytes: result.length, sha256: sha(result) });
    expect(Buffer.concat(uploaded)).toEqual(result);
    expect(uploaded).toHaveLength(4);
    expect(remote.releaseInput).toHaveBeenCalled();
    expect(captures.removeRemote).toHaveBeenCalledWith(`managed-${reconstructionId}`);
    expect(await fs.readdir(root())).toEqual(['set']);
    expect(calls.at(-1)).toMatchObject({ action: 'cleanup', body: { state: 'complete' } });
  });

  test('a result that fails verification is disputed and the next provider is tried', async () => {
    const { bridge, remote } = makeBridge();
    await bridge.advance(nodeId, attempt());
    remote.stagePrivateOutput.mockRejectedValueOnce(Object.assign(new Error('bad'), { code: 'private_output_signature_invalid' }));
    await bridge.advance(nodeId, attempt({ state: 'processing', computeJobId: job().id }));
    expect(remote.signedAcknowledgement).toHaveBeenCalledWith(expect.anything(), false, 'output_verification_failed');
    expect(calls.find(call => call.action === 'candidate')).toBeUndefined();
    expect(calls.at(-1)!.body).toMatchObject({ state: 'waiting_for_node', stage: 'provider_lost' });
    providers = [{ nodeId: providerB, encryptionPublicKey: 'key-b', privateOutputProtocol: PRIVATE_OUTPUT_PROTOCOL }];
    await bridge.advance(nodeId, attempt({ state: 'waiting_for_node' }));
    expect(calls.filter(call => call.action === 'providers').at(-1)!.body).toMatchObject({ excludeNodeIds: [providerA] });
  });

  test('a provider lost three times ends the attempt as failed', async () => {
    const { bridge, api } = makeBridge();
    await bridge.advance(nodeId, attempt());
    for (const provider of [providerA, providerB, '99999999-9999-4999-8999-999999999999']) {
      api.getReconstructionComputeJob.mockResolvedValueOnce(job('FAILED', provider));
      await bridge.advance(nodeId, attempt({ state: 'processing', computeJobId: job().id }));
    }
    expect(calls.at(-1)).toMatchObject({ action: 'failure', body: { code: 'no_provider_completed' } });
  });

  test('a cancel request cancels the provider job, releases the input and confirms', async () => {
    const { bridge, remote } = makeBridge();
    await bridge.advance(nodeId, attempt());
    await bridge.advance(nodeId, attempt({ state: 'processing', computeJobId: job().id, cancelRequested: true }));
    expect(calls.map(call => call.action).slice(-2)).toEqual(['compute-job/cancel', 'cancelled']);
    expect(remote.releaseInput).toHaveBeenCalledWith(expect.objectContaining({ state: 'CANCELLED' }));
    expect(await fs.readdir(root())).toEqual(['set']);
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
