import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  test: {
    environment: "jsdom",
    setupFiles: ["./src/test/setup.ts"],
    globals: true,
    css: false,
    // The CI host is slow and shared; 5 s made unrelated tests fail on timing alone (G-45).
    testTimeout: 15000,
    hookTimeout: 15000,
    // Under a full run on a loaded host, starting many forks at once timed out
    // ("Failed to start forks worker"; T-01). A fixed cap keeps start-up inside the limit.
    maxWorkers: 4,
    teardownTimeout: 30000,
    include: ["src/**/*.test.{ts,tsx}"],
    exclude: ["e2e/**", "node_modules/**"],
  },
});
