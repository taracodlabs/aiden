// Phase 28.4.1 — scope vitest to tracked test directories.
// Excludes vendored native-modules (their own test suites) and the
// legacy v3 regression scripts, which are stale dev artifacts.
import { defineConfig } from 'vitest/config';

// CI runners — especially GitHub's Windows leg — run the full ~5,300-test
// suite on only a few cores. Under that load the Node event loop backs up
// enough that the 5s/10s vitest defaults fire before otherwise-trivial work
// resolves (a two-mkdir hook, an in-process CLI call), producing
// nondeterministic timeout flakes whose victims rotate run-to-run and differ
// by Node version on the same commit. Give the starved loop headroom on CI
// without slowing local dev, where the tight defaults still surface real
// slowness fast. Per-test/per-hook timeouts always override these globals, so
// genuinely long tests keep their explicit budgets and a real hang still
// eventually times out.
const isCI = !!process.env.CI;

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    exclude: [
      '**/node_modules/**',
      'native-modules/**',
      'scripts/test-suite/**',
      'dist/**',
      'dist-bundle/**',
      'release/**',
      '.next/**',
      'dashboard-next/**',
    ],
    testTimeout: isCI ? 20_000 : 5_000,
    hookTimeout: isCI ? 30_000 : 10_000,
  },
});
