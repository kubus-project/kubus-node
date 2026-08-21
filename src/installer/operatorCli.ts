import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { findPackageRoot, RuntimeManager } from './runtimeManager.js';

const packageRoot = findPackageRoot(path.dirname(fileURLToPath(import.meta.url)));

export async function runOperatorCli(argv = process.argv.slice(2)): Promise<void> {
  const command = argv[0] ?? 'help';
  const json = argv.includes('--json');
  const manager = new RuntimeManager(packageRoot, await packageVersion());
  if (command === '--version' || command === 'version') return print({ cli: await packageVersion(), runtime: (await manager.release()).version }, json);
  if (command === '--help' || command === 'help') return usage();
  if (command === 'doctor') return print(await manager.doctor(), json);
  if (command === 'setup') return print(await manager.setup({ check: argv.includes('--check'), headless: argv.includes('--headless') }), json);
  if (command === 'start') { await manager.start(); return print({ runtime: 'running' }, json); }
  if (command === 'stop') { await manager.stop(); return print({ runtime: 'stopped' }, json); }
  if (command === 'restart') { await manager.restart(); return print({ runtime: 'restarted' }, json); }
  if (command === 'status') return print(JSON.parse((await manager.status()) || '[]'), json);
  if (command === 'logs') return manager.logs(argv.filter((value) => value !== 'logs' && value !== '--json'));
  if (command === 'open') { await manager.open(); return; }
  if (command === 'update') return print(await manager.update(), json);
  if (command === 'uninstall') {
    const deleteData = argv.includes('--delete-data');
    if (deleteData && !argv.includes('--yes-delete-data')) throw new Error('Destructive uninstall requires both --delete-data and --yes-delete-data; this deletes Node identity, pairings, archive data, private captures, and Kubo data.');
    await manager.uninstall(deleteData);
    return print({ uninstalled: true, dataDeleted: deleteData }, json);
  }
  throw new Error(`Unknown operator command: ${command}`);
}

function print(value: unknown, json: boolean): void {
  if (json) { console.log(JSON.stringify(value, null, 2)); return; }
  if (typeof value === 'object' && value !== null) {
    const record = value as Record<string, unknown>;
    if ('cli' in record && 'runtime' in record) console.log(`kubus Node CLI: ${record.cli}\nNode runtime: ${record.runtime}`);
    else if ('runtime' in record && typeof record.runtime === 'string') console.log(`kubus Node runtime ${record.runtime}`);
    else console.log(JSON.stringify(value, null, 2));
    return;
  }
  console.log(String(value));
}

async function packageVersion(): Promise<string> {
  return (JSON.parse(await readFile(path.join(packageRoot, 'package.json'), 'utf8')) as { version: string }).version;
}

function usage(): void {
  console.log(`kubus-node <command>\n\nCommands: setup [--check] [--headless], start, stop, restart, status [--json], doctor [--json], logs, open, update, uninstall [--delete-data --yes-delete-data], version`);
}
