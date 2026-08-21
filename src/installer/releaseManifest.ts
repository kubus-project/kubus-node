import { createHash } from 'node:crypto';

export interface ReleaseManifest {
  schemaVersion: 1;
  version: string;
  channel: 'alpha' | 'beta' | 'stable';
  sourceSha: string;
  nodeImage: string;
  workerImage: string;
  composeSha256: string;
  minimumCliVersion: string;
  protocolVersion: number;
}

const digestImage = /^ghcr\.io\/kubus-project\/kubus-(?:node|spatial-worker)@sha256:[a-f0-9]{64}$/;
const semver = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

export function parseReleaseManifest(value: unknown, compose: string): ReleaseManifest {
  if (!value || typeof value !== 'object') throw new Error('Release manifest must be an object.');
  const manifest = value as Partial<ReleaseManifest>;
  if (manifest.schemaVersion !== 1) throw new Error('Unsupported release manifest schema.');
  if (typeof manifest.version !== 'string' || !semver.test(manifest.version)) throw new Error('Release manifest has an invalid version.');
  if (manifest.channel !== 'alpha' && manifest.channel !== 'beta' && manifest.channel !== 'stable') throw new Error('Release manifest has an invalid channel.');
  if (typeof manifest.sourceSha !== 'string' || !/^[a-f0-9]{40}$/i.test(manifest.sourceSha)) throw new Error('Release manifest has an invalid source SHA.');
  if (typeof manifest.nodeImage !== 'string' || !digestImage.test(manifest.nodeImage)) throw new Error('Release manifest node image is not an immutable Kubus image.');
  if (typeof manifest.workerImage !== 'string' || !digestImage.test(manifest.workerImage)) throw new Error('Release manifest worker image is not an immutable Kubus image.');
  if (typeof manifest.composeSha256 !== 'string' || !/^[a-f0-9]{64}$/i.test(manifest.composeSha256)) throw new Error('Release manifest compose checksum is invalid.');
  if (sha256(compose) !== manifest.composeSha256) throw new Error('Release compose checksum does not match the signed release manifest.');
  if (typeof manifest.minimumCliVersion !== 'string' || !semver.test(manifest.minimumCliVersion)) throw new Error('Release manifest minimum CLI version is invalid.');
  const protocolVersion = manifest.protocolVersion;
  if (!Number.isInteger(protocolVersion) || protocolVersion === undefined || protocolVersion < 1) throw new Error('Release manifest protocol version is invalid.');
  return manifest as ReleaseManifest;
}

export function sha256(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

export function isPlaceholderRelease(manifest: ReleaseManifest): boolean {
  return manifest.nodeImage.includes(`sha256:${'0'.repeat(64)}`) || manifest.workerImage.includes(`sha256:${'0'.repeat(64)}`);
}
