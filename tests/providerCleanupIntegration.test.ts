import { afterEach, expect, it, vi } from 'vitest';
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
const id = '11111111-1111-4111-8111-111111111111';
const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0))
    await fs.rm(root, { recursive: true, force: true });
});
async function fixture(
  failure: 'download' | 'decrypt' | 'create' | 'transition' | 'none' = 'none',
) {
  const root = await fs.mkdtemp(
    path.join(os.tmpdir(), 'kubus-provider-integration-'),
  );
  roots.push(root);
  const store = new LocalStore(path.join(root, 'state.json'));
  await store.load();
  await store.update((state) => {
    state.nodeId = 'synthetic-node';
  });
  const captures = new CaptureStore(root, store);
  const warn = vi.fn();
  const job = {
    id,
    type: 'spatial.optimize',
    state: 'ACCEPTED',
    inputCid: syntheticCid('synthetic-ciphertext'),
    inputHash: 'synthetic-hash',
    inputBytes: 5,
    inputKeyEnvelope: {},
    expiresAt: new Date(Date.now() + 60000).toISOString(),
  } as RemoteComputeJob;
  const pinAdd = vi.fn(async () => {
    expect(
      (store.snapshot().remoteJobs?.[id] as RemoteRuntimeRecord).cleanup,
    ).toBeDefined();
    if (failure === 'download') throw new Error('synthetic download failure');
  });
  const pinRm = vi.fn(async () => undefined);
  const decrypt = vi.fn(
    async (_encrypted: unknown, _envelope: unknown, directory: string) => {
      await fs.mkdir(directory, { recursive: true });
      await fs.writeFile(path.join(directory, 'partial-private'), 'synthetic');
      if (failure === 'decrypt') throw new Error('synthetic decrypt failure');
      await fs.writeFile(
        path.join(directory, 'capture.json'),
        JSON.stringify({
          schema: 'kubus.capture/1',
          artworkId: 'synthetic-art',
          files: [],
        }),
      );
    },
  );
  const api = {
    getProviderComputeJobs: vi.fn(async () => ({ jobs: [job] })),
    transitionProviderComputeJob: vi.fn(
      async (_id: string, payload: { state: string }) => {
        if (failure === 'transition' && payload.state === 'RUNNING')
          throw new Error('synthetic transition failure');
        return { ...job, state: payload.state };
      },
    ),
  };
  const jobs = new JobRuntime({
    store,
    captureStore: captures,
    kubo: {} as never,
    logger: { warn } as never,
    dataRoot: root,
    concurrency: 0,
    participationGate: {
      assertUsefulOperation: async () => undefined,
    } as never,
    workerAuth: { issue: async () => 'synthetic' } as never,
  });
  if (failure === 'create')
    vi.spyOn(jobs, 'create').mockRejectedValue(
      new Error('synthetic job insert failure'),
    );
  const runtime = new RemoteComputeRuntime({
    store,
    captures,
    jobs,
    config: {
      localDataPath: root,
      offerRemoteCompute: true,
      remoteComputePaused: false,
      remoteComputeMaxConcurrency: 1,
      remoteComputeMaxQueueDepth: 1,
      remoteComputeMaxInputBytes: 1024,
      operatorToken: 'synthetic-token',
      managedPinReleaseEnabled: true,
    } as never,
    kubo: { pinAdd, pinRm, pinLs: async () => ({ Keys: {} }), cat: async () => new Uint8Array(5) } as never,
    api: api as never,
    transport: { decryptToDirectory: decrypt } as never,
    identity: {} as never,
    gate: {} as never,
    logger: { warn, info: () => undefined } as never,
  });
  // Await the real polling operation rather than racing a fire-and-forget timer.
  const poll = () =>
    (
      runtime as unknown as { pollProvider: () => Promise<number> }
    ).pollProvider();
  return {
    root,
    store,
    captures,
    jobs,
    runtime,
    poll,
    pinAdd,
    pinRm,
    decrypt,
    api,
    target: path.join(root, 'private', 'remote-jobs', id),
  };
}
it.each(['download', 'decrypt', 'create'] as const)(
  'cleans owned source and capture metadata after %s failure',
  async (failure) => {
    const { poll, store, target, pinAdd, api } = await fixture(failure);
    await poll();
    expect(pinAdd).toHaveBeenCalledTimes(1);
    await expect(fs.stat(target)).rejects.toMatchObject({ code: 'ENOENT' });
    const record = store.snapshot().remoteJobs?.[id] as RemoteRuntimeRecord;
    expect(record.cleanup).toMatchObject({
      plaintext: 'complete',
      inputPinReleasePending: false,
    });
    expect(store.snapshot().captures?.['remote-' + id]).toBeUndefined();
    expect(api.transitionProviderComputeJob).toHaveBeenCalledWith(
      id,
      expect.objectContaining({ state: 'FAILED' }),
    );
  },
);
it('a failed ownership journal prevents download and decryption', async () => {
  const { poll, store, pinAdd, decrypt } = await fixture();
  vi.spyOn(store, 'update').mockRejectedValueOnce(
    new Error('synthetic journal failure'),
  );
  await poll();
  expect(pinAdd).not.toHaveBeenCalled();
  expect(decrypt).not.toHaveBeenCalled();
});
it('backend failure after local insertion cancels the durably tracked child before deleting source', async () => {
  const { poll, store, target } = await fixture('transition');
  await poll();
  const record = store.snapshot().remoteJobs?.[id] as RemoteRuntimeRecord;
  expect(record.localJobId).toBeTruthy();
  expect(store.snapshot().jobs?.[record.localJobId!]).toMatchObject({
    state: 'cancelled',
  });
  expect(record.cleanup?.plaintext).toBe('complete');
  await expect(fs.stat(target)).rejects.toMatchObject({ code: 'ENOENT' });
});
it('successful preparation keeps readable source while the child is still active', async () => {
  const { poll, store, target, api } = await fixture();
  await poll();
  const record = store.snapshot().remoteJobs?.[id] as RemoteRuntimeRecord;
  expect(record.localJobId).toBeTruthy();
  expect(record.cleanup?.plaintext).toBe('pending');
  expect((await fs.stat(target)).isDirectory()).toBe(true);
  expect(api.transitionProviderComputeJob).toHaveBeenCalledWith(
    id,
    expect.objectContaining({ state: 'RUNNING' }),
  );
});

it('releases only the provider owner while preserving a shared archive pin', async () => {
  const { poll, runtime, store, pinRm, api } = await fixture();
  await poll();
  const provider = store.snapshot().remoteJobs![id] as RemoteRuntimeRecord;
  await store.update(state => {
    const pin = Object.values(state.managedPins!)[0]!;
    pin.owners['archive:synthetic-other-record'] = { createdAt: new Date().toISOString() };
  });
  api.getProviderComputeJobs.mockResolvedValueOnce({ jobs: [{ id, state: 'CANCELLED' } as RemoteComputeJob] });
  await poll();
  expect((store.snapshot().remoteJobs![id] as RemoteRuntimeRecord).cleanup?.inputPinReleasePending).toBe(false);
  expect(Object.values(store.snapshot().managedPins!)[0]!.owners).not.toHaveProperty(provider.cleanup!.pinOwner!);
  expect(pinRm).not.toHaveBeenCalled();
  expect(runtime.cleanupDiagnostics().plaintextPending).toBe(0);
});

it('paused providers still reconcile a cancellation for previously owned work', async () => {
  const { poll, runtime, store, target, api } = await fixture();
  await poll();
  await runtime.updateSettings({ paused: true });
  const record = store.snapshot().remoteJobs?.[id] as RemoteRuntimeRecord;
  api.getProviderComputeJobs.mockResolvedValueOnce({
    jobs: [{ id, state: 'CANCELLED' } as RemoteComputeJob],
  });
  await poll();
  expect(store.snapshot().jobs?.[record.localJobId!]).toMatchObject({
    state: 'cancelled',
  });
  await expect(fs.stat(target)).rejects.toMatchObject({ code: 'ENOENT' });
});
it('an OUTPUT_READY job resumes plaintext cleanup after interrupted output submission', async () => {
  const { poll, store, target, api } = await fixture();
  await poll();
  api.getProviderComputeJobs.mockResolvedValueOnce({
    jobs: [{ id, state: 'OUTPUT_READY' } as RemoteComputeJob],
  });
  await poll();
  expect(
    (store.snapshot().remoteJobs?.[id] as RemoteRuntimeRecord).cleanup
      ?.plaintext,
  ).toBe('complete');
  await expect(fs.stat(target)).rejects.toMatchObject({ code: 'ENOENT' });
});
it('expiry cleanup runs even when provider is paused and backend cannot be reached', async () => {
  const { poll, runtime, store, target, api } = await fixture();
  await poll();
  await runtime.updateSettings({ paused: true });
  await store.update((state) => {
    (state.remoteJobs?.[id] as RemoteRuntimeRecord).cleanup!.expiresAt =
      new Date(Date.now() - 1000).toISOString();
  });
  api.getProviderComputeJobs.mockRejectedValue(new Error('synthetic offline'));
  runtime.start();
  try {
    await vi.waitFor(() =>
      expect(
        (store.snapshot().remoteJobs?.[id] as RemoteRuntimeRecord).cleanup
          ?.plaintext,
      ).toBe('complete'),
    );
    await runtime.reconcileProviderCleanup();
    await expect(fs.stat(target)).rejects.toMatchObject({ code: 'ENOENT' });
  } finally {
    runtime.stop();
  }
});

it('authorization rejection stops backend polling but preserves the independent cleanup loop', async () => {
  const { poll, runtime, store, target, api } = await fixture();
  await poll();
  api.getProviderComputeJobs.mockRejectedValue(
    Object.assign(new Error('synthetic authorization rejection'), {
      status: 403,
      code: 'forbidden',
    }),
  );
  runtime.start();
  try {
    await vi.waitFor(() =>
      expect(store.snapshot().computeAuthorization?.state).toBe(
        'AUTHORIZATION_REQUIRED',
      ),
    );
    expect(
      (runtime as unknown as { cleanupTimer?: unknown }).cleanupTimer,
    ).toBeDefined();
    await store.update((state) => {
      (state.remoteJobs?.[id] as RemoteRuntimeRecord).cleanup!.expiresAt =
        new Date(Date.now() - 1000).toISOString();
    });
    await runtime.reconcileProviderCleanup();
    await expect(fs.stat(target)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(runtime.cleanupDiagnostics()).toMatchObject({
      plaintextPending: 0,
      plaintextBlocked: 0,
      inputPinReleasesPending: 0,
    });
  } finally {
    runtime.stop();
  }
});
it('new assignments are declined while readable source cleanup is blocked', async () => {
  const { poll, store, api } = await fixture();
  await store.update((state) => {
    (state.remoteJobs ??= {})['blocked'] = {
      role: 'provider',
      cleanup: { plaintext: 'blocked' },
    };
  });
  api.getProviderComputeJobs.mockResolvedValueOnce({
    jobs: [{ id, state: 'MATCHED' } as RemoteComputeJob],
  });
  await poll();
  expect(api.transitionProviderComputeJob).toHaveBeenCalledWith(
    id,
    expect.objectContaining({
      state: 'DECLINED',
      metadata: { code: 'provider_cleanup_pending' },
    }),
  );
});
