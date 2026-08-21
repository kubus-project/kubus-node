import crypto from 'node:crypto';
import type { LocalResponse } from './localRequest.js';
import { localError } from './pairingService.js';

/**
 * Deduplicates a mutation the client may have retried on a different rung.
 *
 * The client can no longer tell a lost response from a request that never
 * arrived — that is the entire reason a transport ladder is dangerous without
 * this. It retries, and without server-side deduplication the second attempt
 * commits a second capture or queues a second reconstruction. The client
 * therefore sends a stable key derived from something durable (the capture,
 * the draft), and this remembers what that key already produced.
 *
 * Three properties matter, and each is a decision rather than an accident:
 *
 * 1. **Only successful outcomes are replayed.** A failed attempt releases its
 *    key, so a user retrying after a genuine failure starts real work instead
 *    of being handed back the failure forever. This is what makes keying job
 *    creation on the capture id safe: re-running a failed reconstruction is a
 *    new attempt, while a double-tap on Process is not.
 *
 * 2. **A key in flight is rejected, not queued.** Two concurrent requests with
 *    the same key are the duplicate this exists to stop; making the second one
 *    wait would turn a network hiccup into a held connection and, if the first
 *    is slow, into a timeout that triggers another retry.
 *
 * 3. **The stored response is bounded and expires.** Nothing here is a durable
 *    record; it is a short memory of recent effects. Replaying a week-old
 *    commit would be a different kind of wrong.
 *
 * The key is namespaced by the credential that presented it, so one paired
 * device cannot probe for, collide with, or replay another device's results.
 */

/** How long a completed result stays replayable. */
const DEFAULT_RETENTION_MS = 24 * 60 * 60 * 1000;

/** Ceiling on remembered keys, so a hostile client cannot grow this without bound. */
const DEFAULT_MAX_ENTRIES = 2048;

/**
 * Largest response body kept for replay. A streamed or large binary response
 * is never stored: replaying it would mean holding it in memory, and every
 * operation that needs deduplication returns a small JSON record anyway.
 */
const MAX_REPLAYABLE_BYTES = 64 * 1024;

/** Bounds the key itself before it is ever used as a map key. */
const MAX_KEY_LENGTH = 128;
const MIN_KEY_LENGTH = 8;
const KEY_PATTERN = /^[A-Za-z0-9\-._~:]+$/;

interface CompletedEntry {
  state: 'completed';
  status: number;
  value: unknown;
  storedAt: number;
  /** Binds a key to one operation, so the same key cannot replay a different route's result. */
  operation: string;
}

interface InFlightEntry {
  state: 'in-flight';
  storedAt: number;
  operation: string;
}

type Entry = CompletedEntry | InFlightEntry;

export interface IdempotencyOutcome {
  /** A previously stored successful result, to return instead of acting again. */
  replay?: { status: number; value: unknown };
  /** Called with the outcome once the operation runs. */
  settle: (response: LocalResponse | undefined, failed: boolean) => void;
}

/**
 * Normalises a client-supplied key, rejecting anything unusable.
 *
 * A blank or malformed key is treated as *absent* rather than as a weak key.
 * That is the safe direction: an unkeyed mutation is never retried across
 * transports, whereas accepting a blank key would let every retry collide on
 * the same empty string and deduplicate unrelated operations against each
 * other.
 */
export function normalizeIdempotencyKey(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined;
  const value = raw.trim();
  if (value !== raw) return undefined;
  if (value.length < MIN_KEY_LENGTH || value.length > MAX_KEY_LENGTH) return undefined;
  if (!KEY_PATTERN.test(value)) return undefined;
  return value;
}

export class IdempotencyStore {
  private readonly entries = new Map<string, Entry>();

  constructor(
    private readonly retentionMs = DEFAULT_RETENTION_MS,
    private readonly maxEntries = DEFAULT_MAX_ENTRIES,
    private readonly now: () => number = () => Date.now(),
  ) {}

  /**
   * Claims a key for one operation.
   *
   * Returns a replay when the same key already completed successfully, and
   * always returns a `settle` the caller must invoke — on both the success and
   * the failure path — so a crashed handler cannot leave a key claimed forever
   * (the in-flight entry also expires on its own as a backstop).
   */
  begin(params: {
    key: string | undefined;
    credential: string | undefined;
    operation: string;
  }): IdempotencyOutcome {
    const key = normalizeIdempotencyKey(params.key);
    if (!key) return { settle: () => undefined };

    this.evictExpired();
    const mapKey = this.scopedKey(key, params.credential);
    const existing = this.entries.get(mapKey);

    if (existing) {
      if (existing.operation !== params.operation) {
        // The same key presented for a different route is either a client bug
        // or an attempt to read back another operation's result. Refuse rather
        // than answering with something the caller did not ask for.
        throw localError(409, 'idempotency_key_reused_for_different_operation');
      }
      if (existing.state === 'in-flight') {
        throw localError(409, 'idempotency_key_in_flight');
      }
      return {
        replay: { status: existing.status, value: existing.value },
        settle: () => undefined,
      };
    }

    this.entries.set(mapKey, {
      state: 'in-flight',
      storedAt: this.now(),
      operation: params.operation,
    });
    this.enforceCapacity();

    return {
      settle: (response, failed) => {
        if (failed || !response) {
          // Release the key so a deliberate retry after a real failure can do
          // real work instead of replaying the failure.
          this.entries.delete(mapKey);
          return;
        }
        if (response.kind !== 'json') {
          // Only small JSON outcomes are replayable; anything else is released
          // rather than half-remembered.
          this.entries.delete(mapKey);
          return;
        }
        const encoded = Buffer.byteLength(JSON.stringify(response.value ?? null), 'utf8');
        if (encoded > MAX_REPLAYABLE_BYTES) {
          this.entries.delete(mapKey);
          return;
        }
        this.entries.set(mapKey, {
          state: 'completed',
          status: response.status,
          value: response.value,
          storedAt: this.now(),
          operation: params.operation,
        });
      },
    };
  }

  /** Visible for tests and diagnostics; never exposed on an API surface. */
  size(): number {
    this.evictExpired();
    return this.entries.size;
  }

  /**
   * Namespaced by a hash of the credential, never the credential itself: this
   * map is inspectable in a heap dump and a token does not belong in it.
   */
  private scopedKey(key: string, credential: string | undefined): string {
    const subject = credential
      ? crypto.createHash('sha256').update(credential).digest('hex').slice(0, 32)
      : 'anonymous';
    return `${subject}:${key}`;
  }

  private evictExpired(): void {
    const cutoff = this.now() - this.retentionMs;
    for (const [key, entry] of this.entries) {
      if (entry.storedAt <= cutoff) this.entries.delete(key);
    }
  }

  private enforceCapacity(): void {
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next().value as string | undefined;
      if (!oldest) return;
      this.entries.delete(oldest);
    }
  }
}
