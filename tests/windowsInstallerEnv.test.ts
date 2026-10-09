import { spawnSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mergeEnvText, readEnvValue, withComposeProfile, type EnvUpdates } from '../src/installer/runtimeEnv.js';
import { envUpdatesFor, planSpatialWorker, type SpatialWorkerMode } from '../src/installer/spatialWorker.js';

/**
 * The Windows installer's runtime.env and GPU-worker logic, executed.
 *
 * KubusNodeSetup.ps1 carries its own port of the TypeScript merge and plan
 * (it cannot import them). A port nobody runs is where the original defect
 * lived, so these tests pull the real functions out of the shipped script by
 * AST, run them in a real PowerShell, and require the same answers as the
 * TypeScript on identical inputs. Which PowerShell: KUBUS_TEST_PWSH, else
 * `pwsh`, else Windows PowerShell 5.1 - the Windows CI job runs this under 5.1.
 */

function findPowerShell(): string | undefined {
  const candidates = [process.env.KUBUS_TEST_PWSH, 'pwsh', ...(process.platform === 'win32' ? ['powershell.exe'] : [])].filter((value): value is string => Boolean(value));
  return candidates.find((bin) => spawnSync(bin, ['-NoLogo', '-NoProfile', '-Command', '1'], { encoding: 'utf8', env: { ...process.env, DOTNET_SYSTEM_GLOBALIZATION_INVARIANT: '1' } }).status === 0);
}

const powershell = findPowerShell();
const installer = path.resolve('installer/windows/KubusNodeSetup.ps1');

const DRIVER = String.raw`
param([string]$Installer, [string]$InputPath, [string]$DataRoot)
$ErrorActionPreference = 'Stop'
$tokens = $null; $errors = $null
$ast = [System.Management.Automation.Language.Parser]::ParseFile($Installer, [ref]$tokens, [ref]$errors)
if ($errors.Count -gt 0) { throw ($errors | Out-String) }
$wanted = @('Write-RuntimeTopology', 'Get-RuntimeEnvText', 'Get-RuntimeEnvValue', 'Merge-RuntimeEnvText', 'Set-RuntimeEnvValues', 'Get-ComposeProfiles', 'Resolve-SpatialWorkerPlan')
$found = $ast.FindAll({ param($node) $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $wanted -contains $node.Name }, $true)
if ($found.Count -ne $wanted.Count) { throw "Expected $($wanted.Count) installer functions, found $($found.Count)." }
foreach ($function in $found) { . ([scriptblock]::Create($function.Extent.Text)) }
$dataRoot = $DataRoot
$runtimeEnv = Join-Path $DataRoot 'runtime.env'
$request = Get-Content -Raw -LiteralPath $InputPath | ConvertFrom-Json
$results = @()
foreach ($case in $request.cases) {
  $result = [ordered]@{}
  try {
    switch ($case.kind) {
      'merge' {
        $updates = [ordered]@{}
        foreach ($pair in $case.updates) { $updates[[string]$pair[0]] = $pair[1] }
        $result.value = Merge-RuntimeEnvText ([string]$case.text) $updates "` + "`n" + String.raw`"
      }
      'read' { $result.value = Get-RuntimeEnvValue ([string]$case.key) ([string]$case.text) }
      'profiles' { $result.value = Get-ComposeProfiles ([string]$case.current) ([bool]$case.enabled) }
      'plan' {
        $plan = Resolve-SpatialWorkerPlan ([string]$case.mode) ([bool]$case.supported) ([int]$case.gpus) $case.docker
        $result.value = [ordered]@{ start = [bool]$plan.Start; state = $plan.State }
      }
      'topology' {
        if ($null -ne $case.initial) { [System.IO.File]::WriteAllText($runtimeEnv, [string]$case.initial) }
        Write-RuntimeTopology ([bool]$case.allowLan)
        $result.value = [System.IO.File]::ReadAllText($runtimeEnv)
      }
      'set' {
        if ($null -ne $case.initial) { [System.IO.File]::WriteAllText($runtimeEnv, [string]$case.initial) }
        $updates = [ordered]@{}
        foreach ($pair in $case.updates) { $updates[[string]$pair[0]] = $pair[1] }
        Set-RuntimeEnvValues $updates
        $result.value = [System.IO.File]::ReadAllText($runtimeEnv)
        $result.files = @(Get-ChildItem -LiteralPath $DataRoot -Force | ForEach-Object { $_.Name })
      }
    }
  } catch {
    $result.error = "$($_.Exception.Message)"
  }
  $results += ,$result
}
ConvertTo-Json -InputObject @($results) -Depth 6 -Compress
`;

let dir: string;
beforeAll(async () => { dir = await fs.mkdtemp(path.join(os.tmpdir(), 'kubus-ps-')); });
afterAll(async () => { await fs.rm(dir, { recursive: true, force: true }); });

interface Result { value?: unknown; files?: string[]; error?: string }

async function runCases(cases: unknown[], dataRoot = dir): Promise<Result[]> {
  const driver = path.join(dir, 'driver.ps1');
  const input = path.join(dir, `input-${Math.random().toString(36).slice(2)}.json`);
  await fs.writeFile(driver, DRIVER);
  await fs.writeFile(input, JSON.stringify({ cases }));
  const run = spawnSync(powershell!, ['-NoLogo', '-NoProfile', '-File', driver, '-Installer', installer, '-InputPath', input, '-DataRoot', dataRoot], {
    encoding: 'utf8', env: { ...process.env, DOTNET_SYSTEM_GLOBALIZATION_INVARIANT: '1' },
  });
  if (run.status !== 0) throw new Error(`PowerShell failed (${run.status}): ${run.stderr || run.stdout}`);
  return JSON.parse(run.stdout) as Result[];
}

const pairs = (updates: EnvUpdates) => Object.entries(updates);

describe.skipIf(!powershell)('the Windows installer\'s runtime.env merge matches the TypeScript', () => {
  const operator = ['# mine', 'NODE_BIND_ADDRESS=0.0.0.0', '', 'NODE_LAN_URL=http://192.168.1.20:8787', 'MY_SECRET=p4ss=word with spaces # and a hash', "QUOTED='keep me'", '#COMMENTED=1', 'COMPOSE_PROFILES=monitoring', ''].join('\n');
  const cases: Array<{ name: string; text: string; updates: EnvUpdates }> = [
    { name: 'operator file, topology change plus new keys', text: operator, updates: { NODE_BIND_ADDRESS: '127.0.0.1', KUBUS_SPATIAL_WORKER: 'auto' } },
    { name: 'the full worker decision', text: operator, updates: envUpdatesFor({ mode: 'auto', start: true, state: 'enabled' }, operator) },
    { name: 'the worker switched off again', text: 'COMPOSE_PROFILES=spatial\nSPATIAL_WORKER_URL=http://kubus-spatial-worker:8790\n', updates: envUpdatesFor({ mode: 'off', start: false, state: 'operator_off' }, 'COMPOSE_PROFILES=spatial\n') },
    { name: 'removal', text: operator, updates: { COMPOSE_PROFILES: null } },
    { name: 'removal of everything', text: 'A=1\n', updates: { A: null } },
    { name: 'lookalike names and comments', text: 'NODE_BIND_ADDRESS_2=keep\n# NODE_BIND_ADDRESS=commented\nXNODE_BIND_ADDRESS=keep\n', updates: { NODE_BIND_ADDRESS: '127.0.0.1' } },
    { name: 'export form', text: 'export KUBUS_SPATIAL_WORKER=off\nOTHER=1\n', updates: { KUBUS_SPATIAL_WORKER: 'on' } },
    { name: 'repeated key', text: 'A=old\nB=1\nA=older\n', updates: { A: 'new' } },
    { name: 'CRLF file', text: 'NODE_BIND_ADDRESS=127.0.0.1\r\nNODE_LAN_URL=\r\n', updates: { NODE_LAN_URL: 'http://10.0.0.5:8787', KUBUS_SPATIAL_WORKER: 'auto' } },
    { name: 'no trailing newline', text: 'A=1', updates: { B: '2' } },
    { name: 'empty file', text: '', updates: { A: '1', B: '' } },
    { name: 'idempotent', text: 'A=1\nB=2\n', updates: { A: '1', B: '2' } },
  ];

  it.each(cases)('merges: $name', async ({ text, updates }) => {
    const [result] = await runCases([{ kind: 'merge', text, updates: pairs(updates) }]);
    expect(result!.error).toBeUndefined();
    expect(result!.value).toBe(mergeEnvText(text, updates));
  });

  it('refuses the same unsafe keys and values', async () => {
    const unsafe: EnvUpdates[] = [{ 'A B': '1' }, { '1A': '1' }, { 'A=B': '1' }, { A: 'x\nEVIL=1' }, { A: 'two words' }, { A: 'a#b' }, { A: '$HOME' }, { A: "a'b" }, { A: 'a"b' }];
    const results = await runCases(unsafe.map((updates) => ({ kind: 'merge', text: 'KEEP=1\n', updates: pairs(updates) })));
    results.forEach((result, index) => {
      expect(() => mergeEnvText('KEEP=1\n', unsafe[index]!), JSON.stringify(unsafe[index])).toThrow();
      expect(result.error, JSON.stringify(unsafe[index])).toMatch(/Refusing to write/);
    });
  });

  it('reads values as the TypeScript does', async () => {
    const text = '# A=1\nA=first\nB="quoted"\nC=\nA=last\nD=\'single\'\n';
    const keys = ['A', 'B', 'C', 'D', 'MISSING'];
    const results = await runCases(keys.map((key) => ({ kind: 'read', key, text })));
    results.forEach((result, index) => expect(result.value ?? null, keys[index]).toBe(readEnvValue(text, keys[index]!) ?? null));
    expect(results.map((result) => result.value ?? null)).toEqual(['last', 'quoted', '', 'single', null]);
  });

  it('keeps and removes compose profiles as the TypeScript does', async () => {
    const inputs: Array<[string, boolean]> = [['', true], ['monitoring', true], ['monitoring,spatial', true], ['spatial,monitoring', false], ['spatial', false], [' a , spatial ,, b ', false], ['', false]];
    const results = await runCases(inputs.map(([current, enabled]) => ({ kind: 'profiles', current, enabled })));
    results.forEach((result, index) => {
      const [current, enabled] = inputs[index]!;
      expect(result.value ?? null, `${current}/${enabled}`).toBe(withComposeProfile(current, 'spatial', enabled));
    });
  });
});

describe.skipIf(!powershell)('the Windows installer decides about the worker as the TypeScript does', () => {
  const rtx = { name: 'RTX', vramMb: 12288, driver: '1' };
  const modes: SpatialWorkerMode[] = ['auto', 'on', 'off'];
  const table = modes.flatMap((mode) => [true, false].flatMap((supported) => [0, 1].flatMap((gpus) => ([true, false, null] as const).map((docker) => ({ mode, supported, gpus, docker })))));

  it(`agrees on all ${table.length} combinations of mode, platform, GPU and Docker runtime`, async () => {
    const results = await runCases(table.map((row) => ({ kind: 'plan', ...row })));
    table.forEach((row, index) => {
      const expected = planSpatialWorker(row.mode, { platformSupported: row.supported, gpus: row.gpus ? [rtx] : [], dockerNvidiaRuntime: row.docker });
      expect(results[index]!.error, JSON.stringify(row)).toBeUndefined();
      expect(results[index]!.value, JSON.stringify(row)).toEqual({ start: expected.start, state: expected.state });
    });
  });
});

describe.skipIf(!powershell)('writing runtime.env on disk from the Windows installer', () => {
  it('changes only the topology keys when setup finishes, keeps the worker decision and the operator\'s lines, and leaves no temporary file', async () => {
    const root = await fs.mkdtemp(path.join(dir, 'case-'));
    const initial = 'NODE_BIND_ADDRESS=127.0.0.1\r\nNODE_LAN_URL=\r\nKUBUS_SPATIAL_WORKER=auto\r\nKUBUS_SPATIAL_WORKER_STATE=enabled\r\nSPATIAL_WORKER_URL=http://kubus-spatial-worker:8790\r\nCOMPOSE_PROFILES=spatial\r\nMY_SECRET=keep=this\r\n';
    const updates = { NODE_BIND_ADDRESS: '0.0.0.0', NODE_LAN_URL: 'http://192.168.1.40:8787' };
    const [result] = await runCases([{ kind: 'set', initial, updates: pairs(updates) }], root);
    expect(result!.error).toBeUndefined();
    expect(result!.value).toBe(mergeEnvText(initial, updates));
    expect(result!.value).toContain('COMPOSE_PROFILES=spatial\r\n');
    expect(result!.value).toContain('MY_SECRET=keep=this\r\n');
    expect(result!.files).toEqual(['runtime.env']);
  });

  it('finishing setup (Write-RuntimeTopology) keeps every other key - the original defect, executed', async () => {
    // This is the function that used to write the whole file. It is run as shipped.
    const root = await fs.mkdtemp(path.join(dir, 'case-'));
    const initial = '# mine\r\nNODE_BIND_ADDRESS=0.0.0.0\r\nNODE_LAN_URL=http://192.168.1.20:8787\r\nKUBUS_SPATIAL_WORKER=auto\r\nKUBUS_SPATIAL_WORKER_STATE=enabled\r\nSPATIAL_WORKER_URL=http://kubus-spatial-worker:8790\r\nCOMPOSE_PROFILES=spatial\r\nMY_SECRET=keep=this\r\n';
    const [result] = await runCases([{ kind: 'topology', initial, allowLan: false }], root);
    expect(result!.error).toBeUndefined();
    expect(result!.value).toBe(mergeEnvText(initial, { NODE_BIND_ADDRESS: '127.0.0.1', NODE_LAN_URL: '' }));
    for (const kept of ['# mine', 'KUBUS_SPATIAL_WORKER=auto', 'KUBUS_SPATIAL_WORKER_STATE=enabled', 'SPATIAL_WORKER_URL=http://kubus-spatial-worker:8790', 'COMPOSE_PROFILES=spatial', 'MY_SECRET=keep=this']) {
      expect(result!.value).toContain(kept);
    }
    expect(result!.value).toContain('NODE_BIND_ADDRESS=127.0.0.1');
  });

  it('writes a new file with Windows line endings and nothing else beside it', async () => {
    const root = await fs.mkdtemp(path.join(dir, 'case-'));
    const [result] = await runCases([{ kind: 'set', updates: pairs({ NODE_BIND_ADDRESS: '127.0.0.1', NODE_LAN_URL: '' }) }], root);
    expect(result!.value).toBe('NODE_BIND_ADDRESS=127.0.0.1\r\nNODE_LAN_URL=\r\n');
    expect(result!.files).toEqual(['runtime.env']);
  });

  it('does not rewrite a file that would not change', async () => {
    const root = await fs.mkdtemp(path.join(dir, 'case-'));
    const file = path.join(root, 'runtime.env');
    await fs.writeFile(file, 'A=1\n');
    const before = (await fs.stat(file)).mtimeMs;
    await new Promise((resolve) => setTimeout(resolve, 30));
    await runCases([{ kind: 'set', updates: pairs({ A: '1' }) }], root);
    expect((await fs.stat(file)).mtimeMs).toBe(before);
  });
});
