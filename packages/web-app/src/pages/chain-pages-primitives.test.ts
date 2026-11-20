// TODO C9: the XRP and Ethereum pages use the shared UI primitives
// (ui-card, ui-field, ui-btn-*, ui-segment, ui-alert-*) instead of their own
// class strings, so they follow the theme like the rest of the wallet.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const FILES = ["pages/XrpWallet.tsx", "pages/EvmWallet.tsx", "components/XrpPayment.tsx"];
const read = (file: string) => readFileSync(resolve(__dirname, "..", file), "utf8");

describe.each(FILES)("%s", (file) => {
  const src = read(file);

  it("has no page-local input or button class strings", () => {
    expect(src).not.toMatch(/const (inputStyle|buttonStyle) =/);
    expect(src).not.toContain("bg-stellar-blue px-4 py-2");
  });

  it("uses the shared field, button and card primitives", () => {
    expect(src).toContain("ui-field");
    expect(src).toMatch(/ui-btn-(primary|secondary)/);
    expect(src).toContain("ui-card");
  });

  it("has no colours that only work on a dark background", () => {
    expect(src.match(/(?<!dark:)\btext-(violet|red|green)-300\b/g) ?? []).toEqual([]);
    expect(src.match(/(?<!dark:)\btext-amber-200\b/g) ?? []).toEqual([]);
    expect(src.match(/\bbg-(red|yellow)-900\//g) ?? []).toEqual([]);
  });
});

describe("create or restore is a segmented control on both chain pages", () => {
  it.each(["pages/XrpWallet.tsx", "pages/EvmWallet.tsx"])("%s", (file) => {
    const src = read(file);
    expect(src).toMatch(/role="group" aria-label="Create or restore" className="ui-segment"/);
    expect(src).toContain('className="ui-segment-item"');
    expect(src).toContain("aria-pressed={mode === value}");
  });
});
