import { describe, expect, it } from 'vitest';
import { Buffer } from 'node:buffer';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Crc32, FrameType, decodeFrame, encodeFrame, isFinalFrame } from '../src/webrtc/frameCodec.js';

/**
 * Cross-language conformance for the DataChannel wire format.
 *
 * The client is Dart and the node is TypeScript, so "both sides implement the
 * spec" means two independent implementations of a byte layout that must agree
 * exactly. Nothing in either codebase would notice them diverging: a mismatched
 * field width or endianness produces a frame that decodes to plausible
 * nonsense, and the first symptom is a corrupted capture.
 *
 * The SAME fixture is checked into both repositories
 * (`art.kubus/test/services/node/fixtures/kubus_frame_vectors.json`) and each
 * side asserts it can decode the bytes and re-encode them identically. A change
 * to either implementation that breaks the other fails in CI rather than in
 * the field.
 *
 * Regenerating the fixture is deliberate: it means the wire format changed,
 * which is a protocol version bump, not a test fix.
 */

const fixturePath = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  'fixtures',
  'kubusFrameVectors.json',
);

interface Fixture {
  frames: Array<{ name: string; encoded: string }>;
  crc32: Array<{ inputHex: string; crc32: number }>;
}

const fixture = JSON.parse(readFileSync(fixturePath, 'utf8')) as Fixture;
const byName = (name: string) => {
  const found = fixture.frames.find((frame) => frame.name === name);
  if (!found) throw new Error(`fixture missing frame "${name}"`);
  return Buffer.from(found.encoded, 'hex');
};

describe('frame wire-format conformance', () => {
  it('decodes and re-encodes every vector to identical bytes', () => {
    expect(fixture.frames.length).toBeGreaterThan(0);
    for (const vector of fixture.frames) {
      const expected = Buffer.from(vector.encoded, 'hex');
      const reencoded = encodeFrame(decodeFrame(expected));
      expect(reencoded.toString('hex'), `round-trip differs for "${vector.name}"`).toBe(
        expected.toString('hex'),
      );
    }
  });

  it('parses header fields into the positions the layout declares', () => {
    // Decoding could pass while requestId and metadata length were swapped in
    // both directions, so assert the parsed fields, not just the round trip.
    const frame = decodeFrame(byName('request head with inline json body'));
    expect(frame.type).toBe(FrameType.RequestHead);
    expect(frame.requestId).toBe(2);
    expect(isFinalFrame(frame)).toBe(true);
    expect(frame.metadata?.method).toBe('POST');
    expect(frame.metadata?.path).toBe('/local/v1/jobs');
    expect(frame.metadata?.idempotencyKey).toBe('job.create.c1');
    expect(frame.payload).toBeUndefined();
  });

  it('preserves payload bytes at both ends of the range', () => {
    const frame = decodeFrame(byName('request chunk, not final'));
    expect(Array.from(frame.payload ?? [])).toEqual([0, 1, 2, 253, 254, 255]);
    expect(isFinalFrame(frame)).toBe(false);
  });

  it('accepts a payload at exactly the declared maximum', () => {
    // The boundary is where an off-by-one between implementations hides: one
    // side rejecting what the other considers legal is a transfer that stalls
    // only on large files.
    const frame = decodeFrame(byName('max size payload'));
    expect(frame.payload).toHaveLength(64 * 1024);
    expect(frame.payload?.every((byte) => byte === 0xab)).toBe(true);
  });

  it('refuses a frame whose declared length disagrees with the bytes present', () => {
    const valid = byName('request chunk, not final');
    const truncated = valid.subarray(0, valid.length - 1);
    expect(() => decodeFrame(truncated)).toThrow(/declared length/);

    const padded = Buffer.concat([valid, Buffer.from([0x00])]);
    expect(() => decodeFrame(padded)).toThrow(/declared length/);
  });

  it('refuses a frame that is not ours', () => {
    const foreign = Buffer.from(byName('cancel frame'));
    foreign.writeUInt8(0x00, 0);
    expect(() => decodeFrame(foreign)).toThrow(/not a kubus frame/);
  });

  it('reports a version mismatch as something an operator can act on', () => {
    const future = Buffer.from(byName('cancel frame'));
    future.writeUInt8(99, 1);
    expect(() => decodeFrame(future)).toThrow(/unsupported frame version/);
  });

  it('refuses an unknown frame type rather than guessing', () => {
    const unknown = Buffer.from(byName('cancel frame'));
    unknown.writeUInt8(200, 2);
    expect(() => decodeFrame(unknown)).toThrow(/unknown frame type/);
  });
});

describe('CRC-32 conformance', () => {
  it('matches the checked-in vectors', () => {
    expect(fixture.crc32.length).toBeGreaterThan(0);
    for (const entry of fixture.crc32) {
      const crc = new Crc32();
      crc.add(Buffer.from(entry.inputHex, 'hex'));
      expect(crc.value, `CRC differs for ${entry.inputHex}`).toBe(entry.crc32);
    }
  });

  it('matches the known IEEE CRC-32 of a standard string', () => {
    // An independent anchor: if both our implementations drifted together, the
    // fixture would agree with itself and prove nothing.
    const crc = new Crc32();
    crc.add(Buffer.from('The quick brown fox jumps over the lazy dog', 'utf8'));
    expect(crc.value).toBe(0x414fa339);
  });

  it('is incremental in the same way as a single pass', () => {
    // The splitter feeds the CRC one chunk at a time while the receiver feeds
    // it whatever arrives, so a difference between "all at once" and "in
    // pieces" would only surface on multi-frame bodies.
    const data = Buffer.from(Array.from({ length: 5000 }, (_, i) => (i * 31) % 256));
    const whole = new Crc32();
    whole.add(data);
    const pieces = new Crc32();
    for (let offset = 0; offset < data.length; offset += 97) {
      pieces.add(data.subarray(offset, Math.min(offset + 97, data.length)));
    }
    expect(pieces.value).toBe(whole.value);
  });
});
