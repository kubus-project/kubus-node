import type { KuboClient } from './kuboClient.js';
import { sleep } from '../utils/time.js';

export interface KuboHealth {
  reachable: boolean;
  peerId?: string;
  version?: string;
  repo?: unknown;
  error?: string;
}

export async function getKuboHealth(kubo: KuboClient): Promise<KuboHealth> {
  try {
    const [id, version, repo] = await Promise.all([kubo.id(), kubo.version(), kubo.repoStat().catch((error) => ({ error: String(error?.message || error) }))]);
    return { reachable: true, peerId: id.ID, version: version.Version, repo };
  } catch (error) {
    return { reachable: false, error: String((error as Error).message || error) };
  }
}

export async function waitForKubo(kubo: KuboClient, timeoutMs = 120000): Promise<KuboHealth> {
  const started = Date.now();
  let last: KuboHealth = { reachable: false };
  while (Date.now() - started < timeoutMs) {
    last = await getKuboHealth(kubo);
    if (last.reachable) return last;
    await sleep(2500);
  }
  throw new Error(`Kubo not reachable: ${last.error || 'timeout'}`);
}
