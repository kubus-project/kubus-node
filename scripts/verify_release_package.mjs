import { createHash } from 'node:crypto';
import { readFile, readdir, stat } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';

const directory = resolve(argument('--directory') ?? process.argv[2] ?? '');
if (!directory) throw new Error('Pass --directory <release-package-directory>.');
const expectedVersion = argument('--version');
const required = new Set(['Start-KubusNodeSetup.cmd', 'KubusNodeSetup.ps1', 'docker-compose.release.yml', 'version.json', 'release-metadata.json', 'README-FIRST.txt', 'SHA256SUMS']);
const entries = await files(directory);
const relativeEntries = new Set(entries.map((file) => relative(directory, file).replaceAll('\\', '/')));
for (const file of required) if (!relativeEntries.has(file)) throw new Error(`Missing required release file: ${file}`);
for (const file of relativeEntries) {
  if (/(^|\/)(?:\.env(?:\..*)?|node_modules|dist|src|tests|test|\.git)(?:\/|$)|(?:^|\/).+\.(?:pem|key|pfx|crt)$/i.test(file)) {
    throw new Error(`Release package contains forbidden development or secret-like file: ${file}`);
  }
}
const compose = await readFile(join(directory, 'docker-compose.release.yml'), 'utf8');
if (/^\s*build\s*:/m.test(compose)) throw new Error('Release compose must not contain build:.');
const digests = compose.match(/ghcr\.io\/kubus-project\/kubus-(?:node|spatial-worker)@sha256:[a-f0-9]{64}/g) ?? [];
if (new Set(digests).size !== 2) throw new Error('Release compose must contain one immutable digest for each Kubus image.');
const installer = await readFile(join(directory, 'KubusNodeSetup.ps1'), 'utf8');
if (!installer.includes('docker-compose.release.yml') || /--build\b/.test(installer)) throw new Error('Installer must use the shipped release compose and must not build locally.');
const launcher = await readFile(join(directory, 'Start-KubusNodeSetup.cmd'), 'utf8');
if (!launcher.includes('KubusNodeSetup.ps1')) throw new Error('Windows launcher does not reference the shipped installer.');
const version = JSON.parse(await readFile(join(directory, 'version.json'), 'utf8'));
if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version.version)) throw new Error('version.json has invalid SemVer.');
if (expectedVersion && version.version !== expectedVersion) throw new Error(`Package version ${version.version} does not match ${expectedVersion}.`);
const metadata = JSON.parse(await readFile(join(directory, 'release-metadata.json'), 'utf8'));
if (metadata.version !== version.version || metadata.tag !== `v${version.version}`) throw new Error('Release metadata, version.json, and tag disagree.');
if (metadata.nodeImage !== digests.find((value) => value.includes('/kubus-node@')) || metadata.workerImage !== digests.find((value) => value.includes('/kubus-spatial-worker@'))) {
  throw new Error('Release metadata does not match the immutable images in Compose.');
}
const checksums = await readFile(join(directory, 'SHA256SUMS'), 'utf8');
const declared = new Map(checksums.trim().split(/\r?\n/).filter(Boolean).map((line) => {
  const match = /^([a-f0-9]{64})  (.+)$/.exec(line);
  if (!match) throw new Error(`Invalid checksum entry: ${line}`);
  return [match[2], match[1]];
}));
for (const file of relativeEntries) {
  if (file === 'SHA256SUMS') continue;
  const expected = declared.get(file);
  if (!expected) throw new Error(`SHA256SUMS is missing ${file}.`);
  const actual = createHash('sha256').update(await readFile(join(directory, file))).digest('hex');
  if (actual !== expected) throw new Error(`Checksum mismatch for ${file}.`);
}
if (declared.size !== relativeEntries.size - 1) throw new Error('SHA256SUMS contains incomplete or unexpected entries.');
console.log(`Release package contract passed: ${directory}`);

function argument(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

async function files(directory) {
  const result = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const full = join(directory, entry.name);
    if (entry.isDirectory()) result.push(...await files(full));
    else if (entry.isFile()) result.push(full);
  }
  return result;
}
