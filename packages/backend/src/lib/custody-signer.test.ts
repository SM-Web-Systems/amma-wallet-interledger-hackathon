import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { drizzle } from "drizzle-orm/pglite";
import type { PGlite } from "@electric-sql/pglite";
import { Keypair } from "@stellar/stellar-sdk";
import { privateKeyToAccount } from "viem/accounts";
import { legacyDatabase, migrate } from "../db/migrations/chain-storage.test-support";
import { applyKeyEscrow } from "../db/migrations/key-escrow";
import { applyCustody } from "../db/migrations/custody";
import { applyCustodyV2 } from "../db/migrations/custody-v2";
import { deriveAllChains } from "./one-phrase";
import { LocalMasterKeyProvider, sealForEscrow } from "./key-wrapper";

const state = vi.hoisted(() => ({ db: undefined as any, frozen: false }));
vi.mock("../db", async () => ({ get db() { return state.db; }, schema: await import("../db/schema") }));
vi.mock("./key-recovery", () => ({ recoveryFreezeActive: async () => state.frozen }));

import { CustodyRefused, withDelegatedKey } from "./custody-signer";
import type { CustodyFlags } from "./custody-flags";

const PHRASE = "illness spike retreat truth genius clock brain pass fit cave bargain toe";
const STELLAR = "GDRXE2BQUC3AZNPVFSCEZ76NJ3WWL25FYFK6RGZGIEKWE4SOOHSUJUJ6";
const XRPL = "rHfsP8wmWDEvSvBZu4VsF9BUB6wqXDo4xU";
const EVM = "0x6b30c7d7657A83141186Cd8c155CDB90C8750371";
const provider = new LocalMasterKeyProvider(Buffer.alloc(32, 7).toString("base64"));
const on: CustodyFlags = { serverSigning: true, welcomeFunding: false, sepoliaWei: 1n, dailyCap: 50 };
let pg: PGlite;
const audits = async () => (await pg.query("SELECT action, detail FROM audit_logs ORDER BY id")).rows as { action: string; detail: any }[];
const base = { provider, flags: on, userId: 1, chain: "stellar" as const, expectedAddress: STELLAR, reason: "test" };
const noop = async () => "ok";

beforeAll(async () => {
  pg = await legacyDatabase(); await migrate(pg);
  const conn = { execute: async (s: string) => { await pg.exec(s); }, rows: async (s: string) => (await pg.query(s)).rows as any };
  await applyKeyEscrow(conn); await applyCustody(conn); await applyCustodyV2(conn);
  await pg.exec(`CREATE TABLE IF NOT EXISTS audit_logs (
    id bigserial PRIMARY KEY, user_id integer, action varchar(50) NOT NULL, detail jsonb DEFAULT '{}',
    ip_address varchar(45), user_agent text, created_at timestamp DEFAULT now())`);
  state.db = drizzle(pg);
}, 60000);
beforeEach(async () => {
  state.frozen = false;
  await pg.exec("TRUNCATE wallet_key_escrow; TRUNCATE audit_logs RESTART IDENTITY; DELETE FROM user_wallets; UPDATE users SET signing_mode='delegated'");
  await pg.query(`INSERT INTO user_wallets (user_id, chain, network, public_key, name, is_active, derivation_index) VALUES
    (1,'stellar','testnet',$1,'s',true,0),(1,'xrpl','testnet',$2,'x',true,0),(1,'evm','sepolia',$3,'e',true,0)`, [STELLAR, XRPL, EVM]);
  await pg.query("INSERT INTO wallet_key_escrow (user_id, kind, sealed, provider, origin) VALUES (1,'phrase',$1,'local','custody')", [await sealForEscrow(provider, PHRASE, { userId: 1, kind: "phrase" })]);
});
afterAll(async () => { await pg?.close(); });

const refusal = async (o: any) => { try { await withDelegatedKey(o, noop); } catch (e) { return e as CustodyRefused; } throw new Error("not refused"); };

describe("withDelegatedKey", () => {
  it("gives a Stellar secret that matches the address, with the escrow open audited before the callback", async () => {
    let seen: any[] = [];
    await withDelegatedKey(base, async (k) => {
      expect(Keypair.fromSecret(k.stellarSecret!).publicKey()).toBe(STELLAR);
      seen = await audits();
    });
    expect(seen).toHaveLength(1);
    expect(seen[0].action).toBe("wallet_key_escrow_open");
    expect(seen[0].detail.reason).toBe("custody-sign:stellar:0");
    const after = await audits();
    expect(after.map((a) => a.action)).toEqual(["wallet_key_escrow_open", "wallet_custody_sign"]);
    expect(JSON.stringify(after)).not.toContain("illness");
  });
  it("refuses when the flag is off or there is no provider", async () => {
    expect((await refusal({ ...base, flags: { ...on, serverSigning: false } })).code).toBe("off");
    expect((await refusal({ ...base, provider: null })).code).toBe("off");
  });
  it("refuses self-custody users", async () => {
    await pg.exec("UPDATE users SET signing_mode='self'");
    expect((await refusal(base)).code).toBe("self");
  });
  it("refuses frozen accounts", async () => {
    state.frozen = true;
    expect((await refusal(base)).code).toBe("frozen");
  });
  it("refuses when nothing is escrowed", async () => {
    await pg.exec("TRUNCATE wallet_key_escrow");
    expect((await refusal(base)).code).toBe("no-escrow");
  });
  it("refuses a phrase the client uploaded (only Amma-created phrases are used)", async () => {
    await pg.exec("UPDATE wallet_key_escrow SET origin='client'");
    const cb = vi.fn(async () => 1);
    expect((await refusal(base)).code).toBe("no-escrow");
    await expect(withDelegatedKey(base, cb)).rejects.toBeInstanceOf(CustodyRefused);
    expect(cb).not.toHaveBeenCalled();
  });
  it("refuses a different address and never calls the callback", async () => {
    const cb = vi.fn(async () => 1);
    const other = Keypair.random().publicKey();
    const err = await withDelegatedKey({ ...base, expectedAddress: other }, cb).catch((e) => e);
    expect(err).toBeInstanceOf(CustodyRefused);
    expect(err.code).toBe("mismatch");
    expect(cb).not.toHaveBeenCalled();
    const log = await audits();
    expect(log.map((a) => a.action)).not.toContain("wallet_custody_sign");
    const denied = log.filter((a) => a.action === "wallet_custody_sign_denied");
    expect(denied).toHaveLength(1);
    expect(denied[0].detail).toEqual({ chain: "stellar", code: "mismatch" });
  });
  it("gives XRP and EVM keys for the pinned addresses (EVM case-insensitive)", async () => {
    await withDelegatedKey({ ...base, chain: "xrpl", expectedAddress: XRPL }, async (k) => { expect(k.xrplWallet!.classicAddress).toBe(XRPL); });
    await withDelegatedKey({ ...base, chain: "evm", expectedAddress: EVM.toLowerCase() }, async (k) => { expect(k.evmPrivateKey).toMatch(/^0x[0-9a-f]{64}$/); expect(privateKeyToAccount(k.evmPrivateKey!).address).toBe(EVM); });
    expect((await refusal({ ...base, chain: "xrpl", expectedAddress: XRPL.toLowerCase() })).code).toBe("mismatch");
  });
  it("signs from a wallet at a later derivation index and records the index in the reason", async () => {
    const d2 = deriveAllChains(PHRASE, 2);
    await pg.query("INSERT INTO user_wallets (user_id, chain, network, public_key, name, is_active, derivation_index) VALUES (1,'xrpl','testnet',$1,'x3',false,2)", [d2.xrpl.address]);
    await pg.query("INSERT INTO user_wallets (user_id, chain, network, public_key, name, is_active, derivation_index) VALUES (1,'evm','sepolia',$1,'e3',false,2)", [d2.evm.address]);
    await withDelegatedKey({ ...base, chain: "xrpl", expectedAddress: d2.xrpl.address }, async (k) => { expect(k.xrplWallet!.classicAddress).toBe(d2.xrpl.address); });
    await withDelegatedKey({ ...base, chain: "evm", expectedAddress: d2.evm.address.toLowerCase() }, async (k) => { expect(privateKeyToAccount(k.evmPrivateKey!).address).toBe(d2.evm.address); });
    const opens = (await audits()).filter((a) => a.action === "wallet_key_escrow_open").map((a) => a.detail.reason);
    expect(opens).toEqual(["custody-sign:xrpl:2", "custody-sign:evm:2"]);
  });
  it("refuses a valid phrase-derived address that is not one of the user's wallet rows, and audits the denial", async () => {
    const d3 = deriveAllChains(PHRASE, 3);
    const cb = vi.fn(async () => 1);
    const err = await withDelegatedKey({ ...base, chain: "xrpl", expectedAddress: d3.xrpl.address }, cb).catch((e) => e);
    expect(err).toBeInstanceOf(CustodyRefused); expect(err.code).toBe("mismatch");
    expect(cb).not.toHaveBeenCalled();
    expect((await audits()).filter((a) => a.action === "wallet_custody_sign_denied")).toHaveLength(1);
  });
  it("refuses a custody row on the wrong network", async () => {
    await pg.exec("UPDATE user_wallets SET network = 'mainnet' WHERE chain = 'xrpl'");
    expect((await refusal({ ...base, chain: "xrpl", expectedAddress: XRPL })).code).toBe("mismatch");
  });
  it("refuses a wallet row that has no derivation index, and another user's row", async () => {
    await pg.exec("UPDATE user_wallets SET derivation_index = NULL WHERE chain = 'xrpl'");
    expect((await refusal({ ...base, chain: "xrpl", expectedAddress: XRPL })).code).toBe("mismatch");
    await pg.exec("UPDATE user_wallets SET derivation_index = 0 WHERE chain = 'xrpl'");
    await pg.exec("INSERT INTO users (id, email, password_hash) VALUES (77, 'o@x.test', 'x') ON CONFLICT DO NOTHING");
    await pg.exec("UPDATE user_wallets SET user_id = 77 WHERE chain = 'xrpl'");
    expect((await refusal({ ...base, chain: "xrpl", expectedAddress: XRPL })).code).toBe("mismatch");
    await pg.exec("DELETE FROM user_wallets WHERE user_id = 77; DELETE FROM users WHERE id = 77");
  });
  it("no refusal message or audit detail holds the phrase or a secret", async () => {
    const errs = [
      await refusal({ ...base, flags: { ...on, serverSigning: false } }),
      await refusal({ ...base, expectedAddress: Keypair.random().publicKey() }),
    ];
    await pg.exec("UPDATE users SET signing_mode='self'"); errs.push(await refusal(base));
    await pg.exec("UPDATE users SET signing_mode='delegated'");
    state.frozen = true; errs.push(await refusal(base)); state.frozen = false;
    await pg.exec("TRUNCATE wallet_key_escrow"); errs.push(await refusal(base));
    expect(errs.map((e) => e.code).sort()).toEqual(["frozen", "mismatch", "no-escrow", "off", "self"]);
    const secret = /illness|spike|retreat|S[A-Z2-7]{55}|0x[0-9a-f]{64}/;
    for (const e of errs) { expect(e.message).not.toMatch(secret); expect(e.message.length).toBeGreaterThan(10); }
    expect(JSON.stringify(await audits())).not.toMatch(secret);
  });
});
