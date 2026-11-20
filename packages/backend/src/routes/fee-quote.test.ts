import { beforeEach, describe, expect, it, vi } from "vitest";
import Fastify from "fastify";
import * as StellarSdk from "@stellar/stellar-sdk";

// POST /api/v1/transactions/fee-quote through Fastify (app.inject). sign-and-submit itself lives inside server.ts bootstrap()
// (database, custody, Horizon at start-up), so its 409 fee_changed is covered by feeForSubmit (lib/fee-hardening.test.ts) plus a
// source check that the route returns that refusal before any signing.

const h = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const sdk = require("@stellar/stellar-sdk") as typeof import("@stellar/stellar-sdk");
  const platform = sdk.Keypair.random();
  return {
    user: sdk.Keypair.random().publicKey(),
    platform,
    signingMode: "delegated",
    wallet: null as null | { publicKey: string },
    select: vi.fn(),
    horizon: { loadAccount: vi.fn(async () => ({ balances: [] })), strictReceivePaths: vi.fn() },
  };
});
vi.mock("../db", () => ({ db: { select: h.select }, schema: { users: { id: "id", signingMode: "signing_mode" } } }));
vi.mock("../middleware/auth", () => ({ authMiddleware: async (request: any, reply: any) => {
  if (request.headers.authorization !== "Bearer synthetic-session") return reply.status(401).send({ error: "Unauthenticated" });
  request.user = { userId: 42 };
} }));
vi.mock("../config", () => ({ config: { PLATFORM_FEE_PERCENT: 0.1, PLATFORM_FEE_MIN_XLM: 0.01, PLATFORM_WALLET: h.platform.publicKey(), PLATFORM_SECRET: h.platform.secret() } }));
vi.mock("../services/stellar-wallet.service", () => ({ findActiveStellarWallet: async () => h.wallet }));
vi.mock("../lib/stellar-client", () => ({ stellarClient: { horizon: h.horizon, networkPassphrase: "Test SDF Network ; September 2015" } }));
vi.mock("../lib/app-log", () => ({ appLog: () => ({ warn: vi.fn(), error: vi.fn(), info: vi.fn() }) }));

import { feeQuoteRoutes } from "./fee-quote";
import { feeForSubmit, resetPlatformFeeCaches } from "../lib/platform-fee";

const PASS = "Test SDF Network ; September 2015";
const dest = StellarSdk.Keypair.random().publicKey();
const xdrFrom = (source: string, amount = "10") => new StellarSdk.TransactionBuilder(new StellarSdk.Account(source, "41"), { fee: "100", networkPassphrase: PASS })
  .addOperation(StellarSdk.Operation.payment({ destination: dest, asset: StellarSdk.Asset.native(), amount })).setTimeout(300).build().toXDR();

async function quote(xdr: string, auth = true) {
  const app = Fastify();
  app.register(feeQuoteRoutes);
  const res = await app.inject({ method: "POST", url: "/api/v1/transactions/fee-quote", payload: { xdr }, headers: auth ? { authorization: "Bearer synthetic-session" } : {} });
  await app.close();
  return res;
}

beforeEach(() => {
  resetPlatformFeeCaches();
  h.signingMode = "delegated";
  h.wallet = { publicKey: h.user };
  h.select.mockReset().mockImplementation(() => ({ from: () => ({ where: () => ({ limit: async () => [{ signingMode: h.signingMode }] }) }) }));
});

describe("POST /api/v1/transactions/fee-quote", () => {
  it("requires sign-in", async () => {
    expect((await quote(xdrFrom(h.user), false)).statusCode).toBe(401);
  });

  it("403 for users who sign themselves (not delegated)", async () => {
    h.signingMode = "self";
    const res = await quote(xdrFrom(h.user));
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toBe("Delegated signing is not enabled.");
  });

  it("403 when the transaction is not from the user's active wallet; 400 when it can't be read", async () => {
    expect((await quote(xdrFrom(StellarSdk.Keypair.random().publicKey()))).statusCode).toBe(403);
    expect((await quote("not-xdr")).statusCode).toBe(400);
  });

  it("returns the fee lines, the total and the server's hash; sign-and-submit with that hash charges exactly it, without it charges nothing", async () => {
    const xdr = xdrFrom(h.user);
    const res = await quote(xdr);
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.fee.feeOperations).toEqual([{ asset: "XLM", amount: "0.0100000", xlmFallbackFor: [] }]);
    expect(body.pays).toEqual([{ asset: "XLM", amount: "10.0100000", upTo: false }]);
    expect(body.networkFeePaidByAmma).toBe(true);
    const own = StellarSdk.TransactionBuilder.fromXDR(xdr, PASS).hash().toString("hex");
    expect(body.innerHash).toMatch(/^[0-9a-f]{64}$/);
    expect(body.innerHash).not.toBe(own);

    const opts = { feePercent: 0.1, minFeeXlm: 0.01, platformWallet: h.platform.publicKey(), platformSecret: h.platform.secret(), source: h.user, passphrase: PASS, horizon: h.horizon, warn: vi.fn() };
    const charged = await feeForSubmit(StellarSdk.TransactionBuilder.fromXDR(xdr, PASS), body.innerHash, opts);
    expect(charged.refused).toBeUndefined();
    expect(charged.innerHash).toBe(body.innerHash);
    const old = await feeForSubmit(StellarSdk.TransactionBuilder.fromXDR(xdr, PASS), undefined, opts);
    expect(old.innerHash).toBe(own);
    expect(old.feeDetails).toBeNull();
    // read only: one select (signing mode), nothing else on the database
    expect(h.select).toHaveBeenCalled();
  });
});
