import { defineConfig } from "vitest/config";
import path from "path";

// Kept apart from vite.config.ts so tests do not load the crx/Tailwind build plugins.
export default defineConfig({
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "src/shared"),
      "@popup": path.resolve(__dirname, "src/popup"),
    },
  },
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    setupFiles: ["src/test/setup.ts"],
  },
});
