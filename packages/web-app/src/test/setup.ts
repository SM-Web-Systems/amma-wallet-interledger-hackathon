import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { afterEach, beforeAll, afterAll } from "vitest";
import { server } from "./msw-server";

// Library tests that opt into `@vitest-environment node` (crypto, IndexedDB,
// local HTTP fixtures) have no DOM, no Web Storage and make their own requests.
const dom = typeof document !== "undefined";
beforeAll(() => { if (dom) server.listen({ onUnhandledRequest: "error" }); });
afterEach(() => {
  if (!dom) return;
  cleanup();
  server.resetHandlers();
  sessionStorage.clear();
});
afterAll(() => { if (dom) server.close(); });
