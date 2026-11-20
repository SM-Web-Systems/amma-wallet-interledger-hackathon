import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const app = (f: string) => readFileSync(join(__dirname, "../../../../app", f), "utf8");

describe("screens leave room for the phone's bottom bar", () => {
  it("sizes the tab bar from the bottom inset", () => {
    const src = app("(tabs)/_layout.tsx");
    expect(src).toContain("useSafeAreaInsets");
    expect(src).toContain("tabBarMetrics(insets.bottom)");
    expect(src).not.toMatch(/height:\s*60/);
  });

  it.each([
    "settings.tsx",
    "history.tsx",
    "portfolio.tsx",
    "token-detail.tsx",
    "buy-sell.tsx",
    "earn.tsx",
    "contacts.tsx",
  ])("%s pads the end of its list by the bottom inset", (f) => {
    const src = app(f);
    expect(src).toContain("useSafeAreaInsets");
    expect(src).toContain("bottomPad(insets.bottom)");
  });
});
