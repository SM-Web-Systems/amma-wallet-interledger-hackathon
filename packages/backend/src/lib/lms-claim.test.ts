import { describe, it, expect } from "vitest";
import { Keypair } from "@stellar/stellar-sdk";
import { parseLmsClaim, LmsClaimExpired, LMS_CLAIM_PREFIX } from "./lms-claim";

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

describe("parseLmsClaim (server)", () => {
  it("reads every field of a valid challenge", () => {
    const c = parseLmsClaim(msg());
    expect(c).toMatchObject({ claimId: "0c6b7a3e-1d2f-4a5b-8c9d-0e1f2a3b4c5d", destination: address, amountStroops: 1_000_000n });
    expect(c.expiresAt.toISOString()).toBe(expires);
  });
  it.each([
    ["another prefix", msg({ prefix: "Pay me" })],
    ["an extra line", msg() + "\nextra:1"],
    ["a missing line", msg().split("\n").slice(0, 5).join("\n")],
    ["a bad claim id", msg({ claim: "not-a-uuid" })],
    ["a dashes-only claim id", msg({ claim: "-".repeat(36) })],
    ["a misplaced-dash claim id", msg({ claim: "0c6b7a3e1-d2f-4a5b-8c9d-0e1f2a3b4c5d" })],
    ["an expiry more than 24 hours ahead", msg({ expires: new Date(Date.now() + 25 * 3600_000).toISOString() })],
    ["a bad address", msg({ destination: "GNOTVALID" })],
    ["a zero amount", msg({ amount: "0" })],
    ["a leading-zero amount", msg({ amount: "01" })],
    ["a 17-digit amount", msg({ amount: "1".repeat(17) })],
    ["a short nonce", msg({ nonce: "abc" })],
    ["a non-canonical date", msg({ expires: "2999-01-01" })],
    ["swapped field names", msg().replace("claim:", "claimx:")],
    ["CRLF line endings", msg().replace(/\n/g, "\r\n")],
  ])("refuses %s", (_name, message) => expect(() => parseLmsClaim(message)).toThrow());
  it("accepts an expiry just under 24 hours ahead", () => {
    expect(() => parseLmsClaim(msg({ expires: new Date(Date.now() + 23 * 3600_000).toISOString() }))).not.toThrow();
  });
  it("refuses an expired challenge", () => {
    expect(() => parseLmsClaim(msg({ expires: new Date(Date.now() - 1000).toISOString() }))).toThrow(/expired/);
  });
});

describe("parseLmsClaim (server): expiry is a typed error", () => {
  it("throws LmsClaimExpired when the claim is well formed but expired", () => {
    expect(() => parseLmsClaim(msg({ expires: new Date(Date.now() - 1000).toISOString() }))).toThrow(LmsClaimExpired);
  });
  it.each([["bad prefix", msg({ prefix: "Pay me" })], ["bad address", msg({ destination: "GNOTVALID" })], ["too far ahead", msg({ expires: new Date(Date.now() + 25 * 3600_000).toISOString() })]])("does not mark %s as expired", (_n, m) => {
    try { parseLmsClaim(m); throw new Error("no throw"); } catch (e) { expect(e).not.toBeInstanceOf(LmsClaimExpired); }
  });
});

describe("parseLmsClaim (server): optional network line", () => {
  it("keeps accepting today's 6-line text with no network", () => {
    expect(parseLmsClaim(msg()).network).toBeUndefined();
  });
  it.each(["mainnet", "testnet"] as const)("reads a trailing network:%s line", (n) => {
    expect(parseLmsClaim(msg() + `\nnetwork:${n}`).network).toBe(n);
  });
  it.each(["network:", "network:public", "network:MAINNET", "network:mainnet ", "net:mainnet"])("refuses a malformed 7th line %j", (line) => {
    expect(() => parseLmsClaim(msg() + "\n" + line)).toThrow();
  });
  it("refuses an 8th line", () => {
    expect(() => parseLmsClaim(msg() + "\nnetwork:mainnet\nextra:1")).toThrow();
  });
});
