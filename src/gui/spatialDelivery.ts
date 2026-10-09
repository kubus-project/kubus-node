import type { IncomingMessage, ServerResponse } from 'node:http';
import { Readable } from 'node:stream';
import type { KuboClient } from '../ipfs/kuboClient.js';
import { localError } from '../localApi/pairingService.js';
import { isBundleFileName, isBundleVariant, variantContentCid, type SpatialVariant } from '../spatial/models.js';
import type { LocalStore } from '../state/localStore.js';
import { parseByteRange } from '../utils/byteRange.js';
import { isValidCidLike } from '../utils/cid.js';
import { getSpatialRecord } from './spatialGuiApi.js';
import type { ViewerCapabilities } from './viewerCapabilities.js';

/**
 * Progressive delivery of Spatial content to the in-browser viewer.
 *
 * Two surfaces, one rule: the viewer never receives the Node GUI credential.
 *
 * - `issueViewerTickets` runs behind the ordinary authenticated GUI API and
 *   mints one capability per representation the viewer should load.
 * - `serveViewerContent` is the unauthenticated-by-header content route the
 *   capability unlocks. It serves GET/HEAD only, with byte ranges, and can
 *   reach nothing but the one variant its capability was minted for.
 */

/** Which role the viewer opens when it is not told: never the archive. */
const AUTO_ROLES = ['spatial_preview', 'spatial_mobile'] as const;

export interface ViewerRepresentation {
  role: string;
  format: string;
  bundle: boolean;
  sizeBytes: number;
  /** Same-origin path the viewer loads directly. Contains the capability. */
  url: string;
  expiresAt: string;
  idleTtlMs: number;
}

export interface ViewerTicketResult {
  spatialId: string;
  /** Preview first, then the runtime representation, as the viewer should load them. */
  representations: ViewerRepresentation[];
  /** True when the scene has nothing but the original reconstruction. */
  archiveOnly: boolean;
  /** Present when the original reconstruction exists, so the UI can offer it explicitly. */
  archive?: { sizeBytes: number; format: string };
}

function entryNameFor(variant: SpatialVariant): string {
  if (isBundleVariant(variant)) return variant.entrypoint as string;
  const extension = /^[a-z0-9]{1,8}$/.test(variant.format) ? variant.format : 'bin';
  return `${variant.role.replace(/^spatial_/, '')}.${extension}`;
}

export function issueViewerTickets(
  deps: { store: LocalStore; capabilities: ViewerCapabilities },
  spatialId: string,
  options: { role?: string } = {},
): ViewerTicketResult {
  const record = getSpatialRecord(deps.store, spatialId);
  const variants = record.manifest.variants;
  const archive = variants.find((variant) => variant.role === 'spatial_archive');
  const archiveSummary = archive ? { sizeBytes: archive.sizeBytes, format: archive.format } : undefined;

  let chosen: SpatialVariant[];
  if (options.role) {
    // An explicit role is the only way the original reconstruction is ever
    // opened: the caller named it, so the heavy transfer is a decision.
    const match = variants.find((variant) => variant.role === options.role);
    if (!match) throw localError(404, 'spatial_variant_not_found');
    chosen = [match];
  } else {
    chosen = AUTO_ROLES.map((role) => variants.find((variant) => variant.role === role)).filter((variant): variant is SpatialVariant => Boolean(variant));
  }

  const representations = chosen.map((variant): ViewerRepresentation => {
    if (!isValidCidLike(variantContentCid(variant))) throw localError(500, 'spatial_variant_cid_invalid');
    const entryName = entryNameFor(variant);
    const issued = deps.capabilities.issue({
      spatialId,
      role: variant.role,
      contentCid: variantContentCid(variant),
      entrypoint: variant.entrypoint,
      entryName,
      mimeType: variant.mimeType,
      sizeBytes: variant.sizeBytes,
      format: variant.format,
      bundle: isBundleVariant(variant),
    });
    return {
      role: variant.role,
      format: variant.format,
      bundle: isBundleVariant(variant),
      sizeBytes: variant.sizeBytes,
      url: `/gui/content/${issued.token}/${entryName}`,
      expiresAt: new Date(issued.expiresAt).toISOString(),
      idleTtlMs: issued.idleTtlMs,
    };
  });

  return { spatialId, representations, archiveOnly: representations.length === 0 && !options.role && Boolean(archive), archive: archiveSummary };
}

const CONTENT_PATH = /^\/gui\/content\/([A-Za-z0-9_-]{43})\/([^/]+)$/;

/** True when `pathname` addresses the capability content route. */
export function isViewerContentPath(pathname: string): boolean {
  return pathname.startsWith('/gui/content/');
}

function notFound(res: ServerResponse): void {
  // Identical for "no such grant", "expired grant" and "no such file": the
  // route must not confirm which part of a guess was right.
  res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify({ success: false, error: 'Not found' }));
}

export async function serveViewerContent(
  req: IncomingMessage,
  res: ServerResponse,
  deps: { kubo: KuboClient; capabilities: ViewerCapabilities },
  pathname: string,
): Promise<void> {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, { Allow: 'GET, HEAD', 'Cache-Control': 'no-store' });
    res.end();
    return;
  }
  const match = CONTENT_PATH.exec(pathname);
  if (!match) return notFound(res);
  const grant = deps.capabilities.resolve(match[1]!);
  let name: string;
  try {
    name = decodeURIComponent(match[2]!);
  } catch {
    return notFound(res);
  }
  if (!grant || !isBundleFileName(name)) return notFound(res);

  let cid: string;
  let total: number;
  let etagSource: string;
  let inner: string | undefined;
  let mimeType = grant.mimeType;
  if (!grant.bundle) {
    if (name !== grant.entryName) return notFound(res);
    cid = grant.contentCid;
    total = grant.sizeBytes;
    etagSource = grant.contentCid;
  } else {
    let stat = grant.fileStats.get(name);
    if (stat === undefined) {
      const found = await deps.kubo.fileStat(grant.contentCid, name).catch(() => undefined);
      if (found === undefined) {
        res.writeHead(502, { 'Cache-Control': 'no-store' });
        res.end();
        return;
      }
      stat = found && found.type === 'file' ? { hash: found.hash, sizeBytes: found.sizeBytes } : null;
      // Bounded: a bundle names at most a few thousand files, and misses are
      // remembered too so a probing viewer cannot make Kubo do the same lookup twice.
      if (grant.fileStats.size < 25_000) grant.fileStats.set(name, stat);
    }
    if (!stat) return notFound(res);
    cid = grant.contentCid;
    inner = name;
    total = stat.sizeBytes;
    etagSource = stat.hash;
    if (name !== grant.entryName) mimeType = 'application/octet-stream';
  }

  const etag = `"${etagSource}"`;
  const ifNoneMatch = req.headers['if-none-match'];
  const range = (() => {
    try {
      return parseByteRange(typeof req.headers.range === 'string' ? req.headers.range : undefined, total);
    } catch {
      return 'invalid' as const;
    }
  })();
  // The bytes behind a CID never change, so a validator answer is always
  // correct. The capability, not the bytes, is what expires, which is why the
  // freshness lifetime stays short and private.
  const headers: Record<string, string> = {
    'Content-Type': mimeType,
    'Accept-Ranges': 'bytes',
    ETag: etag,
    'Cache-Control': 'private, max-age=300, immutable',
    'X-Content-Type-Options': 'nosniff',
    'Cross-Origin-Resource-Policy': 'same-origin',
  };
  if (range === 'invalid') {
    res.writeHead(416, { 'Content-Range': `bytes */${total}`, 'Cache-Control': 'no-store' });
    res.end();
    return;
  }
  if (range === 'unsatisfiable') {
    res.writeHead(416, { 'Content-Range': `bytes */${total}`, 'Cache-Control': 'no-store' });
    res.end();
    return;
  }
  if (typeof ifNoneMatch === 'string' && ifNoneMatch.split(',').some((candidate) => candidate.trim() === etag || candidate.trim() === `W/${etag}`)) {
    res.writeHead(304, { ETag: etag, 'Cache-Control': headers['Cache-Control']! });
    res.end();
    return;
  }

  const length = total === 0 ? 0 : range.end - range.start + 1;
  headers['Content-Length'] = String(length);
  if (range.partial) headers['Content-Range'] = `bytes ${range.start}-${range.end}/${total}`;
  const status = range.partial ? 206 : 200;
  if (req.method === 'HEAD' || length === 0) {
    res.writeHead(status, headers);
    res.end();
    return;
  }
  // Opened before the status line is committed: a Kubo failure is then a clean
  // 502 instead of a 200 whose body silently stops.
  let upstream: Awaited<ReturnType<KuboClient['catStream']>>;
  try {
    upstream = await deps.kubo.catStream(cid, range.partial ? { offset: range.start, length } : undefined, inner);
  } catch {
    res.writeHead(502, { 'Cache-Control': 'no-store' });
    res.end();
    return;
  }
  res.writeHead(status, headers);
  res.on('close', upstream.cancel);
  const readable = Readable.fromWeb(upstream.body as import('node:stream/web').ReadableStream);
  readable.on('data', (chunk: Buffer) => { grant.bytesSent += chunk.length; });
  readable.on('error', () => res.destroy());
  readable.pipe(res);
}
