// Phase 28.4.1 — scope vitest to tracked test directories.
// Excludes vendored native-modules (their own test suites) and the
// legacy v3 regression scripts, which are stale dev artifacts.
import { defineConfig } from 'vitest/config';

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
  },
});
