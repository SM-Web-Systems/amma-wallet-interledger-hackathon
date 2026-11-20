import * as StellarSdk from "@stellar/stellar-sdk";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { kp, horizon } = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const sdk = require("@stellar/stellar-sdk") as typeof import("@stellar/stellar-sdk");
  return {
    kp: sdk.Keypair.random(),
    horizon: { loadAccount: vi.fn(), strictSendPaths: vi.fn(), submitTransaction: vi.fn() },
  };
});
const issuer = StellarSdk.Keypair.random().publicKey();

vi.mock("../config", () => ({ config: { PLATFORM_WALLET: kp.publicKey(), PLATFORM_SECRET: kp.secret() } }));
vi.mock("./stellar-client", () => ({
  stellarClient: { horizon, networkPassphrase: "Test SDF Network ; September 2015" },
}));

import { cleanupEmptyTrustlines, liquifyPlatformFees } from "./liquifier";

const pool = { asset_type: "liquidity_pool_shares", liquidity_pool_id: "ab".repeat(32), balance: "5.0000000" };
const usdc = (balance: string, selling_liabilities = "0.0000000") => ({ asset_type: "credit_alphanum4", asset_code: "USDC", asset_issuer: issuer, balance, selling_liabilities });
const eurc = (balance: string) => ({ asset_type: "credit_alphanum4", asset_code: "EURC", asset_issuer: issuer, balance, selling_liabilities: "0.0000000" });
const account = (balances: any[]) => Object.assign(new StellarSdk.Account(kp.publicKey(), "100"), { balances });

beforeEach(() => {
  vi.clearAllMocks();
  horizon.strictSendPaths.mockReturnValue({ call: async () => ({ records: [{ destination_amount: "10.0000000", path: [] }] }) });
  horizon.submitTransaction.mockResolvedValue({ hash: "f".repeat(64) });
});

describe("liquifyPlatformFees", () => {
  it("skips liquidity-pool shares and still converts the other tokens", async () => {
    horizon.loadAccount.mockImplementation(async () => account([pool, usdc("2.5000000"), { asset_type: "native", balance: "100" }]));
    const out = await liquifyPlatformFees();
    expect(out.errors).toEqual([]);
    expect(out.converted).toHaveLength(1);
    expect(horizon.submitTransaction).toHaveBeenCalledTimes(1);
  });

  it("sends the whole token balance to itself with a 2% floor under the best quote, signed by the platform key", async () => {
    horizon.loadAccount.mockImplementation(async () => account([usdc("2.5000000")]));
    const logs = vi.spyOn(console, "log").mockImplementation(() => {});
    await liquifyPlatformFees();
    const tx = horizon.submitTransaction.mock.calls[0][0] as StellarSdk.Transaction;
    const op = tx.operations[0] as StellarSdk.Operation.PathPaymentStrictSend;
    expect(op.type).toBe("pathPaymentStrictSend");
    expect(op.sendAmount).toBe("2.5000000");
    expect(op.destination).toBe(kp.publicKey());
    expect(op.destMin).toBe("9.8000000");
    expect(tx.signatures).toHaveLength(1);
    expect(JSON.stringify(logs.mock.calls)).not.toContain(kp.secret());
    logs.mockRestore();
  });
});

describe("liquifyPlatformFees sells only what is free", () => {
  const sent = () => horizon.submitTransaction.mock.calls.map((c) => (c[0] as StellarSdk.Transaction).operations[0] as StellarSdk.Operation.PathPaymentStrictSend);

  it("sells balance minus selling liabilities (and quotes that amount)", async () => {
    horizon.loadAccount.mockImplementation(async () => account([usdc("2.5000000", "1.0000000")]));
    await liquifyPlatformFees({});
    expect(sent()[0].sendAmount).toBe("1.5000000");
    expect(horizon.strictSendPaths.mock.calls[0][1]).toBe("1.5000000");
  });

  it("skips a token whose whole balance is locked in open offers", async () => {
    horizon.loadAccount.mockImplementation(async () => account([usdc("2.5000000", "2.5000000")]));
    const out = await liquifyPlatformFees({});
    expect(horizon.submitTransaction).not.toHaveBeenCalled();
    expect(out.converted).toEqual([]);
    expect(out.skipped.join()).toContain("USDC");
  });

  it("with PLATFORM_LIQUIFIER_ASSETS set, sells only the listed CODE:ISSUER tokens", async () => {
    horizon.loadAccount.mockImplementation(async () => account([usdc("2.0000000"), eurc("3.0000000")]));
    const out = await liquifyPlatformFees({ PLATFORM_LIQUIFIER_ASSETS: ` EURC:${issuer} , ` });
    expect(sent().map((o) => o.sendAsset.getCode())).toEqual(["EURC"]);
    expect(out.converted.map((c) => [c.code, c.issuer])).toEqual([["EURC", issuer]]);
    expect(out.skipped.join()).toContain("USDC");
  });

  it("an allowlist entry with another issuer does not match", async () => {
    horizon.loadAccount.mockImplementation(async () => account([usdc("2.0000000")]));
    await liquifyPlatformFees({ PLATFORM_LIQUIFIER_ASSETS: `USDC:${kp.publicKey()}` });
    expect(horizon.submitTransaction).not.toHaveBeenCalled();
  });

  it("unset or empty allowlist sells every free token, as before", async () => {
    horizon.loadAccount.mockImplementation(async () => account([usdc("2.0000000"), eurc("3.0000000")]));
    await liquifyPlatformFees({ PLATFORM_LIQUIFIER_ASSETS: "" });
    expect(sent().map((o) => o.sendAsset.getCode())).toEqual(["USDC", "EURC"]);
  });
});

describe("cleanupEmptyTrustlines", () => {
  const changed = () => horizon.submitTransaction.mock.calls.map((c) => ((c[0] as StellarSdk.Transaction).operations[0] as StellarSdk.Operation.ChangeTrust).line as StellarSdk.Asset);

  it("removes only empty trustlines of the assets this run converted, not other empty ones", async () => {
    horizon.loadAccount.mockImplementation(async () => account([usdc("0.0000000"), eurc("0.0000000")]));
    const removed = await cleanupEmptyTrustlines([{ code: "USDC", issuer }]);
    expect(removed).toEqual(["USDC"]);
    expect(changed().map((a) => a.getCode())).toEqual(["USDC"]);
  });

  it("does nothing (no Horizon call) when nothing was converted", async () => {
    expect(await cleanupEmptyTrustlines([])).toEqual([]);
    expect(horizon.loadAccount).not.toHaveBeenCalled();
  });

  it("keeps a converted asset's trustline when it is not empty", async () => {
    horizon.loadAccount.mockImplementation(async () => account([usdc("0.5000000")]));
    expect(await cleanupEmptyTrustlines([{ code: "USDC", issuer }])).toEqual([]);
    expect(horizon.submitTransaction).not.toHaveBeenCalled();
  });

  it("ignores liquidity-pool shares and removes only empty token trustlines", async () => {
    horizon.loadAccount.mockImplementation(async () => account([{ ...pool, balance: "0.0000000" }, usdc("0.0000000")]));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const removed = await cleanupEmptyTrustlines([{ code: "USDC", issuer }]);
    expect(removed).toEqual(["USDC"]);
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });
});

// PR #261: the platform fee is paid INTO these trustlines; the cleanup must never remove them.
describe("cleanupEmptyTrustlines keeps fee-asset trustlines", () => {
  const changed = () => horizon.submitTransaction.mock.calls.map((c) => ((c[0] as StellarSdk.Transaction).operations[0] as any).line);
  const DEFAULT_USDC_ISSUER = "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN";
  const usdcAt = (iss: string) => ({ asset_type: "credit_alphanum4", asset_code: "USDC", asset_issuer: iss, balance: "0.0000000", selling_liabilities: "0.0000000" });

  it("never removes an asset listed in PLATFORM_LIQUIFIER_KEEP_ASSETS", async () => {
    horizon.loadAccount.mockImplementation(async () => account([usdc("0.0000000"), eurc("0.0000000")]));
    const removed = await cleanupEmptyTrustlines([{ code: "USDC", issuer }, { code: "EURC", issuer }], { PLATFORM_LIQUIFIER_KEEP_ASSETS: `USDC:${issuer}` });
    expect(removed).toEqual(["EURC"]);
    expect(changed().map((a: StellarSdk.Asset) => a.getCode())).toEqual(["EURC"]);
  });

  it("by default keeps the custody allow-listed tokens (CUSTODY_MAINNET_TOKEN_CAPS, default USDC)", async () => {
    horizon.loadAccount.mockImplementation(async () => account([usdcAt(DEFAULT_USDC_ISSUER)]));
    expect(await cleanupEmptyTrustlines([{ code: "USDC", issuer: DEFAULT_USDC_ISSUER }], {})).toEqual([]);
    const zar = StellarSdk.Keypair.random().publicKey();
    horizon.loadAccount.mockImplementation(async () => account([{ ...usdcAt(zar), asset_code: "ZARC" }]));
    expect(await cleanupEmptyTrustlines([{ code: "ZARC", issuer: zar }], { CUSTODY_MAINNET_TOKEN_CAPS: `ZARC:${zar}:zar` })).toEqual([]);
    expect(horizon.submitTransaction).not.toHaveBeenCalled();
  });

  it("a malformed keep-list or token list removes nothing (fails safe)", async () => {
    horizon.loadAccount.mockImplementation(async () => account([usdc("0.0000000")]));
    expect(await cleanupEmptyTrustlines([{ code: "USDC", issuer }], { CUSTODY_MAINNET_TOKEN_CAPS: "garbage" })).toEqual([]);
    expect(await cleanupEmptyTrustlines([{ code: "USDC", issuer }], { PLATFORM_LIQUIFIER_KEEP_ASSETS: "not-an-asset" })).toEqual([]);
    expect(horizon.submitTransaction).not.toHaveBeenCalled();
  });
});
