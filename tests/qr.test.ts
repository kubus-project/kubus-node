import { describe, expect, it } from 'vitest';
import { encodeQr, formatInformationBits, functionPatternMap, gfMultiply, qrSize, renderQrSvg, rsEncode, rsGeneratorPolynomial } from '../src/gui/qr.js';

/**
 * A hand-written encoder is only trustworthy if the maths is checked rather
 * than eyeballed, so the Galois-field and Reed-Solomon stages are verified
 * against their defining algebraic properties, and the format information is
 * checked against the published ISO/IEC 18004 table.
 */

describe('GF(256) arithmetic', () => {
  it('behaves like a field', () => {
    expect(gfMultiply(0, 123)).toBe(0);
    expect(gfMultiply(1, 123)).toBe(123);
    for (const [a, b] of [[2, 3], [87, 229], [255, 17], [128, 128]] as const) {
      expect(gfMultiply(a, b)).toBe(gfMultiply(b, a));
      expect(gfMultiply(a, b)).toBeLessThan(256);
    }
    // Associativity over a sample of the field.
    for (let a = 1; a < 256; a += 37) {
      for (let b = 1; b < 256; b += 53) {
        expect(gfMultiply(gfMultiply(a, b), 7)).toBe(gfMultiply(a, gfMultiply(b, 7)));
      }
    }
  });
});

describe('Reed-Solomon encoding', () => {
  it('builds a monic generator polynomial of the requested degree', () => {
    for (const degree of [7, 10, 15, 18, 20, 26, 30]) {
      const generator = rsGeneratorPolynomial(degree);
      expect(generator.length).toBe(degree + 1);
      expect(generator[0]).toBe(1);
    }
  });

  it('produces codewords whose syndromes are all zero', () => {
    // The defining property of an RS codeword: C(alpha^i) == 0 for every
    // i < eccLength. If interleaving or the remainder were wrong, this fails.
    const alphaPower = (exponent: number): number => {
      let value = 1;
      for (let i = 0; i < exponent; i += 1) value = gfMultiply(value, 2);
      return value;
    };

    for (const eccLength of [7, 10, 18, 26]) {
      const data = Uint8Array.from({ length: 24 }, (_, i) => (i * 37 + 11) & 0xff);
      const ecc = rsEncode(data, eccLength);
      expect(ecc.length).toBe(eccLength);

      const codeword = [...data, ...ecc];
      for (let i = 0; i < eccLength; i += 1) {
        const x = alphaPower(i);
        let syndrome = 0;
        for (const coefficient of codeword) syndrome = gfMultiply(syndrome, x) ^ coefficient;
        expect(syndrome).toBe(0);
      }
    }
  });
});

describe('format information', () => {
  /** ISO/IEC 18004 Table C.1, error-correction level L, masks 0-7. */
  const EXPECTED_L = [30660, 29427, 32170, 30877, 26159, 25368, 27713, 26998];

  it('matches the published table for every mask', () => {
    for (let mask = 0; mask < 8; mask += 1) {
      expect(formatInformationBits(mask)).toBe(EXPECTED_L[mask]);
    }
  });

  it('remains a valid BCH(15,5) codeword after unmasking', () => {
    for (let mask = 0; mask < 8; mask += 1) {
      let remainder = formatInformationBits(mask) ^ 0x5412;
      // Divide by the generator 0x537; a valid codeword leaves no remainder.
      for (let bit = 14; bit >= 10; bit -= 1) {
        if ((remainder >>> bit) & 1) remainder ^= 0x537 << (bit - 10);
      }
      expect(remainder & 0x3ff).toBe(0);
    }
  });
});

describe('QR matrix', () => {
  const findsPattern = (modules: boolean[][], top: number, left: number): boolean => {
    // Finder pattern: dark 7x7 ring with a dark 3x3 core and a light ring between.
    for (let r = 0; r < 7; r += 1) {
      for (let c = 0; c < 7; c += 1) {
        const ring = r === 0 || r === 6 || c === 0 || c === 6;
        const core = r >= 2 && r <= 4 && c >= 2 && c <= 4;
        if (modules[top + r]![left + c] !== (ring || core)) return false;
      }
    }
    return true;
  };

  it('produces a version 1 symbol for a short payload', () => {
    const modules = encodeQr('kubus');
    expect(modules.length).toBe(21);
    expect(qrSize(1)).toBe(21);
    expect(modules.every((row) => row.length === 21)).toBe(true);
  });

  it('places all three finder patterns', () => {
    const modules = encodeQr('kubus-node://pair?s=abc');
    const size = modules.length;
    expect(findsPattern(modules, 0, 0)).toBe(true);
    expect(findsPattern(modules, 0, size - 7)).toBe(true);
    expect(findsPattern(modules, size - 7, 0)).toBe(true);
  });

  it('places alternating timing patterns and the dark module', () => {
    const modules = encodeQr('kubus-node://pair?s=abc');
    const size = modules.length;
    for (let i = 8; i < size - 8; i += 1) {
      expect(modules[6]![i]).toBe(i % 2 === 0);
      expect(modules[i]![6]).toBe(i % 2 === 0);
    }
    expect(modules[size - 8]![8]).toBe(true);
  });

  it('grows to a larger version as the payload grows', () => {
    const small = encodeQr('a'.repeat(20)).length;
    const medium = encodeQr('a'.repeat(120)).length;
    const large = encodeQr('a'.repeat(250)).length;
    expect(medium).toBeGreaterThan(small);
    expect(large).toBeGreaterThan(medium);
    // Realistic pairing payload stays within the supported range.
    const pairing = encodeQr('kubus-node://pair?e=http://192.168.1.24:8787&s=8f14e45f-ea4e-4e2f-9c1a-2b3c4d5e6f70&k=Zm9vYmFyYmF6cXV4Y29ycmdlZ3JhdWx0Z2FycGx5');
    expect(pairing.length).toBeLessThanOrEqual(57);
  });

  it('rejects a payload beyond the supported versions', () => {
    expect(() => encodeQr('a'.repeat(400))).toThrow(/qr_payload_too_large/);
  });

  it('encodes multi-byte characters as UTF-8', () => {
    expect(() => encodeQr('Ponudi GPU omrežju Kubus')).not.toThrow();
  });
});

describe('round trip', () => {
  /**
   * Decodes a generated symbol back to its payload. The traversal, unmasking
   * and de-interleaving here are written from ISO/IEC 18004 rather than reused
   * from the encoder, so a mistake in either side shows up as a mismatch.
   */
  const decode = (modules: boolean[][]): string => {
    const size = modules.length;
    const version = (size - 17) / 4;
    const reserved = functionPatternMap(version);

    // Recover the mask from format-information copy 1 around the top-left finder.
    let formatBits = 0;
    for (let i = 0; i < 15; i += 1) {
      let dark: boolean;
      if (i < 6) dark = modules[8]![i]!;
      else if (i === 6) dark = modules[8]![7]!;
      else if (i === 7) dark = modules[8]![8]!;
      else if (i === 8) dark = modules[7]![8]!;
      else dark = modules[14 - i]![8]!;
      if (dark) formatBits |= 1 << i;
    }
    const mask = ((formatBits ^ 0x5412) >>> 10) & 0b111;

    const maskPredicates = [
      (r: number, c: number) => (r + c) % 2 === 0,
      (r: number) => r % 2 === 0,
      (_r: number, c: number) => c % 3 === 0,
      (r: number, c: number) => (r + c) % 3 === 0,
      (r: number, c: number) => (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0,
      (r: number, c: number) => ((r * c) % 2) + ((r * c) % 3) === 0,
      (r: number, c: number) => (((r * c) % 2) + ((r * c) % 3)) % 2 === 0,
      (r: number, c: number) => (((r + c) % 2) + ((r * c) % 3)) % 2 === 0,
    ];
    const predicate = maskPredicates[mask]!;

    // Walk the zigzag in the same order the standard writes it, unmasking on read.
    const bits: number[] = [];
    let upward = true;
    for (let right = size - 1; right >= 1; right -= 2) {
      const columnRight = right <= 6 ? right - 1 : right;
      for (let step = 0; step < size; step += 1) {
        const row = upward ? size - 1 - step : step;
        for (const column of [columnRight, columnRight - 1]) {
          if (column < 0 || reserved[row]![column]) continue;
          const raw = modules[row]![column]! ? 1 : 0;
          bits.push(predicate(row, column) ? raw ^ 1 : raw);
        }
      }
      upward = !upward;
    }

    const stream = new Uint8Array(bits.length >> 3);
    for (let i = 0; i < stream.length * 8; i += 1) {
      if (bits[i]) stream[i >> 3]! |= 0x80 >> (i & 7);
    }

    // De-interleave the data codewords (the ECC tail is not needed to read back).
    const spec = { 1: [19, 1], 2: [34, 1], 3: [55, 1], 4: [80, 1], 5: [108, 1], 6: [136, 2], 7: [156, 2], 8: [194, 2], 9: [232, 2], 10: [274, 4] }[version]!;
    const [dataCodewords, blocks] = spec as [number, number];
    const shortSize = Math.floor(dataCodewords / blocks);
    const longCount = dataCodewords % blocks;
    const blockSizes = Array.from({ length: blocks }, (_, b) => shortSize + (b >= blocks - longCount ? 1 : 0));
    const data = new Uint8Array(dataCodewords);
    const cursors = blockSizes.map((_, b) => blockSizes.slice(0, b).reduce((a, v) => a + v, 0));
    let read = 0;
    for (let i = 0; i < Math.max(...blockSizes); i += 1) {
      for (let b = 0; b < blocks; b += 1) {
        if (i >= blockSizes[b]!) continue;
        data[cursors[b]! + i] = stream[read]!;
        read += 1;
      }
    }

    // Mode indicator, character count, then the UTF-8 payload.
    const nibble = data[0]! >> 4;
    expect(nibble).toBe(0b0100); // byte mode
    const countBits = version < 10 ? 8 : 16;
    let cursor = 4;
    const readBits = (count: number): number => {
      let value = 0;
      for (let i = 0; i < count; i += 1) {
        const index = cursor + i;
        value = (value << 1) | ((data[index >> 3]! >> (7 - (index & 7))) & 1);
      }
      cursor += count;
      return value;
    };
    const length = readBits(countBits);
    const bytes = Uint8Array.from({ length }, () => readBits(8));
    return new TextDecoder().decode(bytes);
  };

  it('recovers the payload from the rendered symbol', () => {
    const payloads = [
      'kubus',
      'kubus-node://pair?s=abc',
      'Ponudi GPU omrežju Kubus',
      'kubus-node://pair?e=http://192.168.1.24:8787&s=8f14e45f-ea4e-4e2f-9c1a-2b3c4d5e6f70&k=Zm9vYmFyYmF6cXV4',
      'a'.repeat(200),
    ];
    for (const payload of payloads) {
      expect(decode(encodeQr(payload))).toBe(payload);
    }
  });
});

describe('SVG rendering', () => {
  it('emits a self-contained SVG with a quiet zone', () => {
    const svg = renderQrSvg('kubus', { title: 'Pairing code' });
    expect(svg.startsWith('<svg')).toBe(true);
    expect(svg).toContain('viewBox="0 0 29 29"'); // 21 modules + 4 quiet on each side.
    expect(svg).toContain('<title>Pairing code</title>');
    expect(svg).toContain('role="img"');
    // Nothing that would make the browser fetch anything. The xmlns value is a
    // namespace identifier, never dereferenced, so it is not an external load.
    for (const fetching of ['<image', 'href', 'url(', '<script', '@import', 'xlink']) {
      expect(svg).not.toContain(fetching);
    }
  });

  it('does not let a title inject markup', () => {
    const svg = renderQrSvg('kubus', { title: '<script>alert(1)</script>' });
    expect(svg).not.toContain('<script>');
  });
});
