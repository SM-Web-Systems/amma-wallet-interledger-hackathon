// @vitest-environment node
import { describe, it, expect } from "vitest";
import { deriveAllChains, ONE_PHRASE_PATHS } from "./one-phrase";

// SEP-0005 test vector 1 (Stellar), and the well-known Hardhat test phrase (Ethereum m/44'/60'/0'/0/0).
const SEP5_PHRASE = "illness spike retreat truth genius clock brain pass fit cave bargain toe";
const SEP5_ACCOUNT_0 = "GDRXE2BQUC3AZNPVFSCEZ76NJ3WWL25FYFK6RGZGIEKWE4SOOHSUJUJ6";
const SEP5_ACCOUNT_1 = "GBAW5XGWORWVFE2XTJYDTLDHXTY2Q2MO73HYCGB3XMFMQ562Q2W2GJQX";
const HARDHAT_PHRASE = "test test test test test test test test test test test junk";
const HARDHAT_ACCOUNT_0 = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";

describe("one phrase, three chains", () => {
  it("derives Stellar on the SEP-0005 path (known vector)", () => {
    const a = deriveAllChains(SEP5_PHRASE);
    expect(a.stellar.publicKey).toBe(SEP5_ACCOUNT_0);
    expect(deriveAllChains(SEP5_PHRASE, 1).stellar.publicKey).toBe(SEP5_ACCOUNT_1);
  });

  it("derives Ethereum on m/44'/60'/0'/0/i (known vector)", () => {
    expect(deriveAllChains(HARDHAT_PHRASE).evm.address).toBe(HARDHAT_ACCOUNT_0);
  });

  it("derives XRP on m/44'/144'/0'/0/0 (the published address for the all-abandon phrase)", () => {
    const abandon = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
    expect(deriveAllChains(abandon).xrpl.address).toBe("rHsMGQEkVNJmpGWs8XUBoTBiAAbwxZN5v3");
    // Pinned so the derivation cannot change quietly.
    expect(deriveAllChains(SEP5_PHRASE).xrpl.address).toBe("rHfsP8wmWDEvSvBZu4VsF9BUB6wqXDo4xU");
  });

  it("lists the paths so they cannot drift quietly", () => {
    expect(ONE_PHRASE_PATHS).toEqual({
      stellar: "m/44'/148'/i'",
      xrpl: "m/44'/144'/0'/0/0",
      evm: "m/44'/60'/0'/0/i",
    });
  });

  it("accepts capitals and extra spaces in a pasted phrase", () => {
    const messy = `  ${SEP5_PHRASE.toUpperCase().replace(/ /g, "  ")}\n`;
    expect(deriveAllChains(messy).stellar.publicKey).toBe(SEP5_ACCOUNT_0);
  });

  it("refuses a phrase that is not valid, without echoing it", () => {
    expect(() => deriveAllChains("not a real phrase at all")).toThrow(/not valid/i);
    try { deriveAllChains("not a real phrase at all"); } catch (e) { expect(String(e)).not.toContain("real phrase"); }
  });

  it("hands out secrets only through explicit accessors, never in the summary", () => {
    const a = deriveAllChains(SEP5_PHRASE);
    expect(JSON.stringify(a)).not.toMatch(/"S[A-Z2-7]{55}"/);
    expect(a.stellar.secretKey()).toMatch(/^S[A-Z2-7]{55}$/);
  });
});
