import { describe, expect, it } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";

// G-45: both backend vitest configs (whichever one the runner picks) must allow a slow shared CI host.
// Read as text because the configs sit outside the compiled source tree.
describe("backend test timeouts", () => {
  for (const name of ["vitest.config.ts", "vitest.config.mjs"]) {
    it(`${name} allows a slow shared CI host`, () => {
      const text = readFileSync(resolve(__dirname, "../..", name), "utf8");
      const seconds = (key: string) => Number(new RegExp(`${key}:\\s*(\\d+)`).exec(text)?.[1]);
      expect(seconds("testTimeout")).toBeGreaterThanOrEqual(15000);
      expect(seconds("hookTimeout")).toBeGreaterThanOrEqual(15000);
    });
  }
});
