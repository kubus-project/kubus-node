#!/usr/bin/env node
const argv = process.argv.slice(2);
const operatorCommands = new Set(['setup', 'start', 'stop', 'restart', 'status', 'doctor', 'logs', 'open', 'update', 'uninstall', 'version', '--version', '--help', 'help']);

const entrypoint = process.env.KUBUS_NODE_EXECUTION_MODE === 'container' || !operatorCommands.has(argv[0] ?? 'start')
  ? import('./cli/commands.js').then(({ runCli }) => runCli(argv))
  : import('./installer/operatorCli.js').then(({ runOperatorCli }) => runOperatorCli(argv));

entrypoint.catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
