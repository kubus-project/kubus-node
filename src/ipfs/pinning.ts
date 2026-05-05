import type { KuboClient } from './kuboClient.js';
import type { PublicPinSetRecord } from '../backend/models.js';
import { normalizeCid } from '../utils/cid.js';

export interface PinResult {
  cid: string;
  ok: boolean;
  error?: string;
}

export async function reconcilePins(kubo: KuboClient, cids: PublicPinSetRecord[], skipPinning = false): Promise<PinResult[]> {
  const results: PinResult[] = [];
  for (const item of cids) {
    const cid = normalizeCid(item.cid);
    if (skipPinning) {
      results.push({ cid, ok: true });
      continue;
    }
    try {
      await kubo.pinAdd(cid);
      results.push({ cid, ok: true });
    } catch (error) {
      results.push({ cid, ok: false, error: String((error as Error).message || error) });
    }
  }
  return results;
}
