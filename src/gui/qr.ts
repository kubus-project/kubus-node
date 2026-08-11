/**
 * Minimal QR Code encoder (ISO/IEC 18004), byte mode, error-correction level L.
 *
 * kubus Node is infrastructure: the GUI has to render a scannable pairing code
 * with no internet access, no CDN and no npm dependency (§60). Pairing payloads
 * are short URLs (~120 characters), so byte mode with versions 1–10 is ample.
 *
 * Only what pairing needs is implemented — no kanji mode, no ECC levels beyond
 * L, no structured append.
 */

/* -------------------------------------------------------------------------- */
/* GF(256) arithmetic                                                         */
/* -------------------------------------------------------------------------- */

/** QR uses the primitive polynomial x^8 + x^4 + x^3 + x^2 + 1 (0x11d). */
const GF_EXP = new Uint8Array(512);
const GF_LOG = new Uint8Array(256);

(() => {
  let value = 1;
  for (let i = 0; i < 255; i += 1) {
    GF_EXP[i] = value;
    GF_LOG[value] = i;
    value <<= 1;
    if (value & 0x100) value ^= 0x11d;
  }
  // Duplicate the table so callers can index up to 510 without a modulo.
  for (let i = 255; i < 512; i += 1) GF_EXP[i] = GF_EXP[i - 255]!;
})();

export function gfMultiply(a: number, b: number): number {
  if (a === 0 || b === 0) return 0;
  return GF_EXP[GF_LOG[a]! + GF_LOG[b]!]!;
}

/**
 * Generator polynomial for `degree` error-correction codewords: the product of
 * (x - alpha^i) for i < degree, stored highest-degree-coefficient first.
 *
 * Multiplying by (x - alpha^i) raises each existing term by one degree and adds
 * an alpha^i-scaled copy at the original degree, which keeps the polynomial
 * monic — `rsEncode` relies on the leading coefficient being 1.
 */
export function rsGeneratorPolynomial(degree: number): Uint8Array {
  let poly = Uint8Array.from([1]);
  for (let i = 0; i < degree; i += 1) {
    const next = new Uint8Array(poly.length + 1);
    for (let j = 0; j < poly.length; j += 1) {
      next[j] = (next[j]! ^ poly[j]!) & 0xff;
      next[j + 1] = (next[j + 1]! ^ gfMultiply(poly[j]!, GF_EXP[i]!)) & 0xff;
    }
    poly = next;
  }
  return poly;
}

/** Polynomial long division remainder — the error-correction codewords. */
export function rsEncode(data: Uint8Array, eccLength: number): Uint8Array {
  const generator = rsGeneratorPolynomial(eccLength);
  const remainder = new Uint8Array(eccLength);
  for (const byte of data) {
    const factor = byte ^ remainder[0]!;
    remainder.copyWithin(0, 1);
    remainder[eccLength - 1] = 0;
    if (factor !== 0) {
      for (let i = 0; i < eccLength; i += 1) {
        remainder[i] = (remainder[i]! ^ gfMultiply(generator[i + 1]!, factor)) & 0xff;
      }
    }
  }
  return remainder;
}

/* -------------------------------------------------------------------------- */
/* Version tables (ECC level L only)                                          */
/* -------------------------------------------------------------------------- */

interface VersionSpec {
  /** Total data codewords available to the payload. */
  dataCodewords: number;
  /** Error-correction codewords per block. */
  eccPerBlock: number;
  /** Number of RS blocks the data is split across. */
  blocks: number;
}

/** Versions 1–10, ECC level L. Values from ISO/IEC 18004 Table 9. */
const VERSIONS: Record<number, VersionSpec> = {
  1: { dataCodewords: 19, eccPerBlock: 7, blocks: 1 },
  2: { dataCodewords: 34, eccPerBlock: 10, blocks: 1 },
  3: { dataCodewords: 55, eccPerBlock: 15, blocks: 1 },
  4: { dataCodewords: 80, eccPerBlock: 20, blocks: 1 },
  5: { dataCodewords: 108, eccPerBlock: 26, blocks: 1 },
  6: { dataCodewords: 136, eccPerBlock: 18, blocks: 2 },
  7: { dataCodewords: 156, eccPerBlock: 20, blocks: 2 },
  8: { dataCodewords: 194, eccPerBlock: 24, blocks: 2 },
  9: { dataCodewords: 232, eccPerBlock: 30, blocks: 2 },
  10: { dataCodewords: 274, eccPerBlock: 18, blocks: 4 },
};

/** Row/column centres of alignment patterns, indexed by version. */
const ALIGNMENT_CENTRES: Record<number, number[]> = {
  1: [],
  2: [6, 18],
  3: [6, 22],
  4: [6, 26],
  5: [6, 30],
  6: [6, 34],
  7: [6, 22, 38],
  8: [6, 24, 42],
  9: [6, 26, 46],
  10: [6, 28, 50],
};

const MAX_VERSION = 10;

export function qrSize(version: number): number {
  return version * 4 + 17;
}

/* -------------------------------------------------------------------------- */
/* Bit buffer                                                                 */
/* -------------------------------------------------------------------------- */

class BitBuffer {
  private readonly bits: number[] = [];

  push(value: number, length: number): void {
    for (let i = length - 1; i >= 0; i -= 1) this.bits.push((value >>> i) & 1);
  }

  get length(): number {
    return this.bits.length;
  }

  toCodewords(total: number): Uint8Array {
    const bytes = new Uint8Array(total);
    for (let i = 0; i < this.bits.length; i += 1) {
      if (this.bits[i]) bytes[i >> 3]! |= 0x80 >> (i & 7);
    }
    return bytes;
  }
}

/* -------------------------------------------------------------------------- */
/* Encoding                                                                   */
/* -------------------------------------------------------------------------- */

function chooseVersion(byteLength: number): number {
  for (let version = 1; version <= MAX_VERSION; version += 1) {
    // Mode indicator (4 bits) + character count + payload, in whole codewords.
    const countBits = version < 10 ? 8 : 16;
    const required = Math.ceil((4 + countBits + byteLength * 8) / 8);
    if (required <= VERSIONS[version]!.dataCodewords) return version;
  }
  throw new Error('qr_payload_too_large');
}

function buildCodewords(data: Uint8Array, version: number): Uint8Array {
  const spec = VERSIONS[version]!;
  const buffer = new BitBuffer();
  buffer.push(0b0100, 4); // Byte mode.
  buffer.push(data.length, version < 10 ? 8 : 16);
  for (const byte of data) buffer.push(byte, 8);

  const capacityBits = spec.dataCodewords * 8;
  // Terminator: up to four zero bits, truncated if the payload nearly fills.
  buffer.push(0, Math.min(4, capacityBits - buffer.length));
  // Pad to a byte boundary.
  if (buffer.length % 8 !== 0) buffer.push(0, 8 - (buffer.length % 8));

  const codewords = buffer.toCodewords(spec.dataCodewords);
  // Alternating pad codewords specified by the standard.
  const padStart = buffer.length / 8;
  for (let i = padStart; i < spec.dataCodewords; i += 1) {
    codewords[i] = (i - padStart) % 2 === 0 ? 0xec : 0x11;
  }

  // Split into RS blocks. Later blocks absorb the remainder, per the standard.
  const shortBlockSize = Math.floor(spec.dataCodewords / spec.blocks);
  const longBlockCount = spec.dataCodewords % spec.blocks;
  const dataBlocks: Uint8Array[] = [];
  const eccBlocks: Uint8Array[] = [];
  let offset = 0;
  for (let block = 0; block < spec.blocks; block += 1) {
    const size = shortBlockSize + (block >= spec.blocks - longBlockCount ? 1 : 0);
    const slice = codewords.subarray(offset, offset + size);
    offset += size;
    dataBlocks.push(slice);
    eccBlocks.push(rsEncode(slice, spec.eccPerBlock));
  }

  // Interleave data then ECC codewords.
  const result: number[] = [];
  const maxDataLength = Math.max(...dataBlocks.map((block) => block.length));
  for (let i = 0; i < maxDataLength; i += 1) {
    for (const block of dataBlocks) if (i < block.length) result.push(block[i]!);
  }
  for (let i = 0; i < spec.eccPerBlock; i += 1) {
    for (const block of eccBlocks) result.push(block[i]!);
  }
  return Uint8Array.from(result);
}

/* -------------------------------------------------------------------------- */
/* Matrix construction                                                        */
/* -------------------------------------------------------------------------- */

type Matrix = Int8Array[]; // -1 = free, 0 = light, 1 = dark.

function createMatrix(version: number): { matrix: Matrix; reserved: boolean[][] } {
  const size = qrSize(version);
  const matrix: Matrix = Array.from({ length: size }, () => new Int8Array(size).fill(-1));
  const reserved = Array.from({ length: size }, () => new Array<boolean>(size).fill(false));

  const setFunction = (row: number, column: number, dark: boolean) => {
    matrix[row]![column] = dark ? 1 : 0;
    reserved[row]![column] = true;
  };

  // Finder patterns plus their separators.
  const placeFinder = (top: number, left: number) => {
    for (let r = -1; r <= 7; r += 1) {
      for (let c = -1; c <= 7; c += 1) {
        const row = top + r;
        const column = left + c;
        if (row < 0 || row >= size || column < 0 || column >= size) continue;
        const inRing = (r >= 0 && r <= 6 && (c === 0 || c === 6)) || (c >= 0 && c <= 6 && (r === 0 || r === 6));
        const inCore = r >= 2 && r <= 4 && c >= 2 && c <= 4;
        setFunction(row, column, inRing || inCore);
      }
    }
  };
  placeFinder(0, 0);
  placeFinder(0, size - 7);
  placeFinder(size - 7, 0);

  // Timing patterns.
  for (let i = 8; i < size - 8; i += 1) {
    const dark = i % 2 === 0;
    setFunction(6, i, dark);
    setFunction(i, 6, dark);
  }

  // Alignment patterns, skipping those that would collide with finders.
  const centres = ALIGNMENT_CENTRES[version]!;
  for (const row of centres) {
    for (const column of centres) {
      const nearFinder = (row <= 8 && column <= 8) || (row <= 8 && column >= size - 9) || (row >= size - 9 && column <= 8);
      if (nearFinder) continue;
      for (let r = -2; r <= 2; r += 1) {
        for (let c = -2; c <= 2; c += 1) {
          const ring = Math.max(Math.abs(r), Math.abs(c));
          setFunction(row + r, column + c, ring !== 1);
        }
      }
    }
  }

  // Dark module, always set for every version.
  setFunction(size - 8, 8, true);

  // Reserve the format information areas.
  for (let i = 0; i < 9; i += 1) {
    if (!reserved[8]![i]) setFunction(8, i, false);
    if (!reserved[i]![8]) setFunction(i, 8, false);
  }
  for (let i = 0; i < 8; i += 1) {
    if (!reserved[8]![size - 1 - i]) setFunction(8, size - 1 - i, false);
    if (!reserved[size - 1 - i]![8]) setFunction(size - 1 - i, 8, false);
  }

  // Version information blocks (version 7 and above).
  if (version >= 7) {
    const bits = versionInformationBits(version);
    for (let i = 0; i < 18; i += 1) {
      const dark = ((bits >> i) & 1) === 1;
      const row = Math.floor(i / 3);
      const column = size - 11 + (i % 3);
      setFunction(row, column, dark);
      setFunction(column, row, dark);
    }
  }

  return { matrix, reserved };
}

/**
 * Which modules of a symbol are function patterns (finders, timing, alignment,
 * format/version areas) rather than payload. Exported so tests can decode a
 * generated symbol back to its payload instead of trusting the encoder.
 */
export function functionPatternMap(version: number): boolean[][] {
  return createMatrix(version).reserved;
}

/** BCH(18,6) version information. */
function versionInformationBits(version: number): number {
  let remainder = version;
  for (let i = 0; i < 12; i += 1) {
    remainder = (remainder << 1) ^ ((remainder >>> 11) * 0x1f25);
  }
  return ((version << 12) | remainder) & 0x3ffff;
}

/** BCH(15,5) format information for ECC level L and the chosen mask. */
export function formatInformationBits(mask: number): number {
  // 0b01 is the ECC-L indicator.
  const data = (0b01 << 3) | mask;
  let remainder = data;
  for (let i = 0; i < 10; i += 1) {
    remainder = (remainder << 1) ^ ((remainder >>> 9) * 0x537);
  }
  return ((data << 10) | remainder) ^ 0x5412;
}

function placeCodewords(matrix: Matrix, reserved: boolean[][], codewords: Uint8Array): void {
  const size = matrix.length;
  let bitIndex = 0;
  let upward = true;
  for (let right = size - 1; right >= 1; right -= 2) {
    // Column 6 is the vertical timing pattern and is skipped entirely.
    const columnRight = right <= 6 ? right - 1 : right;
    for (let step = 0; step < size; step += 1) {
      const row = upward ? size - 1 - step : step;
      for (const column of [columnRight, columnRight - 1]) {
        if (column < 0 || reserved[row]![column]) continue;
        const byte = codewords[bitIndex >> 3];
        // Remainder bits past the payload stay light.
        const bit = byte === undefined ? 0 : (byte >> (7 - (bitIndex & 7))) & 1;
        matrix[row]![column] = bit as 0 | 1;
        bitIndex += 1;
      }
    }
    upward = !upward;
  }
}

const MASK_PREDICATES: Array<(row: number, column: number) => boolean> = [
  (r, c) => (r + c) % 2 === 0,
  (r) => r % 2 === 0,
  (_r, c) => c % 3 === 0,
  (r, c) => (r + c) % 3 === 0,
  (r, c) => (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0,
  (r, c) => ((r * c) % 2) + ((r * c) % 3) === 0,
  (r, c) => (((r * c) % 2) + ((r * c) % 3)) % 2 === 0,
  (r, c) => (((r + c) % 2) + ((r * c) % 3)) % 2 === 0,
];

function applyMask(matrix: Matrix, reserved: boolean[][], mask: number): Matrix {
  const predicate = MASK_PREDICATES[mask]!;
  return matrix.map((row, r) => {
    const next = Int8Array.from(row);
    for (let c = 0; c < row.length; c += 1) {
      if (!reserved[r]![c] && predicate(r, c)) next[c] = (row[c]! ^ 1) as 0 | 1;
    }
    return next;
  });
}

function placeFormatInformation(matrix: Matrix, mask: number): void {
  const size = matrix.length;
  const bits = formatInformationBits(mask);
  for (let i = 0; i < 15; i += 1) {
    const dark = ((bits >> i) & 1) === 1 ? 1 : 0;
    // Copy 1: around the top-left finder.
    if (i < 6) matrix[8]![i] = dark;
    else if (i === 6) matrix[8]![7] = dark;
    else if (i === 7) matrix[8]![8] = dark;
    else if (i === 8) matrix[7]![8] = dark;
    else matrix[14 - i]![8] = dark;

    // Copy 2: split across the other two finders.
    if (i < 8) matrix[size - 1 - i]![8] = dark;
    else matrix[8]![size - 15 + i] = dark;
  }
  matrix[size - 8]![8] = 1; // Dark module.
}

/** Standard penalty scoring; lower is better. */
function maskPenalty(matrix: Matrix): number {
  const size = matrix.length;
  let penalty = 0;

  const scoreLine = (get: (index: number) => number) => {
    let run = 1;
    for (let i = 1; i < size; i += 1) {
      if (get(i) === get(i - 1)) {
        run += 1;
        if (run === 5) penalty += 3;
        else if (run > 5) penalty += 1;
      } else {
        run = 1;
      }
    }
  };
  for (let r = 0; r < size; r += 1) scoreLine((i) => matrix[r]![i]!);
  for (let c = 0; c < size; c += 1) scoreLine((i) => matrix[i]![c]!);

  // 2x2 blocks of one colour.
  for (let r = 0; r < size - 1; r += 1) {
    for (let c = 0; c < size - 1; c += 1) {
      const value = matrix[r]![c]!;
      if (value === matrix[r]![c + 1] && value === matrix[r + 1]![c] && value === matrix[r + 1]![c + 1]) penalty += 3;
    }
  }

  // Finder-like 1:1:3:1:1 sequences.
  const pattern = [1, 0, 1, 1, 1, 0, 1];
  const matches = (get: (index: number) => number, start: number) => {
    for (let i = 0; i < pattern.length; i += 1) if (get(start + i) !== pattern[i]) return false;
    const before = start - 4 >= 0 && Array.from({ length: 4 }, (_, i) => get(start - 1 - i)).every((v) => v === 0);
    const after = start + pattern.length + 4 <= size && Array.from({ length: 4 }, (_, i) => get(start + pattern.length + i)).every((v) => v === 0);
    return before || after;
  };
  for (let r = 0; r < size; r += 1) {
    for (let c = 0; c + pattern.length <= size; c += 1) if (matches((i) => matrix[r]![i] ?? 0, c)) penalty += 40;
  }
  for (let c = 0; c < size; c += 1) {
    for (let r = 0; r + pattern.length <= size; r += 1) if (matches((i) => matrix[i]?.[c] ?? 0, r)) penalty += 40;
  }

  // Global dark/light balance.
  let dark = 0;
  for (const row of matrix) for (const value of row) if (value === 1) dark += 1;
  const ratio = (dark * 100) / (size * size);
  penalty += Math.floor(Math.abs(ratio - 50) / 5) * 10;

  return penalty;
}

/**
 * Encode `text` and return the module matrix (true = dark), excluding the
 * quiet zone.
 */
export function encodeQr(text: string): boolean[][] {
  const data = new TextEncoder().encode(text);
  const version = chooseVersion(data.length);
  const codewords = buildCodewords(data, version);
  const { matrix, reserved } = createMatrix(version);
  placeCodewords(matrix, reserved, codewords);

  let best: Matrix | null = null;
  let bestPenalty = Number.POSITIVE_INFINITY;
  for (let mask = 0; mask < 8; mask += 1) {
    const candidate = applyMask(matrix, reserved, mask);
    placeFormatInformation(candidate, mask);
    const penalty = maskPenalty(candidate);
    if (penalty < bestPenalty) {
      bestPenalty = penalty;
      best = candidate;
    }
  }
  return best!.map((row) => Array.from(row, (value) => value === 1));
}

/**
 * Render a QR matrix as a self-contained SVG string.
 *
 * The caller passes already-escaped context; this function only emits numbers
 * and a fixed path, so there is no interpolation of untrusted text.
 */
export function renderQrSvg(text: string, options: { quietZone?: number; title?: string } = {}): string {
  const modules = encodeQr(text);
  const quiet = options.quietZone ?? 4;
  const size = modules.length + quiet * 2;
  const segments: string[] = [];
  for (let r = 0; r < modules.length; r += 1) {
    for (let c = 0; c < modules.length; c += 1) {
      if (modules[r]![c]) segments.push(`M${c + quiet} ${r + quiet}h1v1h-1z`);
    }
  }
  const title = options.title ? `<title>${options.title.replace(/[<>&]/g, '')}</title>` : '';
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" role="img" shape-rendering="crispEdges">`,
    title,
    `<rect width="${size}" height="${size}" fill="#ffffff"/>`,
    `<path d="${segments.join('')}" fill="#000000"/>`,
    '</svg>',
  ].join('');
}
