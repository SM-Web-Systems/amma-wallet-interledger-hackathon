import { describe, it, expect, afterEach } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import { legacyDatabase, migrate } from "./chain-storage.test-support";
import { applyChainStorage } from "./chain-storage";

let db: PGlite;
afterEach(async () => { await db?.close(); });

// Each case boots a fresh WASM PostgreSQL instance; allow bounded cold-start time.
describe("chain storage migration on PostgreSQL", { timeout: 30_000 }, () => {
  it("preserves IDs/secrets, normalizes known aliases and retains unknown history provenance", async () => {
    db = await legacyDatabase();
    await db.exec(`INSERT INTO user_wallets(id,user_id,name,public_key,encrypted_secret,network,is_active) VALUES
      (41,1,'Existing','G-existing','ciphertext','mainnet',true);
      INSERT INTO address_book(user_id,name,address) VALUES (1,'Contact','G-contact');
      INSERT INTO tx_history(public_key,tx_hash,operation_type,created_at) VALUES ('G-existing','same-hash','payment',now());
      INSERT INTO portfolio_snapshots(user_id,wallet_public_key) VALUES (1,'G-existing');`);
    expect(await migrate(db)).toBe("applied");
    const wallet = (await db.query("SELECT id,chain,network,encrypted_secret,is_active FROM user_wallets")).rows[0];
    expect(wallet).toMatchObject({ id: 41, chain: "stellar", network: "public", encrypted_secret: "ciphertext", is_active: true });
    for (const table of ["address_book", "tx_history", "portfolio_snapshots"]) {
      expect((await db.query(`SELECT chain,network FROM ${table}`)).rows[0]).toEqual({ chain: "stellar", network: null });
    }
    expect(await migrate(db)).toBe("already-applied");
  });

  it("isolates address identity and active wallets by chain/network and forbids XRP secrets", async () => {
    db = await legacyDatabase(); await migrate(db);
    await db.exec(`INSERT INTO user_wallets(user_id,name,public_key,chain,network,is_active) VALUES
      (1,'S','address','stellar','public',true), (1,'T','address','stellar','testnet',true), (1,'X','address','xrpl','testnet',true);`);
    await expect(db.exec("INSERT INTO user_wallets(user_id,name,public_key,chain,network) VALUES (1,'duplicate','address','xrpl','testnet')")).rejects.toThrow();
    await expect(db.exec("INSERT INTO user_wallets(user_id,name,public_key,chain,network,is_active) VALUES (1,'second','other','xrpl','testnet',true)")).rejects.toThrow();
    await expect(db.exec("UPDATE user_wallets SET encrypted_secret='forbidden' WHERE chain='xrpl'")).rejects.toThrow();
    await expect(db.exec("UPDATE user_wallets SET network='public' WHERE chain='xrpl'")).rejects.toThrow();
    expect((await db.query("SELECT count(*)::int AS n FROM user_wallets")).rows[0]).toEqual({ n: 3 });
  });

  it("scopes history hashes, enforces known XRP networks and keeps XLM portfolios Stellar-only", async () => {
    db = await legacyDatabase(); await migrate(db);
    await db.exec(`INSERT INTO tx_history(public_key,tx_hash,operation_type,created_at,chain,network) VALUES
      ('a','hash','payment',now(),'stellar',NULL), ('a','hash','payment',now(),'stellar','public'), ('a','hash','payment',now(),'xrpl','testnet');`);
    await expect(db.exec("INSERT INTO tx_history(public_key,tx_hash,operation_type,created_at) VALUES ('a','hash','payment',now())")).rejects.toThrow();
    await expect(db.exec("INSERT INTO tx_history(public_key,tx_hash,operation_type,created_at,chain) VALUES ('a','other','payment',now(),'xrpl')")).rejects.toThrow();
    await expect(db.exec("INSERT INTO portfolio_snapshots(user_id,wallet_public_key,chain) VALUES (1,'r-address','xrpl')")).rejects.toThrow();
  });

  it("rolls back without data changes for unknown networks", async () => {
    db = await legacyDatabase();
    await db.exec("INSERT INTO user_wallets(user_id,name,public_key,network) VALUES (1,'bad','address','custom')");
    await expect(migrate(db)).rejects.toThrow(/Unknown wallet network/);
    expect((await db.query("SELECT network FROM user_wallets")).rows).toEqual([{ network: "custom" }]);
    expect((await db.query("SELECT column_name FROM information_schema.columns WHERE table_name='user_wallets' AND column_name='chain'")).rows).toEqual([]);
    expect((await db.query("SELECT to_regclass('amma_chain_migrations') AS name")).rows[0]).toEqual({ name: null });
  });

  it("refuses multiple active wallets without silently selecting one", async () => {
    db = await legacyDatabase();
    await db.exec("INSERT INTO user_wallets(user_id,name,public_key,network,is_active) VALUES (1,'a','a','public',true),(1,'b','b','public',true)");
    await expect(migrate(db)).rejects.toThrow(/Multiple active wallets/);
    expect((await db.query("SELECT count(*)::int AS n FROM user_wallets WHERE is_active=true")).rows[0]).toEqual({ n: 2 });
  });

  it("detects drift and checksum mismatch instead of replaying DDL", async () => {
    db = await legacyDatabase();
    await db.exec("ALTER TABLE user_wallets ADD COLUMN chain text");
    await expect(migrate(db)).rejects.toThrow(/Unrecognized chain schema/);
    await db.exec("ALTER TABLE user_wallets DROP COLUMN chain");
    await migrate(db);
    await db.exec("UPDATE amma_chain_migrations SET checksum='tampered'");
    await expect(migrate(db)).rejects.toThrow(/checksum mismatch/);
  });

  it("a rehearsal rolls back successful DDL, normalization and the version marker", async () => {
    db = await legacyDatabase();
    await db.exec("INSERT INTO user_wallets(user_id,name,public_key,network) VALUES (1,'existing','address','pubnet')");
    await expect(db.transaction(async (tx) => {
      await applyChainStorage({
        execute: async (q) => { await tx.exec(q); },
        rows: async <T extends Record<string, unknown>>(q: string) => (await tx.query<T>(q)).rows,
      });
      throw new Error("rehearsal rollback");
    })).rejects.toThrow("rehearsal rollback");
    expect((await db.query("SELECT network FROM user_wallets")).rows).toEqual([{ network: "pubnet" }]);
    expect((await db.query("SELECT to_regclass('amma_chain_migrations') AS name")).rows[0]).toEqual({ name: null });
  });
});
