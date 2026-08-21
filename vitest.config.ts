import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Only the TypeScript sources are the suite. `dist/` is excluded as a
    // guard rather than a fix: the emit config no longer compiles `tests/`
    // at all, and `tests/packaging.test.ts` holds that line, but a stray
    // build output must never be able to turn into a second, stale suite.
    include: ['tests/**/*.test.ts'],
    exclude: ['dist/**', 'node_modules/**'],
  },
});
