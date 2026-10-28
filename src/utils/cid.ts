import { CID } from 'multiformats/cid';

const CID_CHARS = /^[a-zA-Z0-9]+$/;

export function normalizeCid(raw: string): string {
  const value = String(raw || '').trim();
  const withoutScheme = value.startsWith('ipfs://') ? value.slice('ipfs://'.length) : value;
  const cid = withoutScheme.split(/[/?#]/)[0] || '';
  if (!isValidCidLike(cid)) {
    throw new Error(`Invalid CID: ${value}`);
  }
  return cid;
}

export function isValidCidLike(raw: string | null | undefined): boolean {
  const value = String(raw || '').trim();
  return value.length >= 10 && value.length <= 255 && CID_CHARS.test(value);
}

export function canonicalPinCid(raw: string): string {
  try {
    if (
      typeof raw !== 'string' ||
      !raw ||
      raw.length > 512 ||
      raw.trim() !== raw
    )
      throw new Error();
    return CID.parse(raw).toV1().toString();
  } catch {
    throw new Error('invalid_content_identifier');
  }
}
