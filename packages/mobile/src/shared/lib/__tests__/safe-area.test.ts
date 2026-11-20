import { describe, it, expect } from "vitest";
import { tabBarMetrics, bottomPad } from "../safe-area";

describe("tabBarMetrics", () => {
  it("keeps the tab buttons above the phone's navigation bar", () => {
    const m = tabBarMetrics(48);
    expect(m.paddingBottom).toBeGreaterThanOrEqual(48);
    // the bar grows by the inset so the icons keep their full height
    expect(m.height).toBe(tabBarMetrics(0).height + 48);
  });

  it("keeps the old size on a phone with no navigation bar", () => {
    const m = tabBarMetrics(0);
    expect(m.height).toBe(60);
    expect(m.paddingBottom).toBe(8);
  });

  it("ignores a missing or negative inset", () => {
    expect(tabBarMetrics(undefined as unknown as number).height).toBe(60);
    expect(tabBarMetrics(-5).height).toBe(60);
  });
});

describe("bottomPad", () => {
  it("adds the navigation bar height under scrolling content", () => {
    expect(bottomPad(48)).toBe(48 + 24);
    expect(bottomPad(0)).toBe(24);
  });
});
