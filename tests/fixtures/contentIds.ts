import crypto from 'node:crypto';
import { CID } from 'multiformats/cid';
import * as digest from 'multiformats/hashes/digest';

/** Valid synthetic identifiers for tests that exercise parsed CID boundaries. */
export function syntheticCid(label: string): string {
  return CID.createV0(digest.create(0x12, crypto.createHash('sha256').update(label).digest())).toString();
}
