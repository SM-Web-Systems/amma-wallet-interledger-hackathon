// @vitest-environment node
import { describe, expect, it } from "vitest";
import config from "../../vitest.config";

// G-45: the CI host is slow and shared. A 5 s default made unrelated tests fail on timing alone
// (a Settings test, an admin page test). Fifteen seconds is long enough for a loaded host and short enough to
// still catch a test that is really stuck.
describe("web test timeouts", () => {
  it("allow a slow shared CI host", () => {
    expect(config.test?.testTimeout).toBeGreaterThanOrEqual(15000);
    expect(config.test?.hookTimeout).toBeGreaterThanOrEqual(15000);
  });
});
