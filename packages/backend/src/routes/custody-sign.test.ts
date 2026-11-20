import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { drizzle } from "drizzle-orm/pglite";
import type { PGlite } from "@electric-sql/pglite";
import { Account, BASE_FEE, Keypair, Networks, Operation, Asset, TransactionBuilder } from "@stellar/stellar-sdk";
import { legacyDatabase, migrate } from "../db/migrations/chain-storage.test-support";
import { applyKeyEscrow } from "../db/migrations/key-escrow";
import { applyCustody } from "../db/migrations/custody";
import { applyCustodyV2 } from "../db/migrations/custody-v2";
import { LocalMasterKeyProvider, sealForEscrow } from "../lib/key-wrapper";
import bcrypt from "bcryptjs";

const state = vi.hoisted(() => ({ db: undefined as any, frozen: false }));
vi.mock("../db", async () => ({ get db() { return state.db; }, schema: await import("../db/schema") }));
vi.mock("../config", () => ({ config: { STELLAR_NETWORK: "testnet", JWT_SECRET: "x", JWT_REFRESH_SECRET: "y" } }));
vi.mock("../lib/auth", async (orig) => { const m: any = await orig(); return { ...m, verifyPassword: vi.fn(m.verifyPassword) }; });
vi.mock("../lib/key-recovery", () => ({ recoveryFreezeActive: async () => state.frozen }));

import { custodySignStellar, signWithCustody, checkCustodyPasswordOnly } from "../lib/custody-sign";
import { verifyPassword } from "../lib/auth";
import type { CustodyFlags } from "../lib/custody-flags";

const PHRASE = "illness spike retreat truth genius clock brain pass fit cave bargain toe";
const STELLAR = "GDRXE2BQUC3AZNPVFSCEZ76NJ3WWL25FYFK6RGZGIEKWE4SOOHSUJUJ6";
const PASSWORD = "correct horse battery staple";
const provider = new LocalMasterKeyProvider(Buffer.alloc(32, 7).toString("base64"));
const on: CustodyFlags = { serverSigning: true, welcomeFunding: false, sepoliaWei: 1n, dailyCap: 50 };
let pg: PGlite;
const audits = async () => (await pg.query("SELECT action, detail FROM audit_logs ORDER BY id")).rows as { action: string; detail: any }[];
const txFor = (source: string) => TransactionBuilder.fromXDR(
  new TransactionBuilder(new Account(source, "1"), { fee: BASE_FEE, networkPassphrase: Networks.TESTNET })
    .addOperation(Operation.payment({ destination: Keypair.random().publicKey(), asset: Asset.native(), amount: "1" })).setTimeout(60).build().toXDR(),
  Networks.TESTNET) as any;
const run = (over: any = {}, tx: any = txFor(STELLAR)) =>
  custodySignStellar({ provider, flags: on, userId: 1, password: PASSWORD, walletAddress: STELLAR, tx, ...over });

beforeAll(async () => {
  pg = await legacyDatabase(); await migrate(pg);
  const conn = { execute: async (s: string) => { await pg.exec(s); }, rows: async (s: string) => (await pg.query(s)).rows as any };
  await applyKeyEscrow(conn); await applyCustody(conn); await applyCustodyV2(conn);
  await pg.exec(`CREATE TABLE IF NOT EXISTS audit_logs (
    id bigserial PRIMARY KEY, user_id integer, action varchar(50) NOT NULL, detail jsonb DEFAULT '{}',
    ip_address varchar(45), user_agent text, created_at timestamp DEFAULT now())`);
  state.db = drizzle(pg);
  await pg.query("UPDATE users SET password_hash = $1 WHERE id = 1", [await bcrypt.hash(PASSWORD, 4)]);
}, 60000);
beforeEach(async () => {
  state.frozen = false;
  await pg.exec("TRUNCATE wallet_key_escrow; TRUNCATE audit_logs RESTART IDENTITY; DELETE FROM user_wallets; UPDATE users SET signing_mode='delegated'");
  await pg.query("INSERT INTO user_wallets (user_id, chain, network, public_key, name, is_active, derivation_index) VALUES (1,'stellar','testnet',$1,'s',true,0)", [STELLAR]);
  await pg.query("INSERT INTO wallet_key_escrow (user_id, kind, sealed, provider, origin) VALUES (1,'phrase',$1,'local','custody')", [await sealForEscrow(provider, PHRASE, { userId: 1, kind: "phrase" })]);
});
afterAll(async () => { await pg?.close(); });

describe("custodySignStellar (password step-up)", () => {
  it("signs with the phrase-derived key when the account password is right", async () => {
    const tx = txFor(STELLAR);
    expect(await run({}, tx)).toBeNull();
    expect(tx.signatures).toHaveLength(1);
    expect(Keypair.fromPublicKey(STELLAR).verify(tx.hash(), tx.signatures[0].signature())).toBe(true);
    expect((await audits()).map((a) => a.action)).toContain("wallet_custody_sign");
  });

  it("refuses a wrong password with 403, audits it and does not sign or leak the password", async () => {
    const tx = txFor(STELLAR);
    expect(await run({ password: "nope" }, tx)).toEqual({ status: 403, error: "That password is not correct." });
    expect(tx.signatures).toHaveLength(0);
    const a = await audits();
    expect(a.map((x) => x.action)).toEqual(["wallet_custody_sign_denied"]);
    expect(JSON.stringify(a)).not.toContain("nope");
  });

  it("refuses a transaction whose source is not the wallet, before checking anything else", async () => {
    const tx = txFor(Keypair.random().publicKey());
    expect(await run({}, tx)).toEqual({ status: 403, error: "Transaction source does not match your active wallet" });
    expect(tx.signatures).toHaveLength(0);
  });

  const OFF = { status: 400, error: "Approving with your Amma password is switched off here." };
  it("says approving with the password is switched off when server signing is off", async () => {
    expect(await run({ flags: { ...on, serverSigning: false } })).toEqual(OFF);
    expect(await checkCustodyPasswordOnly({ provider, flags: { ...on, serverSigning: false }, userId: 1, password: PASSWORD }, "xrpl")).toEqual(OFF);
  });

  it("says the same when there is no key provider (signWithCustody)", async () => {
    expect(await signWithCustody({ provider: null, flags: on, userId: 1, walletAddress: STELLAR, tx: txFor(STELLAR) })).toEqual(OFF);
  });

  it("says the same when signWithCustody finds server signing off", async () => {
    expect(await signWithCustody({ provider, flags: { ...on, serverSigning: false }, userId: 1, walletAddress: STELLAR, tx: txFor(STELLAR) })).toEqual(OFF);
  });

  it("maps a self-custody account to 403", async () => {
    await pg.exec("UPDATE users SET signing_mode='self'");
    expect((await run())?.status).toBe(403);
  });

  it("maps a frozen account to 423", async () => {
    state.frozen = true;
    expect((await run())?.status).toBe(423);
  });

  it("tells the user to use their passphrase when the wallet is not from the phrase (409)", async () => {
    const other = Keypair.random().publicKey();
    expect(await run({ walletAddress: other }, txFor(other))).toEqual({ status: 409, error: "Amma can't sign for this wallet. Use your wallet passphrase." });
  });

  it("gives the same 409 when there is no escrowed phrase", async () => {
    await pg.exec("TRUNCATE wallet_key_escrow");
    expect((await run())?.status).toBe(409);
  });
});

describe("custodySignStellar wrong-password limit", () => {
  const wrong = (n: number, userId = 1) => Promise.all(Array.from({ length: n }, () =>
    pg.query("INSERT INTO audit_logs (user_id, action) VALUES ($1, 'wallet_custody_sign_denied')", [userId])));

  it("refuses the 11th attempt with 429 even with the right password, without opening escrow", async () => {
    await wrong(10);
    expect(await run()).toEqual({ status: 429, error: "Too many wrong passwords. Try again in 15 minutes." });
    expect((await audits()).map((a) => a.action)).not.toContain("wallet_custody_sign");
    expect((await audits()).filter((a) => a.action !== "wallet_custody_sign_denied")).toHaveLength(0);
  });

  it("allows the 10th attempt (9 earlier denials)", async () => {
    await wrong(9);
    expect(await run()).toBeNull();
  });

  it("does not affect another user", async () => {
    await wrong(10, 2);
    expect(await run()).toBeNull();
  });

  it("ignores denials older than 15 minutes", async () => {
    await wrong(10);
    await pg.exec("UPDATE audit_logs SET created_at = now() - interval '16 minutes'");
    expect(await run()).toBeNull();
  });
});

describe("custodySignStellar limit is atomic and fails closed", () => {
  // PGlite is single-session and serialises transactions, so this checks the outcome, not real lock contention.
  it("20 concurrent wrong passwords: at most 10 compares and denial rows, the rest get 429", async () => {
    (verifyPassword as any).mockClear();
    const out = await Promise.all(Array.from({ length: 20 }, () => run({ password: "nope" })));
    expect(out.filter((r) => r?.status === 403)).toHaveLength(10);
    expect(out.filter((r) => r?.status === 429)).toHaveLength(10);
    expect((verifyPassword as any).mock.calls).toHaveLength(10);
    expect((await audits()).filter((a) => a.action === "wallet_custody_sign_denied")).toHaveLength(10);
  });

  it("refuses at once with 429, without comparing, when another attempt holds the user's lock", async () => {
    (verifyPassword as any).mockClear();
    const real = state.db.transaction.bind(state.db);
    const spy = vi.spyOn(state.db, "transaction").mockImplementation((cb: any, ...rest: any[]) => real((q: any) => cb(new Proxy(q, {
      get: (t, k) => k !== "execute" ? t[k] : async (query: any) =>
        JSON.stringify(query?.queryChunks ?? "").includes("pg_try_advisory_xact_lock") ? { rows: [{ ok: false }] } : t.execute(query),
    })), ...rest));
    try {
      expect(await run()).toEqual({ status: 429, error: "Another attempt is already in progress. Try again in a moment." });
      expect(verifyPassword).not.toHaveBeenCalled();
    } finally { spy.mockRestore(); }
  });

  it("refuses with 500 when the denial cannot be recorded, and signs nothing", async () => {
    await pg.exec("CREATE FUNCTION boom() RETURNS trigger AS $$ BEGIN RAISE EXCEPTION 'no audit'; END $$ LANGUAGE plpgsql; CREATE TRIGGER boom_t BEFORE INSERT ON audit_logs FOR EACH ROW WHEN (NEW.action = 'wallet_custody_sign_denied') EXECUTE FUNCTION boom()");
    try {
      const tx = txFor(STELLAR);
      expect(await run({ password: "nope" }, tx)).toEqual({ status: 500, error: "The attempt could not be recorded, so it was refused." });
      expect(tx.signatures).toHaveLength(0);
    } finally { await pg.exec("DROP TRIGGER boom_t ON audit_logs; DROP FUNCTION boom()"); }
  });
});
