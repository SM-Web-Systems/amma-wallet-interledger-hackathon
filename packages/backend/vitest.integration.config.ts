import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/test-integration/**/*.test.ts"],
    testTimeout: 30000,
    hookTimeout: 30000,
    // Load test-only env vars for the config module's startup checks
    env: {
      ...Object.fromEntries(
        require("fs")
          .readFileSync("src/test-integration/.env.integration", "utf8")
          .split("\n")
          .filter((l: string) => l && !l.startsWith("#"))
          .map((l: string) => l.split("=").map((s: string) => s.trim()))
          .map(([k, ...v]: string[]) => [k, v.join("=")])
      ),
      // CI only: the job's throwaway Postgres has a random host port, so the
      // workflow supplies the URL. The harness still validates it (marker,
      // GITHUB_ACTIONS, local host, synthetic db/role/password).
      ...(process.env.AMMA_CI_DISPOSABLE_DB === "1" &&
      process.env.GITHUB_ACTIONS === "true" &&
      process.env.TEST_DATABASE_URL
        ? {
            TEST_DATABASE_URL: process.env.TEST_DATABASE_URL,
            DATABASE_URL: process.env.TEST_DATABASE_URL,
            AMMA_CI_DISPOSABLE_DB: "1",
            GITHUB_ACTIONS: "true",
          }
        : {}),
    },
    // Integration tests must NOT use module mocks — they use real DB
    // Run sequentially to avoid test data races
    // Vitest 4 removed poolOptions.forks.singleFork; run files one at a time instead.
    pool: "forks",
    fileParallelism: false,
  },
});
