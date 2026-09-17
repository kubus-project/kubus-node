import { describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const readJsonWithComments = async (relativePath: string): Promise<Record<string, unknown>> => {
  const raw = await readFile(path.join(repoRoot, relativePath), 'utf8');
  return JSON.parse(raw.replace(/^\s*\/\/.*$/gm, '')) as Record<string, unknown>;
};

describe('release packaging', () => {
  it('compiles only the runtime sources into the shipped image', async () => {
    // The build output is what the Docker image and the npm `bin` ship. Test
    // files there are dead weight at best, and at worst carry fixtures and
    // helper code into a production image for no reason. This asserts the
    // emit boundary directly rather than relying on the test runner to skip
    // whatever happened to land in dist/.
    const tsconfig = await readJsonWithComments('tsconfig.json');
    expect(tsconfig.include).toEqual(['src/**/*.ts']);
  });

  it('still type-checks the sources the image does not ship', async () => {
    // Narrowing the emit must not narrow verification: tests and scripts are
    // checked by a separate no-emit project, so a type error in them still
    // fails CI.
    const check = await readJsonWithComments('tsconfig.check.json');
    expect(check.extends).toBe('./tsconfig.json');
    expect(check.include).toEqual(['src/**/*.ts', 'scripts/**/*.ts', 'tests/**/*.ts']);
    expect((check.compilerOptions as Record<string, unknown>).noEmit).toBe(true);

    const pkg = JSON.parse(await readFile(path.join(repoRoot, 'package.json'), 'utf8')) as {
      scripts: Record<string, string>;
      bin: Record<string, string>;
    };
    expect(pkg.scripts.typecheck).toContain('tsconfig.check.json');
    expect(pkg.scripts.build).toBe('tsc -p tsconfig.json');
  });

  it('never leaves a console window in front of the operator', async () => {
    // `start "kubus Node Setup" powershell.exe` opened a visible console that
    // sat there for the whole of setup, doing nothing a person could read.
    // That is what made a normal install feel untrustworthy.
    const launcher = await readFile(path.join(repoRoot, 'installer', 'windows', 'Start-KubusNodeSetup.cmd'), 'utf8');
    expect(launcher).toContain('-WindowStyle Hidden');
    expect(launcher).not.toMatch(/start\s+"kubus Node Setup"/);
  });

  it('reports setup progress in a local page rather than a hidden console', async () => {
    const setup = await readFile(path.join(repoRoot, 'installer', 'windows', 'KubusNodeSetup.ps1'), 'utf8');
    // HttpListener needs an administrator URL reservation, and this installer
    // runs with PrivilegesRequired=lowest, so the page must be served by a raw
    // socket or it fails for exactly the people it exists for.
    expect(setup).toContain('New-Object System.Net.Sockets.TcpListener');
    // Match actual use, not the word: the file explains in a comment why
    // HttpListener is unusable here.
    expect(setup).not.toMatch(/New-Object System\.Net\.HttpListener|\[System\.Net\.HttpListener\]/);
    // The image pull is the multi-minute step; silence there is what looked
    // like a hang.
    expect(setup).toMatch(/Downloading the kubus Node runtime/);
  });

  it('waits for the Node to answer before sending anyone to it', async () => {
    const setup = await readFile(path.join(repoRoot, 'installer', 'windows', 'KubusNodeSetup.ps1'), 'utf8');
    // Opening the Node's address immediately after `up -d` produced a browser
    // connection error, which reads as "the install failed".
    const started = setup.indexOf("Invoke-NodeCompose @('up', '-d')");
    // Anchor on the step transition, not the page's step list, which names the
    // same wait earlier in the file.
    const waiting = setup.indexOf("Set-Step $sync 'wait'");
    expect(started).toBeGreaterThan(-1);
    expect(waiting).toBeGreaterThan(started);
    // A fresh Node serves /setup; an already configured one serves /gui. Both
    // are accepted, so an upgrade lands on the dashboard rather than a 404.
    expect(setup).toContain('Test-Url "$nodeOrigin/setup"');
    expect(setup).toContain('Test-Url "$nodeOrigin/gui"');
  });

  it('does not let docker progress on stderr abort a pull that is succeeding', async () => {
    const setup = await readFile(path.join(repoRoot, 'installer', 'windows', 'KubusNodeSetup.ps1'), 'utf8');
    // Windows PowerShell 5.1 wraps every redirected stderr line from a native
    // command in an ErrorRecord. `docker compose pull` writes its progress to
    // stderr, so under this script's 'Stop' preference the first progress line
    // became a terminating error and reported "Image ipfs/kubo:v0.43.0 Pulling"
    // as the reason setup failed, on a pull that exited 0.
    expect(setup).toContain("$ErrorActionPreference = 'Stop'");
    const lines = setup.split('\n');
    const redirects = lines
      .map((line, index) => ({ line, index }))
      .filter((entry) => entry.line.includes('2>&1'));
    // If this ever drops to zero the guard below silently stops testing anything.
    expect(redirects.length).toBeGreaterThan(0);
    for (const { line, index } of redirects) {
      const before = lines.slice(Math.max(0, index - 6), index).join('\n');
      const after = lines.slice(index, index + 10).join('\n');
      expect(
        before,
        `stderr redirect is not relaxed before it runs: ${line.trim()}`,
      ).toContain("$ErrorActionPreference = 'Continue'");
      expect(
        after,
        `stderr redirect does not restore the preference: ${line.trim()}`,
      ).toContain('$ErrorActionPreference = $previousPreference');
    }
    // Relaxing the preference only works because the real outcome is still read
    // from the exit code.
    expect(setup).toMatch(/\$ErrorActionPreference = \$previousPreference\s*\n\s*}\s*\n\s*if \(\$LASTEXITCODE -ne 0\)/);
  });

  it('never shows a raw native command line as the reason setup stopped', async () => {
    const setup = await readFile(path.join(repoRoot, 'installer', 'windows', 'KubusNodeSetup.ps1'), 'utf8');
    // "Image ... Pulling" is a normal progress line. Presenting one as the
    // failure reason told the operator the install had broken when it had not.
    expect(setup).toContain("$_.CategoryInfo.Reason -eq 'NativeCommandError'");
    expect(setup).not.toMatch(/\$sync\.error = \$_\.Exception\.Message/);
  });

  it('tells the operator what docker actually said when a step fails', async () => {
    const setup = await readFile(path.join(repoRoot, 'installer', 'windows', 'KubusNodeSetup.ps1'), 'utf8');
    // "Open Docker Desktop, check that it is running" was shown to an operator
    // while Docker was running and healthy, which made the failure unfixable.
    expect(setup).toMatch(/Select-Object -Last 3/);
    expect(setup).toContain('throw "Docker could not complete this step. $detail"');
    expect(setup).not.toMatch(/throw 'Docker could not complete this step\. Open Docker Desktop/);
  });

  it('does not fail the install because the previous Node was slow to stop', async () => {
    const setup = await readFile(path.join(repoRoot, 'installer', 'windows', 'KubusNodeSetup.ps1'), 'utf8');
    // Upgrading recreates the agent. Compose has been observed returning
    // non-zero having created the new container without starting it, while the
    // old one was still being killed.
    expect(setup).toContain('function Start-NodeRuntime');
    expect(setup).toMatch(/for \(\$attempt = 1; \$attempt -le 3; \$attempt\+\+\)/);
    // The start step must go through the retry, not call compose directly.
    const startStep = setup.indexOf("Set-Step $sync 'start'");
    expect(startStep).toBeGreaterThan(-1);
    const afterStart = setup.slice(startStep, startStep + 200);
    expect(afterStart).toContain('Start-NodeRuntime $sync');
    expect(afterStart).not.toContain("Invoke-NodeCompose @('up', '-d')");
  });

  it('keeps the executable path the image and the npm bin agree on', async () => {
    // `rootDir: "."` is what puts the entry point at dist/src/index.js. If the
    // emit layout ever changes, the Dockerfile CMD and the bin entry both
    // break at runtime rather than at build time, so pin them together here.
    const pkg = JSON.parse(await readFile(path.join(repoRoot, 'package.json'), 'utf8')) as {
      bin: Record<string, string>;
    };
    expect(pkg.bin['kubus-node']).toBe('./dist/src/index.js');

    const dockerfile = await readFile(path.join(repoRoot, 'Dockerfile'), 'utf8');
    expect(dockerfile).toContain('CMD ["node", "dist/src/index.js", "start"]');
  });
});
