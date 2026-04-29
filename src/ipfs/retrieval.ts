import type { KuboClient } from './kuboClient.js';
import { isValidCidLike, normalizeCid } from '../utils/cid.js';

export type RetrievalState = 'pinned' | 'retrievable' | 'missing' | 'timeout' | 'invalid_cid';

export interface RetrievalProbe {
  cid: string;
  state: RetrievalState;
  checkedAt: string;
  error?: string;
}

export async function probeRetrieval(kubo: KuboClient, gatewayUrl: string, rawCid: string): Promise<RetrievalProbe> {
  if (!isValidCidLike(rawCid)) return { cid: rawCid, state: 'invalid_cid', checkedAt: new Date().toISOString() };
  const cid = normalizeCid(rawCid);
  try {
    await kubo.pinLs(cid);
    return { cid, state: 'pinned', checkedAt: new Date().toISOString() };
  } catch {
    // Continue to content probes.
  }
  try {
    await kubo.blockStat(cid);
    return { cid, state: 'retrievable', checkedAt: new Date().toISOString() };
  } catch {
    // Continue to gateway probe.
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5000);
  try {
    const base = gatewayUrl.replace(/\/+$/, '');
    const response = await fetch(`${base}/ipfs/${encodeURIComponent(cid)}`, {
      method: 'GET',
      headers: { Range: 'bytes=0-0' },
      signal: controller.signal,
    });
    if (response.ok || response.status === 206) return { cid, state: 'retrievable', checkedAt: new Date().toISOString() };
    return { cid, state: 'missing', checkedAt: new Date().toISOString(), error: `gateway_http_${response.status}` };
  } catch (error) {
    const message = String((error as Error).message || error);
    return { cid, state: message.toLowerCase().includes('abort') ? 'timeout' : 'missing', checkedAt: new Date().toISOString(), error: message };
  } finally {
    clearTimeout(timeout);
  }
}
