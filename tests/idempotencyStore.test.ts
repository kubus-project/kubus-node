import { describe, expect, it } from 'vitest';
import { IdempotencyStore, normalizeIdempotencyKey } from '../src/localApi/idempotencyStore.js';
import { jsonResponse } from '../src/localApi/localRequest.js';

/**
 * Deduplication is what makes a transport ladder safe to fail over on. Without
 * it, a client that cannot distinguish "the response was lost" from "the
 * request never arrived" retries, and the node commits a second capture.
 */
describe('idempotency key normalisation', () => {
  it('treats a blank or malformed key as absent rather than as a weak key', () => {
    // Absent is the safe reading: an unkeyed mutation is never retried across
    // transports. Accepting a blank key would make every retry collide on the
    // same empty string and deduplicate unrelated operations against one another.
    for (const value of ['', ' ', '\t', 'short', ' untrimmed', 'untrimmed ', 'has space', 'semi;colon', 'a'.repeat(129)]) {
      expect(normalizeIdempotencyKey(value), JSON.stringify(value)).toBeUndefined();
    }
    for (const value of [undefined, null, 42, {}, []]) {
      expect(normalizeIdempotencyKey(value)).toBeUndefined();
    }
  });

  it('accepts the shape the client actually sends', () => {
    expect(normalizeIdempotencyKey('capture.commit.draft-d1')).toBe('capture.commit.draft-d1');
    expect(normalizeIdempotencyKey('job.create.c-123~a:b')).toBe('job.create.c-123~a:b');
    expect(normalizeIdempotencyKey('a'.repeat(128))).toHaveLength(128);
  });
});

describe('IdempotencyStore', () => {
  const commit = jsonResponse(201, { id: 'capture-1' });

  it('does nothing at all when no key is supplied', () => {
    const store = new IdempotencyStore();
    const first = store.begin({ key: undefined, credential: 'c', operation: 'POST /x' });
    expect(first.replay).toBeUndefined();
    first.settle(commit, false);
    // An unkeyed mutation leaves no trace, so a second one runs for real.
    const second = store.begin({ key: undefined, credential: 'c', operation: 'POST /x' });
    expect(second.replay).toBeUndefined();
    expect(store.size()).toBe(0);
  });

  it('replays a completed result instead of acting twice', () => {
    const store = new IdempotencyStore();
    const first = store.begin({ key: 'capture.commit.d1', credential: 'cred', operation: 'POST /commit' });
    expect(first.replay).toBeUndefined();
    first.settle(commit, false);

    const retry = store.begin({ key: 'capture.commit.d1', credential: 'cred', operation: 'POST /commit' });
    expect(retry.replay).toEqual({ status: 201, value: { id: 'capture-1' } });
  });

  it('releases the key when the operation failed, so a real retry does real work', () => {
    // Otherwise a user whose reconstruction genuinely failed would be handed
    // the same failure forever and could never start it again.
    const store = new IdempotencyStore();
    const first = store.begin({ key: 'job.create.c1', credential: 'cred', operation: 'POST /jobs' });
    first.settle(undefined, true);

    const retry = store.begin({ key: 'job.create.c1', credential: 'cred', operation: 'POST /jobs' });
    expect(retry.replay).toBeUndefined();
  });

  it('rejects a second request while the first is still in flight', () => {
    // Two concurrent requests with one key ARE the duplicate this exists to
    // stop. Queueing the second would turn a network hiccup into a held
    // connection and then into another retry.
    const store = new IdempotencyStore();
    store.begin({ key: 'capture.commit.d1', credential: 'cred', operation: 'POST /commit' });
    expect(() =>
      store.begin({ key: 'capture.commit.d1', credential: 'cred', operation: 'POST /commit' }),
    ).toThrowError(/idempotency_key_in_flight/);
  });

  it('refuses a key reused for a different operation', () => {
    const store = new IdempotencyStore();
    const first = store.begin({ key: 'shared.key.value', credential: 'cred', operation: 'POST /commit' });
    first.settle(commit, false);
    expect(() =>
      store.begin({ key: 'shared.key.value', credential: 'cred', operation: 'POST /jobs' }),
    ).toThrowError(/idempotency_key_reused_for_different_operation/);
  });

  it('scopes keys per credential so one device cannot read another device result', () => {
    const store = new IdempotencyStore();
    const first = store.begin({ key: 'capture.commit.d1', credential: 'phone-a', operation: 'POST /commit' });
    first.settle(commit, false);

    const otherDevice = store.begin({ key: 'capture.commit.d1', credential: 'phone-b', operation: 'POST /commit' });
    expect(otherDevice.replay).toBeUndefined();
  });

  it('never stores the credential itself', () => {
    const store = new IdempotencyStore();
    const claim = store.begin({ key: 'capture.commit.d1', credential: 'kubus_local_supersecret', operation: 'POST /commit' });
    claim.settle(commit, false);
    expect(JSON.stringify(store)).not.toContain('kubus_local_supersecret');
  });

  it('expires a remembered result rather than replaying it forever', () => {
    let now = 1_000_000;
    const store = new IdempotencyStore(1000, 64, () => now);
    const first = store.begin({ key: 'capture.commit.d1', credential: 'cred', operation: 'POST /commit' });
    first.settle(commit, false);
    expect(store.begin({ key: 'capture.commit.d1', credential: 'cred', operation: 'POST /commit' }).replay).toBeDefined();

    now += 5000;
    expect(store.begin({ key: 'capture.commit.d1', credential: 'cred', operation: 'POST /commit' }).replay).toBeUndefined();
  });

  it('releases an in-flight key that expired, so a crash cannot wedge it forever', () => {
    let now = 1_000_000;
    const store = new IdempotencyStore(1000, 64, () => now);
    store.begin({ key: 'capture.commit.d1', credential: 'cred', operation: 'POST /commit' });
    now += 5000;
    expect(() =>
      store.begin({ key: 'capture.commit.d1', credential: 'cred', operation: 'POST /commit' }),
    ).not.toThrow();
  });

  it('stays bounded under a client that mints endless keys', () => {
    const store = new IdempotencyStore(60_000, 32);
    for (let i = 0; i < 500; i += 1) {
      const claim = store.begin({ key: `flood.key.${i}`, credential: 'cred', operation: 'POST /commit' });
      claim.settle(commit, false);
    }
    expect(store.size()).toBeLessThanOrEqual(32);
  });

  it('does not remember a response too large to replay cheaply', () => {
    const store = new IdempotencyStore();
    const huge = jsonResponse(200, { blob: 'x'.repeat(200_000) });
    const claim = store.begin({ key: 'big.result.key', credential: 'cred', operation: 'POST /x' });
    claim.settle(huge, false);
    expect(store.begin({ key: 'big.result.key', credential: 'cred', operation: 'POST /x' }).replay).toBeUndefined();
  });

  it('does not remember a streamed or binary response', () => {
    const store = new IdempotencyStore();
    const claim = store.begin({ key: 'bytes.result.key', credential: 'cred', operation: 'POST /x' });
    claim.settle(
      { kind: 'bytes', status: 200, contentType: 'application/octet-stream', body: Buffer.from('abc') },
      false,
    );
    expect(store.begin({ key: 'bytes.result.key', credential: 'cred', operation: 'POST /x' }).replay).toBeUndefined();
  });
});
