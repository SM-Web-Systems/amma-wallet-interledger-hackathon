import { beforeEach, describe, expect, it, vi } from "vitest";
import Fastify from "fastify";
import * as StellarSdk from "@stellar/stellar-sdk";

// POST /api/v1/transactions/sign-and-submit through Fastify (app.inject), with the real handler (routes/sign-and-submit.ts),
// the real fee step and real Stellar transactions. Database, custody signing, the PIN unlock and Horizon are faked.

const h = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const sdk = require("@stellar/stellar-sdk") as typeof import("@stellar/stellar-sdk");
  const userKp = sdk.Keypair.random();
  const platform = sdk.Keypair.random();
  const issuer = sdk.Keypair.random().publicKey();
  return {
    sdk, userKp, platform, issuer,
    lines: [] as any[],
    submit: vi.fn(),
    warn: vi.fn(),
    audit: vi.fn(async () => {}),
    checkPassword: vi.fn(async () => null),
    signWithCustody: vi.fn(async (o: any) => { o.tx.sign(userKp); return null; }),
    release: vi.fn(async () => {}),
  };
});
vi.mock("../db", () => ({
  db: { select: () => ({ from: () => ({ where: () => ({ limit: async () => [{ signingMode: "delegated" }] }) }) }) },
  schema: { users: { id: "id", signingMode: "signing_mode" } },
}));
vi.mock("../config", () => ({ config: { PLATFORM_FEE_PERCENT: 0.1, PLATFORM_FEE_MIN_XLM: 0.01, PLATFORM_WALLET: h.platform.publicKey(), PLATFORM_SECRET: h.platform.secret() } }));
vi.mock("../lib/app-log", () => ({ appLog: () => ({ warn: h.warn, error: vi.fn(), info: vi.fn() }) }));
vi.mock("../lib/audit", () => ({ auditLog: h.audit }));
vi.mock("../lib/custody-sign", () => ({ checkCustodyPassword: h.checkPassword, signWithCustody: h.signWithCustody, releaseCustodyDay: h.release }));
// Two unlock secrets open the stored copy: a 12+ character passphrase, and a legacy 6-digit PIN (which no longer signs).
vi.mock("../lib/decrypt-secret", async (orig) => ({ ...(await orig<typeof import("../lib/decrypt-secret")>()), decryptSecret: async (_enc: string, pin: string) => { if (pin !== "lamp river garden 42" && pin !== "123456") throw new Error("bad pin"); return h.userKp.secret(); } }));
vi.mock("../lib/stellar-submit", async (orig) => ({ ...(await orig<typeof import("../lib/stellar-submit")>()), submitStellarTx: h.submit }));
vi.mock("../services/stellar-wallet.service", () => ({ findActiveStellarWallet: async () => ({ publicKey: h.userKp.publicKey(), encryptedSecret: "enc" }) }));
vi.mock("../lib/stellar-client", () => ({
  stellarClient: {
    networkPassphrase: "Test SDF Network ; September 2015",
    horizon: {
      loadAccount: async () => ({ balances: h.lines }),
      strictReceivePaths: () => ({ call: async () => ({ records: [{ source_amount: "0.0025000" }] }) }),
    },
  },
}));

import { signAndSubmitHandler } from "./sign-and-submit";
import { platformFeeStep, resetPlatformFeeCaches } from "../lib/platform-fee";

const PASS = "Test SDF Network ; September 2015";
const usdc = new StellarSdk.Asset("USDC", h.issuer);
const dest = StellarSdk.Keypair.random().publicKey();
const flags = { serverSigning: true, welcomeFunding: false, sepoliaWei: 0n, dailyCap: 0 };
const unsigned = (asset = StellarSdk.Asset.native(), amount = "10") => new StellarSdk.TransactionBuilder(new StellarSdk.Account(h.userKp.publicKey(), "41"), { fee: "100", networkPassphrase: PASS })
  .addOperation(StellarSdk.Operation.payment({ destination: dest, asset, amount })).setTimeout(300).build().toXDR();
const quotedHash = async (xdr: string) => (await platformFeeStep(StellarSdk.TransactionBuilder.fromXDR(xdr, PASS), {
  feePercent: 0.1, minFeeXlm: 0.01, platformWallet: h.platform.publicKey(), platformSecret: h.platform.secret(), source: h.userKp.publicKey(), passphrase: PASS,
  horizon: { loadAccount: async () => ({ balances: h.lines }), strictReceivePaths: () => ({ call: async () => ({ records: [{ source_amount: "0.0025000" }] }) }) }, warn: () => {},
})).finalTx.hash().toString("hex");
const rejected = (ops: string[]) => Object.assign(new Error("rejected"), { response: { data: { extras: { result_codes: { transaction: "tx_fee_bump_inner_failed", inner_transaction: "tx_failed", operations: ops } } } } });

async function post(payload: Record<string, unknown>, f: typeof flags & { mainnet?: boolean; mainnetUserIds?: ReadonlySet<number> } = flags) {
  const app = Fastify();
  app.post("/api/v1/transactions/sign-and-submit", { preHandler: async (request: any) => { request.user = { userId: 42 }; } }, signAndSubmitHandler({ provider: {} as any, flags: f }));
  const res = await app.inject({ method: "POST", url: "/api/v1/transactions/sign-and-submit", payload });
  await app.close();
  return res;
}
const line = { asset_type: "credit_alphanum4", asset_code: "USDC", asset_issuer: h.issuer, balance: "0", limit: "1000000", buying_liabilities: "0", is_authorized: true };

beforeEach(() => {
  resetPlatformFeeCaches();
  h.lines = [line];
  h.submit.mockReset().mockResolvedValue({ successful: true });
  h.audit.mockClear(); h.warn.mockClear(); h.checkPassword.mockClear(); h.signWithCustody.mockClear(); h.release.mockClear();
});

describe("sign-and-submit (app.inject)", () => {
  it("no expectedHash (old client): the submitted inner transaction is the input plus the user's signature only, no fee", async () => {
    const xdr = unsigned();
    const res = await post({ xdr, pin: "lamp river garden 42" });
    expect(res.statusCode).toBe(200);
    const bump = h.submit.mock.calls[0][1] as StellarSdk.FeeBumpTransaction;
    const inner = bump.innerTransaction;
    const input = StellarSdk.TransactionBuilder.fromXDR(xdr, PASS) as StellarSdk.Transaction;
    expect(inner.hash().toString("hex")).toBe(input.hash().toString("hex"));
    expect(inner.operations).toHaveLength(1);
    expect(inner.signatures).toHaveLength(1);
    expect(h.userKp.verify(inner.hash(), inner.signatures[0].signature())).toBe(true);
    expect(res.json().fee).toBeNull();
    expect(res.json().innerHash).toBe(input.hash().toString("hex"));
  });

  it("with the quoted hash: charged exactly as quoted (PIN path)", async () => {
    const xdr = unsigned();
    const expectedHash = await quotedHash(xdr);
    const res = await post({ xdr, pin: "lamp river garden 42", expectedHash });
    expect(res.statusCode).toBe(200);
    const inner = (h.submit.mock.calls[0][1] as StellarSdk.FeeBumpTransaction).innerTransaction;
    expect(inner.hash().toString("hex")).toBe(expectedHash);
    expect(inner.operations).toHaveLength(2);
    expect(res.json().innerHash).toBe(expectedHash);
  });

  it("409 fee_changed: no custody signing, no submit, no audit row", async () => {
    const res = await post({ xdr: unsigned(), password: "pw", expectedHash: "0".repeat(64) });
    expect(res.statusCode).toBe(409);
    expect(res.json().code).toBe("fee_changed");
    expect(h.checkPassword).toHaveBeenCalled();
    expect(h.signWithCustody).not.toHaveBeenCalled();
    expect(h.submit).not.toHaveBeenCalled();
    expect(h.audit).not.toHaveBeenCalled();
  });

  it("the fee payment fails with op_no_trust (custody): the day reservation is released, then 400 with the op code", async () => {
    const xdr = unsigned(usdc, "100");
    const expectedHash = await quotedHash(xdr);
    h.submit.mockRejectedValueOnce(rejected(["op_success", "op_no_trust"]));
    const res = await post({ xdr, password: "pw", expectedHash });
    expect(h.signWithCustody).toHaveBeenCalledTimes(1);
    expect(h.release).toHaveBeenCalledTimes(1);
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe("op_no_trust");
    expect(res.json().error).toMatch(/couldn't take its fee in USDC/);
    expect(h.audit).not.toHaveBeenCalled();
  });

  it("the fee payment fails with op_underfunded: a plain 'not enough for the amount plus the Amma fee', not 'try again'", async () => {
    const xdr = unsigned(usdc, "100");
    const expectedHash = await quotedHash(xdr);
    h.submit.mockRejectedValueOnce(rejected(["op_success", "op_underfunded"]));
    const res = await post({ xdr, pin: "lamp river garden 42", expectedHash });
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe("op_underfunded");
    expect(res.json().error).toBe("Not enough USDC for the amount plus the Amma fee.");
    expect(h.warn).toHaveBeenCalledWith({ userId: 42, reason: "funds", asset: "USDC" }, "platform_fee_payment_failed");
  });

  it("op_underfunded on an XLM fee payment also says the account must keep its reserve", async () => {
    const xdr = unsigned();
    const expectedHash = await quotedHash(xdr);
    h.submit.mockRejectedValueOnce(rejected(["op_success", "op_underfunded"]));
    const res = await post({ xdr, pin: "lamp river garden 42", expectedHash });
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe("op_underfunded");
    expect(res.json().error).toMatch(/^Not enough XLM for the amount plus the Amma fee\. Your account must keep its minimum XLM reserve\.$/);
  });
  it("a correct legacy PIN no longer signs: 403 pin-retired, pointing to custody, nothing submitted", async () => {
    const res = await post({ xdr: unsigned(), pin: "123456" });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ code: "pin-retired", custodyAvailable: true });
    expect(h.submit).not.toHaveBeenCalled();
  });

  it("on mainnet off the custody allow-list, a legacy PIN wallet's sending is paused", async () => {
    const res = await post({ xdr: unsigned(), pin: "123456" }, { ...flags, mainnet: true, mainnetUserIds: new Set([7]) });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ code: "pin-retired", custodyAvailable: false });
    expect(res.json().error).toContain("paused");
    expect(h.submit).not.toHaveBeenCalled();
  });

  it("a wrong PIN still gets the plain wrong-passphrase answer, not pin-retired", async () => {
    const res = await post({ xdr: unsigned(), pin: "654321" });
    expect(res.statusCode).toBe(403);
    expect(res.json().code).toBeUndefined();
  });
});
