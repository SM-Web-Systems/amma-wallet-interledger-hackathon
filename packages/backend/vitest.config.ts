import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // The CI host is slow and shared; 5 s made unrelated tests fail on timing alone (G-45).
    testTimeout: 15000,
    // Local full runs only: CI passes --maxWorkers=1 and --hookTimeout=30000 on the command line, which override these two.
    // PGlite starts a WASM database in beforeAll/beforeEach; under a full parallel run that took 15-29 s (T-01).
    hookTimeout: 60000,
    maxWorkers: 4,
    exclude: [
      "**/node_modules/**",
      "**/test-integration/**",
    ],
  },
});
