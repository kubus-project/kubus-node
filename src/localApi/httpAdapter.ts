import { Buffer } from 'node:buffer';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { AppConfig } from '../config/schema.js';
import { dispatchLocalRequest, type LocalApiDeps } from './dispatch.js';
import type { LocalPeer, LocalRequest, LocalRequestBody, LocalResponse } from './localRequest.js';
import { localError } from './pairingService.js';

export type { LocalApiDeps } from './dispatch.js';

/**
 * Serves the canonical Node API over the local HTTP listener.
 *
 * This file owns everything that is true of HTTP and of nothing else — the
 * Origin check, peer-address gating, security headers, the response envelope —
 * and nothing about what an operation means. The WebRTC adapter is the same
 * shape against the same dispatcher, which is what keeps the two from drifting
 * into different answers about who may do what.
 */
export async function handleLocalApi(
  req: IncomingMessage,
  res: ServerResponse,
  deps: LocalApiDeps,
): Promise<boolean> {
  const parsed = new URL(req.url || '/', `http://${req.headers.host || '127.0.0.1'}`);
  if (!parsed.pathname.startsWith('/local/v1/')) return false;
  securityHeaders(res);

  // A browser reaching this listener is either a confused user or a page
  // trying to use their Node from someone else's origin. Neither is a client
  // of this API, and both are refused before anything else is considered.
  if (req.headers.origin) throw localError(403, 'browser_origin_not_allowed');

  const peer = classifyPeer(deps.config, req.socket.remoteAddress);
  if (!peer) throw localError(403, 'lan_api_disabled');

  const request: LocalRequest = {
    method: req.method || 'GET',
    path: parsed.pathname,
    query: parsed.searchParams,
    credential: bearer(req),
    idempotencyKey: header(req, 'idempotency-key'),
    contentType: header(req, 'content-type'),
    body: httpBody(req),
    peer,
  };

  const response = await dispatchLocalRequest(request, deps);
  await writeResponse(res, response);
  return true;
}

/**
 * Decides what kind of caller this socket is.
 *
 * Returns null when the peer is not permitted to reach the API at all, which
 * is a different answer from "permitted but unverified" — the dispatcher needs
 * both distinctions and previously had access to neither.
 */
function classifyPeer(config: AppConfig, address?: string): LocalPeer | null {
  const normalized = normalizePeerAddress(address);
  if (normalized === '127.0.0.1' || normalized === '::1') {
    // Loopback is the operator's own machine. It is the only case where the
    // transport itself is evidence of who is calling.
    return { kind: 'loopback', address: normalized, identityHandshakeComplete: true };
  }
  if (config.localApiAllowLan) {
    return { kind: 'lan', address: normalized, identityHandshakeComplete: true };
  }
  const trusted = config.localApiRemoteUrl
    && config.localApiTrustedProxyAddresses?.some(
      (candidate) => normalizePeerAddress(candidate) === normalized,
    );
  if (trusted) return { kind: 'trusted-proxy', address: normalized, identityHandshakeComplete: true };
  return null;
}

/**
 * Preserved for the existing callers and tests that ask the question directly.
 */
export function isAllowedLocalApiPeer(config: AppConfig, address?: string): boolean {
  return classifyPeer(config, address) !== null;
}

function normalizePeerAddress(address?: string): string {
  const normalized = (address || '').trim().toLowerCase().replace(/^\[/, '').replace(/\]$/, '').split('%', 1)[0] || '';
  return normalized.startsWith('::ffff:') && /^\d+\.\d+\.\d+\.\d+$/.test(normalized.slice(7))
    ? normalized.slice(7)
    : normalized;
}

function bearer(req: IncomingMessage): string | undefined {
  const value = req.headers.authorization || '';
  return value.startsWith('Bearer ') ? value.slice(7).trim() : undefined;
}

function header(req: IncomingMessage, name: string): string | undefined {
  const value = req.headers[name];
  return typeof value === 'string' ? value : undefined;
}

function securityHeaders(res: ServerResponse): void {
  res.setHeader('Access-Control-Allow-Origin', 'null');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Cache-Control', 'no-store');
}

/**
 * Pull-based body access over an `IncomingMessage`.
 *
 * Each accessor consumes the socket, so a second call is a programming error
 * rather than an empty read — throwing makes that visible at the call site
 * instead of producing a mysteriously blank request.
 */
function httpBody(req: IncomingMessage): LocalRequestBody {
  let consumed = false;
  const claim = () => {
    if (consumed) throw localError(500, 'request_body_already_read');
    consumed = true;
  };

  const readAll = async (maxBytes: number): Promise<Buffer> => {
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of req) {
      const bytes = Buffer.from(chunk);
      size += bytes.length;
      if (size > maxBytes) throw localError(413, 'request_too_large');
      chunks.push(bytes);
    }
    return Buffer.concat(chunks);
  };

  return {
    async json(maxBytes = 1024 * 1024) {
      claim();
      const buffer = await readAll(maxBytes);
      try {
        return JSON.parse(buffer.toString('utf8') || '{}') as Record<string, unknown>;
      } catch {
        throw localError(400, 'json_invalid');
      }
    },
    async binary(maxBytes: number) {
      claim();
      const buffer = await readAll(maxBytes);
      if (buffer.length === 0) throw localError(400, 'capture_file_empty');
      return buffer;
    },
    stream() {
      claim();
      return req as AsyncIterable<Buffer>;
    },
  };
}

async function writeResponse(res: ServerResponse, response: LocalResponse): Promise<void> {
  if (response.kind === 'json') {
    res.writeHead(response.status, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(`${JSON.stringify({ success: true, data: response.value })}\n`);
    return;
  }
  if (response.kind === 'bytes') {
    res.writeHead(response.status, {
      'Content-Type': response.contentType,
      'Content-Length': String(response.body.byteLength),
      ...(response.cacheControl ? { 'Cache-Control': response.cacheControl } : {}),
      ...(response.contentSha256 ? { 'X-Kubus-Content-SHA256': response.contentSha256 } : {}),
      'X-Content-Type-Options': 'nosniff',
    });
    res.end(response.body);
    return;
  }
  res.writeHead(response.status, {
    'Content-Type': response.contentType,
    ...(response.contentLength !== undefined ? { 'Content-Length': String(response.contentLength) } : {}),
    ...(response.cacheControl ? { 'Cache-Control': response.cacheControl } : {}),
    ...(response.contentSha256 ? { 'X-Kubus-Content-SHA256': response.contentSha256 } : {}),
    'X-Content-Type-Options': 'nosniff',
  });
  for await (const chunk of response.body) {
    if (!res.write(chunk)) {
      // Respect the socket's backpressure rather than buffering the rest of a
      // large result in memory on the node's side.
      await new Promise<void>((resolve) => res.once('drain', resolve));
    }
  }
  res.end();
}
