import { defineConfig, devices } from "@playwright/test";

/**
 * Visual smoke test (audit TODO C13): renders the key wallet pages against a mocked API
 * in light and dark, on desktop and phone, and fails on page errors, missing content
 * or horizontal scrolling. Screenshots go to test-results/visual for review in CI.
 *
 * Needs no backend: every /api call is answered by e2e-visual/mock-api.ts and every
 * other host is blocked, so nothing leaves the machine.
 *
 * Run: npm run test:visual
 */
// Several CI runners share one machine, so CI passes a free port in VISUAL_PORT; 4179 is the local default.
const PORT = Number(process.env.VISUAL_PORT) || 4179;

export default defineConfig({
  testDir: "./e2e-visual",
  outputDir: "test-results/visual-output",
  forbidOnly: !!process.env.CI,
  retries: 0,
  workers: process.env.CI ? 2 : undefined,
  reporter: [["list"]],
  timeout: 45_000,
  use: {
    baseURL: `http://localhost:${PORT}`,
    trace: "off",
    screenshot: "off",
    // Lets a sandbox use a preinstalled Chromium; CI uses the one `playwright install` fetches.
    launchOptions: process.env.PW_CHROMIUM_PATH ? { executablePath: process.env.PW_CHROMIUM_PATH } : {},
  },
  projects: [
    { name: "desktop", use: { ...devices["Desktop Chrome"], viewport: { width: 1280, height: 900 } } },
    { name: "phone", use: { ...devices["Pixel 5"] } },
  ],
  // Serve a production build, not the dev server: the dev server optimises dependencies on
  // the first request and reloads the page, which raced the first tests on a cold CI runner.
  // This also tests the bundle that actually ships.
  webServer: {
    command: `npx vite build --outDir dist-visual --emptyOutDir && npx vite preview --outDir dist-visual --port ${PORT} --strictPort`,
    url: `http://localhost:${PORT}`,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
    env: { VITE_XRPL_ENABLED: "true", VITE_EVM_ENABLED: "true", VITE_API_URL: "" },
  },
});
