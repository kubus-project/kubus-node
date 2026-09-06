import { createHash } from 'node:crypto';

/** One manifest contract for ZIP, npm and the EXE wrapping the ZIP contents. */
export function createReleaseManifest({ version, channel, sourceSha, nodeImage, workerImage, compose }) {
  return {
    schemaVersion: 1,
    version,
    channel,
    sourceSha,
    nodeImage,
    workerImage,
    composeSha256: createHash('sha256').update(compose).digest('hex'),
    minimumCliVersion: version,
    protocolVersion: 3,
  };
}
