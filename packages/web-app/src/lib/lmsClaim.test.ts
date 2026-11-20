// @vitest-environment node
import { describe, it, expect } from "vitest";
import { Keypair } from "@stellar/stellar-sdk";
import { parseLmsClaim, stroopsToXlm, allowedReturn, signLmsClaim, claimNetworkCheck, LMS_CLAIM_PREFIX } from "./lmsClaim";

const address = Keypair.random().publicKey();
const expires = new Date(Date.now() + 60_000).toISOString();
const msg = (over: Partial<Record<string, string>> = {}) => [
  over.prefix ?? LMS_CLAIM_PREFIX,
  `claim:${over.claim ?? "0c6b7a3e-1d2f-4a5b-8c9d-0e1f2a3b4c5d"}`,
  `destination:${over.destination ?? address}`,
  `amount_stroops:${over.amount ?? "1000000"}`,
  `expires:${over.expires ?? expires}`,
  `nonce:${over.nonce ?? "a".repeat(64)}`,
].join("\n");

describe("parseLmsClaim", () => {
  it("reads every field of a valid challenge", () => {
    const c = parseLmsClaim(msg());
    expect(c.destination).toBe(address);
    expect(c.amountStroops).toBe(1_000_000n);
    expect(c.expiresAt.toISOString()).toBe(expires);
  });
  it.each([
    ["another prefix", msg({ prefix: "Pay me" })],
    ["an extra line", msg() + "\nextra:1"],
    ["a dashes-only claim id", msg({ claim: "-".repeat(36) })],
    ["a misplaced-dash claim id", msg({ claim: "0c6b7a3e1-d2f-4a5b-8c9d-0e1f2a3b4c5d" })],
    ["an expiry more than 24 hours ahead", msg({ expires: new Date(Date.now() + 25 * 3600_000).toISOString() })],
    ["a bad address", msg({ destination: "GNOTVALID" })],
    ["a zero amount", msg({ amount: "0" })],
    ["a short nonce", msg({ nonce: "abc" })],
  ])("refuses %s", (_name, message) => expect(() => parseLmsClaim(message)).toThrow());
  it("accepts an expiry just under 24 hours ahead", () => {
    expect(() => parseLmsClaim(msg({ expires: new Date(Date.now() + 23 * 3600_000).toISOString() }))).not.toThrow();
  });
  it("refuses an expired challenge", () => {
    expect(() => parseLmsClaim(msg({ expires: new Date(Date.now() - 1000).toISOString() }))).toThrow(/expired/);
  });
});

describe("claim network (optional signed line, display label)", () => {
  it("keeps accepting today's 6-line format and reports no signed network", () => {
    expect(parseLmsClaim(msg()).network).toBeUndefined();
  });
  it.each(["mainnet", "testnet"] as const)("reads an optional trailing network:%s line", (n) => {
    expect(parseLmsClaim(msg() + `\nnetwork:${n}`).network).toBe(n);
  });
  it.each(["network:", "network:public", "network:MAINNET", "network:mainnet ", "net:mainnet"])("refuses a malformed 7th line %j", (line) => {
    expect(() => parseLmsClaim(msg() + "\n" + line)).toThrow();
  });
  it("refuses an 8th line", () => {
    expect(() => parseLmsClaim(msg() + "\nnetwork:mainnet\nextra:1")).toThrow();
  });
  it("labels the configured network and flags no mismatch when the claim does not name one", () => {
    expect(claimNetworkCheck("public")).toEqual({ label: "Mainnet", mismatch: false });
    expect(claimNetworkCheck("testnet")).toEqual({ label: "Testnet", mismatch: false });
  });
  it("cross-checks a signed network against the configured one", () => {
    expect(claimNetworkCheck("public", "mainnet")).toEqual({ label: "Mainnet", mismatch: false });
    expect(claimNetworkCheck("testnet", "testnet")).toEqual({ label: "Testnet", mismatch: false });
    expect(claimNetworkCheck("public", "testnet")).toEqual({ label: "Mainnet", mismatch: true, signedLabel: "Testnet" });
    expect(claimNetworkCheck("testnet", "mainnet")).toEqual({ label: "Testnet", mismatch: true, signedLabel: "Mainnet" });
  });
});

describe("stroopsToXlm", () => {
  it.each([[1_000_000n, "0.1"], [10_000_000n, "1"], [12_345_678n, "1.2345678"]])("%s stroops is %s XLM", (s, x) => expect(stroopsToXlm(s)).toBe(x));
});

describe("allowedReturn", () => {
  it("accepts the LMS origin", () => expect(allowedReturn("https://lms.smwebsystems.com/student/rewards/claim").pathname).toBe("/student/rewards/claim"));
  it("accepts exactly the LMS mobile app return address", () => expect(allowedReturn("lmsmobile://reward-claim").protocol).toBe("lmsmobile:"));
  it.each(["lmsmobile://reward-claim/x", "lmsmobile://reward-claim?x=1", "lmsmobile://reward-claim#a", "lmsmobile://sso-callback", "lmsmobile://reward-claim.evil.example", "lmsmobile://u:p@reward-claim", "myapp://reward-claim", "https://evil.example/x", "http://lms.smwebsystems.com/x", "https://user:pw@lms.smwebsystems.com/x", "not a url"])("refuses %s", (u) => expect(() => allowedReturn(u)).toThrow());
});

describe("signLmsClaim", () => {
  it("signs the exact text with the destination's key", async () => {
    const kp = Keypair.random();
    const m = msg({ destination: kp.publicKey() });
    const sig = await signLmsClaim(m, [{ publicKey: kp.publicKey(), encryptedSecret: "enc" }], "pin", async () => kp.secret(), (s) => Keypair.fromSecret(s));
    expect(kp.verify(Buffer.from(m, "utf8"), Buffer.from(sig, "base64"))).toBe(true);
    expect(sig).toMatch(/^[A-Za-z0-9+/]{86}==$/);
  });
  it("uses the key from this device's keystore when the account record has none (self-custody)", async () => {
    const kp = Keypair.random();
    const m = msg({ destination: kp.publicKey() });
    const decrypt = async (enc: string) => { expect(enc).toBe("from-keystore"); return kp.secret(); };
    const sig = await signLmsClaim(m, [{ publicKey: kp.publicKey(), encryptedSecret: "" }], "pin", decrypt, (s) => Keypair.fromSecret(s),
      async (pk) => (pk === kp.publicKey() ? "from-keystore" : null));
    expect(kp.verify(Buffer.from(m, "utf8"), Buffer.from(sig, "base64"))).toBe(true);
  });
  it("asks to restore the wallet when neither the record nor the keystore has the key", async () => {
    const kp = Keypair.random();
    await expect(signLmsClaim(msg({ destination: kp.publicKey() }), [{ publicKey: kp.publicKey(), encryptedSecret: "" }], "pin", async () => "", (s) => Keypair.fromSecret(s), async () => null))
      .rejects.toThrow(/Restore this Stellar wallet/);
  });
  it("refuses when the destination wallet is not on this device", async () => {
    await expect(signLmsClaim(msg(), [], "pin", async () => "", (s) => Keypair.fromSecret(s))).rejects.toThrow(/not on this device/);
  });
  it("refuses when the decrypted key belongs to another address", async () => {
    const other = Keypair.random();
    await expect(signLmsClaim(msg(), [{ publicKey: address, encryptedSecret: "enc" }], "pin", async () => other.secret(), (s) => Keypair.fromSecret(s))).rejects.toThrow(/does not match/);
  });
});

describe("app return fragment", () => {
  it("keeps the fragment when the signature is attached to the app return address", () => {
    const back = allowedReturn("lmsmobile://reward-claim");
    const url = new URL(back.toString());
    url.hash = new URLSearchParams({ claim: "c-1", signature: "x" }).toString();
    expect(url.toString()).toBe("lmsmobile://reward-claim#claim=c-1&signature=x");
  });
});

describe("signLmsClaim and a wallet whose backup is not confirmed", () => {
  it("refuses to sign for a new wallet until its secret key is confirmed saved", async () => {
    const kp = Keypair.random();
    const m = msg({ destination: kp.publicKey() });
    const wallet = { publicKey: kp.publicKey(), encryptedSecret: "enc", backupPending: true };
    await expect(signLmsClaim(m, [wallet], "pin", async () => kp.secret(), (s) => Keypair.fromSecret(s))).rejects.toThrow(/secret key/i);
    await expect(signLmsClaim(m, [{ ...wallet, backupPending: undefined }], "pin", async () => kp.secret(), (s) => Keypair.fromSecret(s))).resolves.toBeTruthy();
  });
});
