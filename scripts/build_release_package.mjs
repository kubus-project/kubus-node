import { cp, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { dirname, join, relative, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const options = parseArgs(process.argv.slice(2));
const versionMetadata = JSON.parse(await readFile(join(root, 'version.json'), 'utf8'));
const packageMetadata = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
const version = options.version ?? versionMetadata.version;
if (packageMetadata.version !== versionMetadata.version || version !== packageMetadata.version) {
  throw new Error('package.json and version.json must agree before packaging.');
}
const tag = options.tag ?? `v${version}`;
if (tag !== `v${version}`) throw new Error(`Release tag ${tag} does not match v${version}.`);
const sourceSha = options['source-sha'] ?? '0000000000000000000000000000000000000000';
if (!/^[a-f0-9]{40}$/i.test(sourceSha)) throw new Error('--source-sha must be a 40 character commit SHA.');
const nodeImage = requiredDigestImage(options['node-image'], 'node-image');
const workerImage = requiredDigestImage(options['worker-image'], 'worker-image');
const output = resolve(options.output ?? join(root, 'release'));
const packageName = `kubus-node-windows-${tag}`;
const packageDir = join(output, packageName);

await rm(packageDir, { recursive: true, force: true });
await mkdir(packageDir, { recursive: true });
await cp(join(root, 'installer', 'windows', 'Start-KubusNodeSetup.cmd'), join(packageDir, 'Start-KubusNodeSetup.cmd'));
await cp(join(root, 'installer', 'windows', 'KubusNodeSetup.ps1'), join(packageDir, 'KubusNodeSetup.ps1'));
await cp(join(root, 'version.json'), join(packageDir, 'version.json'));
const compose = (await readFile(join(root, 'docker-compose.release.template.yml'), 'utf8'))
  .replaceAll('__KUBUS_NODE_IMAGE__', nodeImage)
  .replaceAll('__KUBUS_SPATIAL_WORKER_IMAGE__', workerImage);
await writeFile(join(packageDir, 'docker-compose.release.yml'), compose, 'utf8');
const releaseManifest = {
  schemaVersion: 1,
  version,
  channel: versionMetadata.channel,
  sourceSha,
  nodeImage,
  workerImage,
  composeSha256: createHash('sha256').update(compose).digest('hex'),
  minimumCliVersion: version,
  protocolVersion: 3,
};
await writeFile(join(packageDir, 'release-manifest.json'), `${JSON.stringify(releaseManifest, null, 2)}\n`, 'utf8');
await writeFile(join(packageDir, 'release-metadata.json'), `${JSON.stringify({ version, tag, nodeImage, workerImage, releaseManifest }, null, 2)}\n`, 'utf8');
await writeFile(join(packageDir, 'README-FIRST.txt'), firstReadme(tag), 'utf8');
await writeChecksums(packageDir);
await archive(packageDir, join(output, `${packageName}.zip`), 'zip');
await archive(packageDir, join(output, `${packageName}.tar.gz`), 'tar');
console.log(JSON.stringify({ packageDir, zip: join(output, `${packageName}.zip`), tarball: join(output, `${packageName}.tar.gz`) }));

function parseArgs(args) {
  const values = {};
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (!arg.startsWith('--')) throw new Error(`Unexpected argument: ${arg}`);
    const key = arg.slice(2);
    const value = args[index + 1];
    if (!value || value.startsWith('--')) throw new Error(`Missing value for --${key}`);
    values[key] = value;
    index += 1;
  }
  return values;
}

function requiredDigestImage(value, name) {
  if (!value || !/^ghcr\.io\/kubus-project\/kubus-(?:node|spatial-worker)@sha256:[a-f0-9]{64}$/.test(value)) {
    throw new Error(`--${name} must be the immutable ghcr.io/kubus-project image digest`);
  }
  return value;
}

async function files(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const result = [];
  for (const entry of entries) {
    const full = join(directory, entry.name);
    if (entry.isDirectory()) result.push(...await files(full));
    else if (entry.isFile()) result.push(full);
  }
  return result;
}

async function writeChecksums(directory) {
  const entries = (await files(directory)).filter((file) => !file.endsWith('SHA256SUMS'));
  const rows = [];
  for (const file of entries.sort()) {
    const digest = createHash('sha256').update(await readFile(file)).digest('hex');
    rows.push(`${digest}  ${relative(directory, file).replaceAll('\\', '/')}`);
  }
  await writeFile(join(directory, 'SHA256SUMS'), `${rows.join('\n')}\n`, 'utf8');
}

async function archive(directory, target, type) {
  await rm(target, { force: true });
  const parent = dirname(directory);
  const name = relative(parent, directory);
  const command = type === 'tar' ? 'tar' : process.platform === 'win32' ? 'powershell.exe' : 'zip';
  const args = type === 'tar'
    ? ['-C', parent, '-czf', target, name]
    : process.platform === 'win32'
    ? ['-NoLogo', '-NoProfile', '-Command', `Compress-Archive -Path '${directory.replaceAll("'", "''")}\\*' -DestinationPath '${target.replaceAll("'", "''")}' -Force`]
    : ['-qr', target, name];
  const result = spawnSync(command, args, { cwd: parent, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`Could not create ${type} archive: ${result.stderr || result.stdout}`);
  if (!(await stat(target)).size) throw new Error(`Created empty ${type} archive`);
}

function firstReadme(tag) {
  return `kubus Node ${tag}\n\n1. Extract this ZIP to a writable folder.\n2. Double-click Start-KubusNodeSetup.cmd.\n3. Docker Desktop must be installed and running.\n4. The local setup page opens in your browser. It is loopback-only until setup completes.\n5. Enable \"Allow connections from devices on this network\" only when you want to pair nearby devices; the installer detects the PC LAN address automatically.\n\nThis package contains immutable image references; it never builds from source. Keep this folder for Start, Stop, upgrade, and non-destructive reinstall.\n`;
}
