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
