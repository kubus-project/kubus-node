import type { KuboClient } from './kuboClient.js';
import { isValidCidLike, normalizeCid } from '../utils/cid.js';

/**
 * Typed retrieval outcome. A thrown gateway fetch (DNS failure, TLS failure,
 * connection refused, socket reset, ...) is a transport fact, not evidence
 * that the content is globally absent — `gateway_unreachable` and
 * `gateway_timeout` are distinct from `gateway_not_found` (the gateway
 * answered and said 404) and `gateway_http_error` (the gateway answered with
 * some other failure status) precisely so a caller can never collapse "the
 * network is broken" into "content missing".
 */
export type RetrievalState =
  | 'pinned'
  | 'local_retrievable'
  | 'gateway_retrievable'
  | 'gateway_timeout'
  | 'gateway_unreachable'
  | 'gateway_http_error'
  | 'gateway_not_found'
  | 'invalid_cid';

/** States that mean "confirmed available from somewhere". */
export const RETRIEVAL_AVAILABLE_STATES: readonly RetrievalState[] = ['pinned', 'local_retrievable', 'gateway_retrievable'];

export interface RetrievalProbe {
  cid: string;
  state: RetrievalState;
  checkedAt: string;
  /** HTTP status code, only present for `gateway_http_error` / `gateway_not_found`. */
  httpStatus?: number;
  /**
   * A safe, non-secret classification of the failure — never the raw error
   * message, which for `fetch` can embed the request URL (and therefore any
   * query-string credentials a misconfigured gateway URL might carry).
   */
  errorClass?: string;
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
    return { cid, state: 'local_retrievable', checkedAt: new Date().toISOString() };
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
    if (response.ok || response.status === 206) return { cid, state: 'gateway_retrievable', checkedAt: new Date().toISOString() };
    if (response.status === 404) return { cid, state: 'gateway_not_found', checkedAt: new Date().toISOString(), httpStatus: 404 };
    return { cid, state: 'gateway_http_error', checkedAt: new Date().toISOString(), httpStatus: response.status };
  } catch (error) {
    return { cid, ...classifyGatewayFetchError(error), checkedAt: new Date().toISOString() };
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Classifies a thrown gateway `fetch` into `gateway_timeout` (the probe's own
 * abort) vs `gateway_unreachable` (DNS/TLS/connection-level failure) —
 * everything Node's `fetch` throws for a genuine transport failure surfaces
 * as `TypeError: fetch failed` with the real reason nested in `error.cause`,
 * which is what actually distinguishes an abort from, say, DNS resolution
 * failing.
 */
function classifyGatewayFetchError(error: unknown): { state: RetrievalState; errorClass?: string } {
  const err = error as { name?: string; message?: string; cause?: { code?: string; message?: string } };
  if (err?.name === 'AbortError') return { state: 'gateway_timeout', errorClass: 'abort' };
  const causeCode = err?.cause?.code;
  if (causeCode) return { state: 'gateway_unreachable', errorClass: causeCode };
  const message = String(err?.message || error || '');
  if (message.toLowerCase().includes('abort')) return { state: 'gateway_timeout', errorClass: 'abort' };
  return { state: 'gateway_unreachable', errorClass: 'unknown' };
}
