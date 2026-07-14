// Phase 28.4.1 — scope vitest to tracked test directories.
// Excludes vendored native-modules (their own test suites) and the
// legacy v3 regression scripts, which are stale dev artifacts.
import { defineConfig } from 'vitest/config';

// Full-suite workers contend for the same event loop, filesystem, and terminal
// resources even on a local workstation. Under that load the 5s/10s defaults
// produce rotating timeout victims in otherwise-fast tests. Keep one realistic
// budget everywhere so a focused run and a full run use the same contract.
// Per-test/per-hook timeouts still override these globals.
//
// Windows pseudo-terminal helpers also share console infrastructure outside the
// worker process. Capping file workers prevents unrelated suites from starving
// input delivery without serializing the entire repository.
const windowsWorkerLimit = process.platform === 'win32' ? 4 : undefined;

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
    testTimeout: 20_000,
    hookTimeout: 30_000,
    maxWorkers: windowsWorkerLimit,
  },
});
