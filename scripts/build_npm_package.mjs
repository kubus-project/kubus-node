import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const options = parseArgs(process.argv.slice(2));
const metadata = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
const versionInfo = JSON.parse(await readFile(join(root, 'version.json'), 'utf8'));
const version = options.version ?? metadata.version;
const tag = options.tag ?? `v${version}`;
const nodeImage = image(options['node-image'], 'node-image');
const workerImage = image(options['worker-image'], 'worker-image');
const sourceSha = options['source-sha'] ?? '0000000000000000000000000000000000000000';
if (metadata.version !== versionInfo.version || version !== metadata.version || tag !== `v${version}`) throw new Error('npm package version, version.json, and tag must agree.');
if (!/^[a-f0-9]{40}$/i.test(sourceSha)) throw new Error('--source-sha must be a 40 character commit SHA.');
const output = resolve(options.output ?? join(root, 'release', 'npm'));
const stage = join(output, 'package');
await rm(output, { recursive: true, force: true });
await mkdir(join(stage, 'runtime'), { recursive: true });
for (const entry of ['dist', 'README.md', 'LICENSE', 'version.json', 'package.json']) await cp(join(root, entry), join(stage, entry), { recursive: true });
const compose = (await readFile(join(root, 'docker-compose.release.template.yml'), 'utf8'))
  .replaceAll('__KUBUS_NODE_IMAGE__', nodeImage)
  .replaceAll('__KUBUS_SPATIAL_WORKER_IMAGE__', workerImage);
await writeFile(join(stage, 'runtime', 'docker-compose.release.yml'), compose, 'utf8');
await writeFile(join(stage, 'runtime', 'release-manifest.json'), `${JSON.stringify({
  schemaVersion: 1,
  version,
  channel: versionInfo.channel,
  sourceSha,
  nodeImage,
  workerImage,
  composeSha256: createHash('sha256').update(compose).digest('hex'),
  minimumCliVersion: version,
  protocolVersion: 3,
}, null, 2)}\n`);
const packed = npm(['pack', '--json'], stage);
if (packed.status !== 0) throw new Error(packed.error?.message || packed.stderr || packed.stdout);
const [result] = JSON.parse(packed.stdout);
if (!result?.filename) throw new Error('npm pack did not report a package filename.');
const tarball = join(stage, result.filename);
const finalTarball = join(output, result.filename);
await cp(tarball, finalTarball);
console.log(JSON.stringify({ stage, tarball: finalTarball, manifest: join(stage, 'runtime', 'release-manifest.json') }));

function parseArgs(args) {
  const output = {};
  for (let i = 0; i < args.length; i += 2) {
    const key = args[i]; const value = args[i + 1];
    if (!key?.startsWith('--') || !value || value.startsWith('--')) throw new Error(`Expected --name value; got ${key ?? ''}`);
    output[key.slice(2)] = value;
  }
  return output;
}
function image(value, name) {
  if (!value || !/^ghcr\.io\/kubus-project\/kubus-(?:node|spatial-worker)@sha256:[a-f0-9]{64}$/.test(value)) throw new Error(`--${name} must be an immutable Kubus image digest.`);
  return value;
}
function npm(args, cwd) {
  return process.platform === 'win32'
    ? spawnSync(process.env.ComSpec || 'cmd.exe', ['/d', '/c', `npm ${args.join(' ')}`], { cwd, encoding: 'utf8' })
    : spawnSync('npm', args, { cwd, encoding: 'utf8' });
}
