import type { KuboClient } from './kuboClient.js';
import type { PublicPinSetRecord } from '../backend/models.js';
import { normalizeCid } from '../utils/cid.js';

export interface PinResult {
  cid: string;
  ok: boolean;
  error?: string;
}

async function fetchCidBytes(url: string): Promise<Uint8Array> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);
  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) {
      throw new Error(`CID fetch failed with HTTP ${response.status}`);
    }
    return new Uint8Array(await response.arrayBuffer());
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchPublicCid(apiBaseUrl: string | undefined, cid: string): Promise<Uint8Array> {
  const encoded = encodeURIComponent(cid);
  const urls = [
    `https://ipfs.io/ipfs/${encoded}`,
    `https://dweb.link/ipfs/${encoded}`,
    apiBaseUrl ? `${apiBaseUrl.replace(/\/+$/, '')}/api/upload/${encoded}` : null,
  ].filter((url): url is string => Boolean(url));
  const errors: string[] = [];
  for (const url of urls) {
    try {
      return await fetchCidBytes(url);
    } catch (error) {
      errors.push(`${url}: ${String((error as Error).message || error)}`);
    }
  }
  throw new Error(`Unable to fetch CID bytes over HTTP: ${errors.join('; ')}`);
}

async function pinWithBackendFallback(
  kubo: KuboClient,
  item: PublicPinSetRecord,
  apiBaseUrl?: string,
): Promise<void> {
  const cid = normalizeCid(item.cid);
  if (apiBaseUrl) {
    try {
      const bytes = await fetchPublicCid(apiBaseUrl, cid);
      const added = await kubo.addBytes(bytes, `${cid}.bin`);
      if (added.Hash && normalizeCid(added.Hash) !== cid) {
        throw new Error(`HTTP CID bytes hashed to ${added.Hash}, expected ${cid}`);
      }
      return;
    } catch {
      // Fall through to native Kubo resolution. The caller records the final error if it fails too.
    }
  }
  try {
    await kubo.pinAdd(cid);
    return;
  } catch (pinError) {
    if (!apiBaseUrl) throw pinError;
    throw pinError;
  }
}

export async function reconcilePins(kubo: KuboClient, cids: PublicPinSetRecord[], skipPinning = false, apiBaseUrl?: string): Promise<PinResult[]> {
  const results: PinResult[] = [];
  for (const item of cids) {
    const cid = normalizeCid(item.cid);
    if (skipPinning) {
      results.push({ cid, ok: true });
      continue;
    }
    try {
      await pinWithBackendFallback(kubo, item, apiBaseUrl);
      results.push({ cid, ok: true });
    } catch (error) {
      results.push({ cid, ok: false, error: String((error as Error).message || error) });
    }
  }
  return results;
}
