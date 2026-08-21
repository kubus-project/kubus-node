import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const tarball = resolve(argument('--tarball') ?? process.argv[2] ?? '');
if (!tarball) throw new Error('Pass --tarball <kubus package.tgz>.');
const packed = spawnSync('tar', ['-tzf', tarball], { encoding: 'utf8' });
if (packed.status !== 0) throw new Error(packed.stderr || packed.stdout);
const files = new Set(packed.stdout.split(/\r?\n/).filter(Boolean).map((entry) => entry.replace(/^package\//, '')));
for (const required of ['package.json', 'version.json', 'dist/src/index.js', 'runtime/release-manifest.json', 'runtime/docker-compose.release.yml']) if (!files.has(required)) throw new Error(`npm package misses required file: ${required}`);
for (const file of files) {
  if (/^(?:src|tests?|coverage|\.github|node_modules)\/|(^|\/)\.env(?:\.|$)|(^|\/)(?:state\.json|.*\.(?:pem|key|pfx))$/i.test(file)) throw new Error(`npm package leaks development, state, or secret-like file: ${file}`);
}
if ((await stat(tarball)).size > 25 * 1024 * 1024) throw new Error('npm package exceeds the 25 MiB operator CLI limit.');
const packageJson = JSON.parse(tarText(tarball, 'package/package.json'));
for (const key of ['preinstall', 'install', 'postinstall', 'prepack', 'prepare']) {
  if (packageJson.scripts?.[key]) throw new Error(`Published npm package must not contain a ${key} lifecycle script.`);
}
if (packageJson.bin?.['kubus-node'] !== './dist/src/index.js' || !files.has('dist/src/index.js')) throw new Error('Published package bin target is missing or points outside the package.');
const install = await mkdtemp(join(tmpdir(), 'kubus-node-npm-'));
try {
  writePackageJson(install);
  npm(['install', tarball], install);
  const binary = process.platform === 'win32' ? join(install, 'node_modules', '.bin', 'kubus-node.cmd') : join(install, 'node_modules', '.bin', 'kubus-node');
  run(binary, ['--version'], install);
  run(binary, ['doctor', '--json'], install);
  run(binary, ['setup', '--check', '--json'], install);
} finally {
  await rm(install, { recursive: true, force: true });
}
console.log(`npm package contract passed: ${tarball}`);

function argument(name) { const index = process.argv.indexOf(name); return index >= 0 ? process.argv[index + 1] : undefined; }
function writePackageJson(directory) {
  const result = npm(['init', '-y'], directory);
  if (result.status !== 0) throw new Error(result.stderr || result.stdout);
}
function npm(args, cwd) {
  const result = process.platform === 'win32'
    ? spawnSync(process.env.ComSpec || 'cmd.exe', ['/d', '/c', `npm ${args.join(' ')}`], { cwd, encoding: 'utf8' })
    : spawnSync('npm', args, { cwd, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`npm ${args.join(' ')} failed: ${result.error?.message || result.stderr || result.stdout}`);
  return result;
}
function run(command, args, cwd) {
  const result = process.platform === 'win32' && command.toLowerCase().endsWith('.cmd')
    ? spawnSync(process.env.ComSpec || 'cmd.exe', ['/d', '/c', `${command} ${args.join(' ')}`], { cwd, encoding: 'utf8', shell: false })
    : spawnSync(command, args, { cwd, encoding: 'utf8', shell: false });
  if (result.status !== 0) throw new Error(`${command} ${args.join(' ')} failed: ${result.error?.message || result.stderr || result.stdout}`);
}
function tarText(tarball, entry) {
  const result = spawnSync('tar', ['-xOzf', tarball, entry], { encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`Could not read ${entry} from npm tarball: ${result.stderr || result.stdout}`);
  return result.stdout;
}
