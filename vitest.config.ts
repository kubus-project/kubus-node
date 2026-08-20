import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // `tsconfig.json` includes `tests/**/*.ts`, so `npm run build` emits a
    // compiled copy of every test into `dist/`. Without this exclusion vitest
    // discovers both copies and runs the whole suite twice — and the stale
    // compiled copies fail for reasons that have nothing to do with the code
    // under test (`dist/tests/env.test.js` reads `../.env.example`, which is
    // never copied into `dist/`). Only the TypeScript sources are the suite.
    include: ['tests/**/*.test.ts'],
    exclude: ['dist/**', 'node_modules/**'],
  },
});
