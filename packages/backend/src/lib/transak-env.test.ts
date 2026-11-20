import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";
import { transakEnvironment } from "./transak-env";

// G-02 / D-02: no client carries a widget key, and a testnet deployment can only open the staging widget.
describe("transakEnvironment", () => {
  it("is always STAGING on testnet, whatever the setting says", () => {
    expect(transakEnvironment("testnet", "PRODUCTION")).toBe("STAGING");
    expect(transakEnvironment("testnet", "STAGING")).toBe("STAGING");
    expect(transakEnvironment(undefined, "PRODUCTION")).toBe("STAGING");
  });
  it("follows the setting on the public network, and falls back to STAGING for anything unknown", () => {
    expect(transakEnvironment("public", "PRODUCTION")).toBe("PRODUCTION");
    expect(transakEnvironment("public", "STAGING")).toBe("STAGING");
    expect(transakEnvironment("public", "production ")).toBe("STAGING");
    expect(transakEnvironment("public", "")).toBe("STAGING");
  });
});

describe("the server uses it, and no client builds a widget URL with a key", () => {
  const read = (p: string) => readFileSync(join(__dirname, p), "utf-8");
  it("fiat.ts clamps the environment through transakEnvironment", () => {
    const src = read("../routes/fiat.ts");
    expect(src).toContain("transakEnvironment(");
    expect(src).not.toMatch(/environment:\s*config\.transak\.environment\b/);
  });
  it.each([
    ["web", "../../../web-app/src/pages/BuySell.tsx"],
    ["phone", "../../../mobile/app/buy-sell.tsx"],
    ["extension", "../../../chrome-extension/src/popup/pages/BuySell.tsx"],
  ])("%s buy and sell page has no widget key, no production environment and no widget host", (_n, path) => {
    const src = read(path);
    expect(src).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
    expect(src).not.toMatch(/environment:\s*["']PRODUCTION["']/);
    expect(src).not.toContain("global.transak.com");
    expect(src).toContain("transakUrl");
  });
});
