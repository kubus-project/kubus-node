import 'dotenv/config';
import { KubusApiClient } from '../src/backend/kubusApiClient.js';
import { BearerAuthProvider } from '../src/backend/operatorAuth.js';
import { parseEnv, resolveNodeKey } from '../src/config/env.js';
import { waitForKubo } from '../src/ipfs/health.js';
import { KuboClient } from '../src/ipfs/kuboClient.js';
import { reconcileDesiredPins, refreshCommitments, syncRewardableCids } from '../src/operator/commitments.js';
import { sendHeartbeat } from '../src/operator/heartbeat.js';
import { ensureRegistered } from '../src/operator/registerNode.js';
import { refreshRewards } from '../src/operator/rewards.js';
import { refreshStatus } from '../src/operator/status.js';
import { LocalStore } from '../src/state/localStore.js';
import { normalizeCid } from '../src/utils/cid.js';

const results: { step: string; ok: boolean; detail?: string }[] = [];

async function step(name: string, fn: () => Promise<unknown>) {
  try {
    const value = await fn();
    results.push({ step: name, ok: true });
    return value;
  } catch (error) {
    results.push({ step: name, ok: false, detail: String((error as Error).message || error) });
    throw error;
  }
}

async function main() {
  const config = parseEnv();
  const store = new LocalStore(config.localStatePath);
  await store.load();
  const api = new KubusApiClient({ baseUrl: config.apiBaseUrl, auth: new BearerAuthProvider(config.operatorToken) });
  const kubo = new KuboClient(config.ipfsRpcUrl);

  await step('backend health', () => api.getHealth());
  const kuboHealth = await step('kubo health', () => waitForKubo(kubo));
  await step('node key', () => resolveNodeKey(config, store));
  const peerId = (kuboHealth as Awaited<ReturnType<typeof waitForKubo>>).peerId || '';
  const node = await step('register node', () => ensureRegistered(api, store, config, peerId, kuboHealth as Awaited<ReturnType<typeof waitForKubo>>));
  await step('fetch policies', async () => {
    const policy = await api.getPolicies();
    await store.update((state) => {
      state.policy = policy;
    });
  });
  const desired = await step('fetch rewardable cids', () => syncRewardableCids(api, store, config));
  if ((desired as unknown[]).length === 0) {
    console.log('no rewardable CIDs available');
    if (config.isProduction || !config.devAllowEmptyCids) throw new Error('No canonical rewardable CIDs available');
    if (config.devSeedCid) {
      const cid = normalizeCid(config.devSeedCid);
      await store.update((state) => {
        state.desiredCids = [{ id: 'dev-seed', cid, verificationClass: 'hot', rewardRole: 'dev' }];
      });
    }
  }
  if (store.snapshot().desiredCids.length > 0 && store.snapshot().desiredCids[0]?.id !== 'dev-seed') {
    await step('pin cids', () => reconcileDesiredPins(kubo, store, config));
    await step('create commitments', () => refreshCommitments(api, kubo, store, config));
  } else if (store.snapshot().desiredCids[0]?.id === 'dev-seed') {
    await step('dev seed pin only', () => reconcileDesiredPins(kubo, store, config));
  }
  await step('send heartbeat', () => sendHeartbeat(api, kubo, store, config));
  await step('fetch current commitments', () => (node as { id: string }).id ? api.getCurrentCommitments((node as { id: string }).id) : Promise.resolve());
  await step('fetch node status/current epoch', () => refreshStatus(api, kubo, store));
  await step('fetch rewards', () => refreshRewards(api, store));

  const failed = results.filter((result) => !result.ok);
  console.log(JSON.stringify({ ok: failed.length === 0, results }, null, 2));
  process.exitCode = failed.length === 0 ? 0 : 1;
}

main().catch((error) => {
  console.error(String((error as Error).message || error));
  console.log(JSON.stringify({ ok: false, results }, null, 2));
  process.exitCode = 1;
});
