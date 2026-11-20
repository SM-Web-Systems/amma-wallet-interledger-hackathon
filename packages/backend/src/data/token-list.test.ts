import { describe, it, expect } from "vitest";
import { createHash } from "crypto";
import tokenList from "./token-list.json";

// sha256 of JSON.stringify(list.mainnet) at the time the testnet list was trimmed.
// If this fails, the mainnet section changed: confirm that was intended, then update the pin.
const MAINNET_SHA256 = "8f3b1f72e01dba6397fc22675a2ad6b671ee7d1bd1a3d2dba2d29f994876da9a";
const MAINNET_COUNT = 24;

describe("token-list.json testnet section", () => {
  it("lists exactly XLM, USDC, EURC and ZARC", () => {
    expect(tokenList.testnet.map((t) => t.code)).toEqual(["XLM", "USDC", "EURC", "ZARC"]);
  });

  it("ZARC is the public testnet stablecoin with the expected issuer and category", () => {
    const zarc = tokenList.testnet.find((t) => t.code === "ZARC");
    expect(zarc).toBeDefined();
    expect(zarc!.issuer).toBe("GAHNPU23UZS7UWWWOXR2VFNONQDVAKWDIHPONE4EIADOQL7XUFILNEMC");
    expect(zarc!.name).toBe("ZARC (Testnet)");
    expect(zarc!.domain).toBe("ammawallet.com");
    expect(zarc!.verified).toBe(true);
    expect(zarc!.category).toBe("test-stablecoin");
  });

  it("documents test-stablecoin in the schema category list", () => {
    expect(tokenList.schema.category).toContain("test-stablecoin");
  });
});

describe("token-list.json mainnet section is unchanged", () => {
  it("has 24 entries", () => {
    expect(tokenList.mainnet).toHaveLength(MAINNET_COUNT);
  });

  it("matches the pinned sha256 snapshot", () => {
    const hash = createHash("sha256").update(JSON.stringify(tokenList.mainnet)).digest("hex");
    expect(hash).toBe(MAINNET_SHA256);
  });
});
