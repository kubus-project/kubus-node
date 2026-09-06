import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

// Pass extracted ZIP, extracted npm package/runtime, and the installed EXE's
// directory. Checking the installed files also proves what the EXE contains.
const directories = process.argv.slice(2).map((value) => resolve(value));
if (directories.length < 2) throw new Error('Pass at least two artifact runtime directories');
let expected;
for (const directory of directories) {
  const manifest = JSON.parse(await readFile(join(directory, 'release-manifest.json'), 'utf8'));
  const compose = await readFile(join(directory, 'docker-compose.release.yml'));
  for (const field of ['version', 'sourceSha', 'protocolVersion', 'nodeImage', 'workerImage', 'composeSha256']) {
    assert.ok(manifest[field], `Missing ${field}`);
  }
  assert.match(manifest.sourceSha, /^[a-f0-9]{40}$/);
  assert.match(manifest.nodeImage, /^ghcr\.io\/kubus-project\/kubus-node@sha256:[a-f0-9]{64}$/);
  assert.match(manifest.workerImage, /^ghcr\.io\/kubus-project\/kubus-spatial-worker@sha256:[a-f0-9]{64}$/);
  assert.equal(createHash('sha256').update(compose).digest('hex'), manifest.composeSha256);
  if (expected) assert.deepEqual(manifest, expected, `Artifact manifest drift in ${directory}`);
  expected = manifest;
}
console.log(`Artifact parity passed for ${directories.length} runtime directories`);
