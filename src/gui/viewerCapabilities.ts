import { randomBytes } from 'node:crypto';

/**
 * Short-lived, read-only grants that let the Spatial viewer fetch one
 * representation of one scene without ever holding the Node GUI credential.
 *
 * The viewer runs Spark, which fetches by plain URL and cannot attach an
 * Authorization header to the chunk requests it makes on its own. The previous
 * answer - download the whole variant through an authenticated `fetch`, wrap it
 * in a Blob and hand Spark an object URL - buffered an entire archive before a
 * single splat could draw. A capability turns the content URL itself into the
 * credential, narrowly:
 *
 * - bound to one Spatial id and one variant; it cannot name any other object;
 * - read-only: it is only ever consulted by GET/HEAD content routes;
 * - high entropy (256 bits) so it cannot be guessed;
 * - expiry enforced here, server-side, on every use - idle and absolute;
 * - held in memory only, so a restart revokes every outstanding grant.
 *
 * The token appears only in the content URL path. Request logging never
 * records URLs, and `redactSecrets` also scrubs the path shape defensively.
 */

export interface ViewerGrant {
  spatialId: string;
  role: string;
  /** The single file's CID, or the bundle root's. */
  contentCid: string;
  /** Set for a bundle: the entry file inside `contentCid`. */
  entrypoint?: string;
  /** The name the entry is served under (the bundle entrypoint, or a synthetic one for a single file). */
  entryName: string;
  mimeType: string;
  /** Exact size of the single file, when this is not a bundle. */
  sizeBytes: number;
  format: string;
  bundle: boolean;
}

interface StoredGrant extends ViewerGrant {
  createdAt: number;
  lastUsedAt: number;
  requests: number;
  bytesSent: number;
  /** Per-file stat answers, so a chunk's size is asked of Kubo once. */
  fileStats: Map<string, { hash: string; sizeBytes: number } | null>;
}

export interface ViewerCapabilityOptions {
  /** A grant that goes unused this long is dead. */
  idleTtlMs?: number;
  /** No grant outlives this, however busy it is. */
  maxLifetimeMs?: number;
  /** Hard cap on live grants; the least recently used is evicted first. */
  maxActive?: number;
  now?: () => number;
}

export const DEFAULT_IDLE_TTL_MS = 10 * 60 * 1000;
export const DEFAULT_MAX_LIFETIME_MS = 2 * 60 * 60 * 1000;
export const DEFAULT_MAX_ACTIVE = 64;

const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

export interface IssuedCapability {
  token: string;
  /** The earlier of idle and absolute expiry, as of issue. */
  expiresAt: number;
  idleTtlMs: number;
}

export interface CapabilityDeliveryStats {
  spatialId: string;
  role: string;
  bundle: boolean;
  requests: number;
  bytesSent: number;
  createdAt: string;
}

export class ViewerCapabilities {
  private readonly grants = new Map<string, StoredGrant>();
  private readonly idleTtlMs: number;
  private readonly maxLifetimeMs: number;
  private readonly maxActive: number;
  private readonly now: () => number;

  constructor(options: ViewerCapabilityOptions = {}) {
    this.idleTtlMs = options.idleTtlMs ?? DEFAULT_IDLE_TTL_MS;
    this.maxLifetimeMs = options.maxLifetimeMs ?? DEFAULT_MAX_LIFETIME_MS;
    this.maxActive = options.maxActive ?? DEFAULT_MAX_ACTIVE;
    this.now = options.now ?? Date.now;
  }

  issue(grant: ViewerGrant): IssuedCapability {
    this.sweep();
    while (this.grants.size >= this.maxActive) this.evictLeastRecentlyUsed();
    const token = randomBytes(32).toString('base64url');
    const now = this.now();
    this.grants.set(token, { ...grant, createdAt: now, lastUsedAt: now, requests: 0, bytesSent: 0, fileStats: new Map() });
    return { token, expiresAt: now + Math.min(this.idleTtlMs, this.maxLifetimeMs), idleTtlMs: this.idleTtlMs };
  }

  /**
   * Returns the grant for a token and counts the use, or undefined when the
   * token is malformed, unknown or expired. An expired grant is deleted on
   * sight rather than waiting for a sweep.
   */
  resolve(token: string): StoredGrant | undefined {
    if (!TOKEN_PATTERN.test(token)) return undefined;
    const grant = this.grants.get(token);
    if (!grant) return undefined;
    const now = this.now();
    if (now - grant.lastUsedAt > this.idleTtlMs || now - grant.createdAt > this.maxLifetimeMs) {
      this.grants.delete(token);
      return undefined;
    }
    grant.lastUsedAt = now;
    grant.requests += 1;
    return grant;
  }

  revoke(token: string): boolean {
    return this.grants.delete(token);
  }

  /** Revokes every grant for a scene, e.g. when its record is replaced. */
  revokeSpatial(spatialId: string): number {
    let revoked = 0;
    for (const [token, grant] of this.grants) {
      if (grant.spatialId === spatialId) {
        this.grants.delete(token);
        revoked += 1;
      }
    }
    return revoked;
  }

  size(): number {
    this.sweep();
    return this.grants.size;
  }

  /** Delivery counters per live grant. Never includes a token. */
  stats(spatialId?: string): CapabilityDeliveryStats[] {
    this.sweep();
    return [...this.grants.values()]
      .filter((grant) => !spatialId || grant.spatialId === spatialId)
      .map((grant) => ({
        spatialId: grant.spatialId,
        role: grant.role,
        bundle: grant.bundle,
        requests: grant.requests,
        bytesSent: grant.bytesSent,
        createdAt: new Date(grant.createdAt).toISOString(),
      }));
  }

  private sweep(): void {
    const now = this.now();
    for (const [token, grant] of this.grants) {
      if (now - grant.lastUsedAt > this.idleTtlMs || now - grant.createdAt > this.maxLifetimeMs) this.grants.delete(token);
    }
  }

  private evictLeastRecentlyUsed(): void {
    let oldest: [string, number] | undefined;
    for (const [token, grant] of this.grants) {
      if (!oldest || grant.lastUsedAt < oldest[1]) oldest = [token, grant.lastUsedAt];
    }
    if (oldest) this.grants.delete(oldest[0]);
  }
}
