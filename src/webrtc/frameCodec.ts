import { Buffer } from 'node:buffer';

/**
 * Wire framing for Node operations carried over a WebRTC DataChannel.
 *
 * This is the node's half of a format the Flutter client already implements
 * (`lib/services/node/webrtc_frame.dart`). The two must agree byte for byte,
 * so the layout is restated here in full rather than described loosely — a
 * comment that drifts from the other side is worse than no comment.
 *
 * Layout, big-endian:
 *
 * ```
 *   0       1       2       3       4              8
 *   +-------+-------+-------+-------+--------------+
 *   | magic | ver   | type  | flags | requestId    |
 *   +-------+-------+-------+-------+--------------+
 *   | metadataLength (u32) | payloadLength (u32)   |
 *   +----------------------+-----------------------+
 *   | metadata (UTF-8 JSON, metadataLength bytes)  |
 *   +----------------------------------------------+
 *   | payload (payloadLength bytes)                |
 *   +----------------------------------------------+
 * ```
 *
 * Metadata is JSON because it is small, self-describing and versionable;
 * payload stays raw bytes because base64-ing a capture would inflate it by a
 * third for no benefit.
 */

/** Identifies our frames, so a foreign or corrupt message is rejected rather than parsed into nonsense. */
export const FRAME_MAGIC = 0x6b; // 'k'
export const FRAME_PROTOCOL_VERSION = 1;
export const FRAME_HEADER_LENGTH = 16;

/**
 * Maximum payload bytes in one frame.
 *
 * DataChannel implementations vary in what they accept, and large messages are
 * the classic way to stall a peer or exhaust its memory. 64 KiB is inside
 * every implementation's comfortable range and bounds the cost of a single
 * hostile frame.
 */
export const MAX_PAYLOAD_LENGTH = 64 * 1024;
export const MAX_METADATA_LENGTH = 16 * 1024;

/** Marks the last frame of a body, so a receiver knows a stream ended rather than stalled. */
export const FLAG_FINAL = 0x01;

export enum FrameType {
  RequestHead = 1,
  RequestChunk = 2,
  ResponseHead = 3,
  ResponseChunk = 4,
  Cancel = 5,
  WindowUpdate = 6,
  Error = 7,
}

const FRAME_TYPES = new Set<number>([1, 2, 3, 4, 5, 6, 7]);

export interface KubusFrame {
  type: FrameType;
  /** Correlates chunks and responses with one operation, so a channel can carry several at once. */
  requestId: number;
  flags: number;
  metadata?: Record<string, unknown>;
  payload?: Buffer;
}

export class FrameError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FrameError';
  }
}

/** The peer speaks a different framing version — actionable (update one side), not corruption. */
export class FrameVersionError extends FrameError {
  constructor(readonly peerVersion: number) {
    super('unsupported frame version');
    this.name = 'FrameVersionError';
  }
}

export function encodeFrame(frame: KubusFrame): Buffer {
  const metadataBytes = frame.metadata === undefined
    ? Buffer.alloc(0)
    : Buffer.from(JSON.stringify(frame.metadata), 'utf8');
  const payload = frame.payload ?? Buffer.alloc(0);

  if (metadataBytes.length > MAX_METADATA_LENGTH) {
    throw new FrameError(`metadata exceeds ${MAX_METADATA_LENGTH} bytes`);
  }
  if (payload.length > MAX_PAYLOAD_LENGTH) {
    throw new FrameError(`payload exceeds ${MAX_PAYLOAD_LENGTH} bytes`);
  }

  const buffer = Buffer.allocUnsafe(FRAME_HEADER_LENGTH + metadataBytes.length + payload.length);
  buffer.writeUInt8(FRAME_MAGIC, 0);
  buffer.writeUInt8(FRAME_PROTOCOL_VERSION, 1);
  buffer.writeUInt8(frame.type, 2);
  buffer.writeUInt8(frame.flags & 0xff, 3);
  buffer.writeUInt32BE(frame.requestId >>> 0, 4);
  buffer.writeUInt32BE(metadataBytes.length, 8);
  buffer.writeUInt32BE(payload.length, 12);
  metadataBytes.copy(buffer, FRAME_HEADER_LENGTH);
  payload.copy(buffer, FRAME_HEADER_LENGTH + metadataBytes.length);
  return buffer;
}

export function decodeFrame(bytes: Buffer): KubusFrame {
  if (bytes.length < FRAME_HEADER_LENGTH) throw new FrameError('frame shorter than header');
  if (bytes.readUInt8(0) !== FRAME_MAGIC) throw new FrameError('not a kubus frame');

  const version = bytes.readUInt8(1);
  if (version !== FRAME_PROTOCOL_VERSION) throw new FrameVersionError(version);

  const rawType = bytes.readUInt8(2);
  if (!FRAME_TYPES.has(rawType)) throw new FrameError(`unknown frame type ${rawType}`);

  const flags = bytes.readUInt8(3);
  const requestId = bytes.readUInt32BE(4);
  const metadataLength = bytes.readUInt32BE(8);
  const payloadLength = bytes.readUInt32BE(12);

  if (metadataLength > MAX_METADATA_LENGTH || payloadLength > MAX_PAYLOAD_LENGTH) {
    throw new FrameError('declared length exceeds limit');
  }
  // A length header that disagrees with the bytes actually present is the
  // cheapest possible denial of service: trust the buffer, never the claim.
  if (bytes.length !== FRAME_HEADER_LENGTH + metadataLength + payloadLength) {
    throw new FrameError('declared length does not match frame size');
  }

  const metadata = metadataLength === 0
    ? undefined
    : decodeMetadata(bytes.subarray(FRAME_HEADER_LENGTH, FRAME_HEADER_LENGTH + metadataLength));
  const payload = payloadLength === 0
    ? undefined
    : bytes.subarray(FRAME_HEADER_LENGTH + metadataLength);

  return { type: rawType as FrameType, requestId, flags, metadata, payload };
}

function decodeMetadata(bytes: Buffer): Record<string, unknown> {
  let decoded: unknown;
  try {
    decoded = JSON.parse(bytes.toString('utf8'));
  } catch {
    throw new FrameError('metadata is not valid JSON');
  }
  if (typeof decoded !== 'object' || decoded === null || Array.isArray(decoded)) {
    throw new FrameError('metadata is not an object');
  }
  return decoded as Record<string, unknown>;
}

export const isFinalFrame = (frame: KubusFrame): boolean => (frame.flags & FLAG_FINAL) !== 0;

/**
 * CRC-32 (IEEE), computed incrementally.
 *
 * DTLS already guarantees the bytes on the wire are intact, so this is not
 * about transmission corruption. It catches *reassembly* mistakes — a dropped,
 * duplicated, or misordered chunk — which are our own bugs, and exactly the
 * class of fault that would otherwise surface much later as an unreadable
 * capture.
 */
export class Crc32 {
  private static table: Uint32Array | undefined;
  private crc = 0xffffffff;

  private static buildTable(): Uint32Array {
    const table = new Uint32Array(256);
    for (let i = 0; i < 256; i += 1) {
      let c = i;
      for (let k = 0; k < 8; k += 1) {
        c = (c & 1) !== 0 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      }
      table[i] = c >>> 0;
    }
    return table;
  }

  add(bytes: Buffer): void {
    Crc32.table ??= Crc32.buildTable();
    const table = Crc32.table;
    let crc = this.crc;
    for (const byte of bytes) {
      crc = (table[(crc ^ byte) & 0xff]! ^ (crc >>> 8)) >>> 0;
    }
    this.crc = crc >>> 0;
  }

  get value(): number {
    return (this.crc ^ 0xffffffff) >>> 0;
  }
}

/**
 * Splits a byte stream into bounded frames.
 *
 * Never materialises the whole source: a hundreds-of-megabytes result becomes
 * thousands of 64 KiB frames while memory stays flat, which is the entire
 * reason the streaming path exists. The final frame carries the total length
 * and CRC so the receiver can prove it reassembled exactly what was sent,
 * rather than merely stopping when the stream went quiet.
 */
export async function* splitIntoFrames(
  requestId: number,
  source: AsyncIterable<Buffer>,
  type: FrameType = FrameType.ResponseChunk,
  chunkSize: number = MAX_PAYLOAD_LENGTH,
): AsyncGenerator<KubusFrame> {
  const crc = new Crc32();
  let total = 0;
  let pending: Buffer = Buffer.alloc(0);

  for await (const bytes of source) {
    pending = pending.length === 0 ? Buffer.from(bytes) : Buffer.concat([pending, bytes]);
    while (pending.length >= chunkSize) {
      const chunk = pending.subarray(0, chunkSize);
      crc.add(chunk);
      total += chunk.length;
      yield { type, requestId, flags: 0, payload: chunk };
      pending = pending.subarray(chunkSize);
    }
  }

  crc.add(pending);
  total += pending.length;
  yield {
    type,
    requestId,
    flags: FLAG_FINAL,
    metadata: { length: total, crc32: crc.value },
    payload: pending.length === 0 ? undefined : pending,
  };
}

/** A reassembled stream ended in a way the receiver rejects. */
export class StreamIntegrityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StreamIntegrityError';
  }
}

/**
 * Accumulates inbound body chunks with a hard ceiling.
 *
 * The ceiling is the point: a peer that keeps sending chunks and never sets
 * the final flag is otherwise an unbounded memory allocation on the node,
 * reachable by anyone who can open a data channel.
 */
export class ChunkReassembler {
  private readonly chunks: Buffer[] = [];
  private readonly crc = new Crc32();
  private received = 0;

  constructor(private readonly maxBytes: number) {}

  append(payload: Buffer | undefined): void {
    if (!payload || payload.length === 0) return;
    this.received += payload.length;
    if (this.received > this.maxBytes) {
      throw new StreamIntegrityError('request body exceeded the permitted size');
    }
    this.crc.add(payload);
    this.chunks.push(payload);
  }

  /**
   * Applies the integrity metadata a well-behaved peer sends on its final
   * frame. Absent metadata is tolerated so a minimal client stays valid, but
   * metadata that is present and wrong is always fatal.
   */
  verify(metadata: Record<string, unknown> | undefined): void {
    if (!metadata) return;
    const declaredLength = metadata.length;
    if (typeof declaredLength === 'number' && declaredLength !== this.received) {
      throw new StreamIntegrityError(
        `body length mismatch: expected ${declaredLength}, received ${this.received}`,
      );
    }
    const declaredCrc = metadata.crc32;
    if (typeof declaredCrc === 'number' && declaredCrc !== this.crc.value) {
      throw new StreamIntegrityError('body checksum mismatch');
    }
  }

  get byteLength(): number {
    return this.received;
  }

  take(): Buffer {
    return Buffer.concat(this.chunks, this.received);
  }
}
