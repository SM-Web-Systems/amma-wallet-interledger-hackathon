import { describe, it, expect } from "vitest";
import { deriveAllChains, generatePhrase, isValidPhrase, ONE_PHRASE_PATHS } from "./one-phrase";

const PHRASE = "illness spike retreat truth genius clock brain pass fit cave bargain toe";
// Public addresses from the web app's one-phrase module for PHRASE (not secrets).
const STELLAR = "GDRXE2BQUC3AZNPVFSCEZ76NJ3WWL25FYFK6RGZGIEKWE4SOOHSUJUJ6";
const XRPL = "rHfsP8wmWDEvSvBZu4VsF9BUB6wqXDo4xU";
const EVM = "0x6b30c7d7657A83141186Cd8c155CDB90C8750371";

describe("one-phrase derivation", () => {
  it("matches the web app's addresses", () => {
    const c = deriveAllChains(PHRASE);
    expect(c.stellar.publicKey).toBe(STELLAR);
    expect(c.xrpl.address).toBe(XRPL);
    expect(c.evm.address).toBe(EVM);
  });
  it("keeps the derivation paths", () => {
    expect(ONE_PHRASE_PATHS).toEqual({ stellar: "m/44'/148'/i'", xrpl: "m/44'/144'/0'/0/i", evm: "m/44'/60'/0'/0/i" });
  });
  it("accepts messy input", () => {
    const c = deriveAllChains(`  ${PHRASE.toUpperCase().replace(/ /g, "   ")}\n`);
    expect([c.stellar.publicKey, c.xrpl.address, c.evm.address]).toEqual([STELLAR, XRPL, EVM]);
  });
  it("secrets come out only through functions and are well-formed", () => {
    const c = deriveAllChains(PHRASE);
    expect(c.stellar.secret()).toMatch(/^S[A-Z2-7]{55}$/);
    expect(c.evm.privateKey()).toMatch(/^0x[0-9a-f]{64}$/);
    const x = c.xrpl.seed();
    expect(x.publicKey).toBeTruthy();
    expect(x.privateKey).toBeTruthy();
    const json = JSON.stringify(c);
    expect(json).not.toContain(c.stellar.secret());
    expect(json).not.toContain(c.evm.privateKey().slice(2));
    expect(json).not.toContain(x.privateKey);
    expect(json).not.toContain(PHRASE);
  });
  it("derives other accounts by index, pinned to the web app's index 1", () => {
    const c = deriveAllChains(PHRASE, 1);
    expect(c.stellar.publicKey).toBe("GBAW5XGWORWVFE2XTJYDTLDHXTY2Q2MO73HYCGB3XMFMQ562Q2W2GJQX");
    expect(c.evm.address).toBe("0x754c39C8836A546e7CF6A2f099033fCB6675e63f");
  });
  it("derives XRP accounts by index; index 0 is unchanged and index 1 is pinned", () => {
    expect(deriveAllChains(PHRASE, 0).xrpl.address).toBe(XRPL);
    const one = deriveAllChains(PHRASE, 1).xrpl.address;
    expect(one).toBe("r9bkRJWPTqRLcspp4m6AuugasybUYMusNu");
    expect(one).not.toBe(XRPL);
    expect(deriveAllChains(PHRASE, 2).xrpl.address).not.toBe(one);
  });
  it.each([-1, 1.5, NaN, 2 ** 31, Infinity])("rejects account number %s without echoing it", (i) => {
    let msg = "";
    try { deriveAllChains(PHRASE, i); } catch (e) { msg = (e as Error).message; }
    expect(msg).toBe("The account number is not valid.");
    expect(msg).not.toContain("illness");
  });
  it("accepts the largest account number", () => {
    expect(() => deriveAllChains(PHRASE, 2 ** 31 - 1)).not.toThrow();
  });
  it("rejects an invalid phrase without echoing its words", () => {
    const bad = "zebra zebra zebra zebra zebra zebra zebra zebra zebra zebra zebra zebra";
    let msg = "";
    try { deriveAllChains(bad); } catch (e) { msg = (e as Error).message; }
    expect(msg).toBe("This recovery phrase is not valid.");
    expect(msg).not.toContain("zebra");
    expect(isValidPhrase(bad)).toBe(false);
    expect(isValidPhrase("")).toBe(false);
  });
  it("generates 12 valid, different phrases", () => {
    const a = generatePhrase(), b = generatePhrase();
    expect(a.split(" ")).toHaveLength(12);
    expect(isValidPhrase(a)).toBe(true);
    expect(a).not.toBe(b);
  });
});
