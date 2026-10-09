import { localError } from '../localApi/pairingService.js';

export type ByteRange = { start: number; end: number; partial: boolean };

/**
 * Parses a single-range `Range` header against a known size.
 *
 * Returns `'unsatisfiable'` for a well-formed range that lies outside the file
 * and throws a typed 416 for one that is not a single byte range at all.
 */
export function parseByteRange(header: string | undefined, total: number): ByteRange | 'unsatisfiable' {
  if (!header) return { start: 0, end: Math.max(0, total - 1), partial: false };
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match) throw localError(416, 'range_not_satisfiable');
  const rawStart = match[1]!;
  const rawEnd = match[2]!;
  if (rawStart === '' && rawEnd === '') throw localError(416, 'range_not_satisfiable');
  let start: number;
  let end: number;
  if (rawStart === '') {
    // Suffix form (`bytes=-N`): N is a length counted from the end.
    start = Math.max(0, total - Number(rawEnd));
    end = total - 1;
  } else {
    start = Number(rawStart);
    end = rawEnd === '' ? total - 1 : Math.min(Number(rawEnd), total - 1);
  }
  if (!Number.isFinite(start) || !Number.isFinite(end) || start > end || start < 0 || start >= total) return 'unsatisfiable';
  return { start, end, partial: true };
}
