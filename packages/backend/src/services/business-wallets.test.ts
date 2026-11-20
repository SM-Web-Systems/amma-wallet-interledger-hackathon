import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { drizzle } from "drizzle-orm/pglite";
import type { PGlite } from "@electric-sql/pglite";
import { randomBytes } from "node:crypto";
import { Keypair } from "@stellar/stellar-sdk";
import { activationDatabase, connectionOf } from "../db/migrations/activation.test-support";
import { applyCreditsV1 } from "../db/migrations/credits-v1";
import { applyBusinessWalletsV1 } from "../db/migrations/business-wallets-v1";
import { LocalMasterKeyProvider } from "../lib/key-wrapper";
import { setAppLogger } from "../lib/app-log";
vi.mock("../db", () => ({ db: {}, schema: {} }));
import { addFeeAddresses, assignFeeAddress, businessRailSource, createBusinessWallet, openBusinessWallet } from "./business-wallets";

let pg: PGlite;
let db: any;
const provider = new LocalMasterKeyProvider(randomBytes(32).toString("base64"));
const q = async (text: string, params: unknown[] = []) => (await pg.query(text, params)).rows as any[];
const now = new Date("2026-11-16T12:00:00Z");
const LMS_FEE = "GAQD76DFFQG2CAFQI35X43NG5555MSK7GQWIVZR4MUNRJ23CDEV7RQZY";
const logs: { level: string; msg: string; obj: Record<string, unknown> }[] = [];

beforeAll(async () => {
  pg = await activationDatabase();
  await pg.transaction((tx) => applyCreditsV1(connectionOf(tx)));
  await pg.transaction((tx) => applyBusinessWalletsV1(connectionOf(tx)));
  db = drizzle(pg);
}, 60_000);
afterAll(async () => { await pg?.close(); });
beforeEach(async () => {
  logs.length = 0;
  setAppLogger({ info: (obj, msg) => logs.push({ level: "info", obj, msg }), warn: (obj, msg) => logs.push({ level: "warn", obj, msg }), error: (obj, msg) => logs.push({ level: "error", obj, msg }) });
  await pg.exec("TRUNCATE tenants, audit_logs RESTART IDENTITY CASCADE; INSERT INTO tenants (id, slug, name) VALUES (1,'lms','LMS'), (2,'other','Other')");
});
afterEach(() => setAppLogger(null));

describe("business wallets", () => {
  it("makes one wallet per business and network, stores only the sealed key, and a second call returns the same address", async () => {
    const first = await createBusinessWallet(db, provider, { tenantId: 1, network: "testnet", createdBy: "ops" });
    expect(first.created).toBe(true);
    expect(first.address).toMatch(/^G[A-Z2-7]{55}$/);
    expect(await createBusinessWallet(db, provider, { tenantId: 1, network: "testnet", createdBy: "ops" })).toEqual({ address: first.address, created: false });
    const row = (await q("SELECT sealed_secret, provider FROM business_wallets"))[0];
    expect(row.provider).toBe("local");
    expect(row.sealed_secret).not.toMatch(/S[A-Z2-7]{55}/);
    const audit = await q("SELECT action, detail FROM audit_logs");
    expect(audit).toEqual([{ action: "business_wallet_created", detail: expect.objectContaining({ tenantId: 1, network: "testnet", address: first.address }) }]);
    expect(JSON.stringify(audit)).not.toMatch(/S[A-Z2-7]{55}/);
  });

  it("opens the key only after an audit row, and the key matches the address", async () => {
    const { address } = await createBusinessWallet(db, provider, { tenantId: 1, network: "testnet", createdBy: "ops" });
    const opened = await openBusinessWallet(db, provider, { tenantId: 1, network: "testnet", reason: "test" });
    expect(Keypair.fromSecret(opened!.secret).publicKey()).toBe(address);
    expect((await q("SELECT action, detail FROM audit_logs WHERE action='business_wallet_key_open'"))[0].detail).toMatchObject({ tenantId: 1, address, reason: "test" });
    expect(await openBusinessWallet(db, provider, { tenantId: 2, network: "testnet", reason: "test" })).toBeNull();
  });

  it("a sealed key moved to another business cannot be opened, and nothing is audited as released", async () => {
    await createBusinessWallet(db, provider, { tenantId: 1, network: "testnet", createdBy: "ops" });
    await pg.exec("UPDATE business_wallets SET tenant_id = 2");
    await expect(openBusinessWallet(db, provider, { tenantId: 2, network: "testnet", reason: "test" })).rejects.toThrow("cannot be opened");
    expect((await q("SELECT count(*)::int AS n FROM audit_logs WHERE action='business_wallet_key_open'"))[0].n).toBe(0);
  });

  it("a different master key cannot open it", async () => {
    await createBusinessWallet(db, provider, { tenantId: 1, network: "testnet", createdBy: "ops" });
    const other = new LocalMasterKeyProvider(randomBytes(32).toString("base64"));
    await expect(openBusinessWallet(db, other, { tenantId: 1, network: "testnet", reason: "test" })).rejects.toThrow("cannot be opened");
  });

  it("the worker's rail source opens each wallet once, and opens a replacement after a retirement", async () => {
    await createBusinessWallet(db, provider, { tenantId: 1, network: "testnet", createdBy: "ops" });
    const made: string[] = [];
    const source = businessRailSource(db, provider, "testnet", (secret) => { made.push(Keypair.fromSecret(secret).publicKey()); return { n: made.length }; });
    expect(await source(1)).toEqual({ n: 1 });
    expect(await source(1)).toEqual({ n: 1 });
    expect(await source(2)).toBeNull();
    await pg.exec("UPDATE business_wallets SET retired_at = now()");
    expect(await source(1)).toBeNull();
    const { address } = await createBusinessWallet(db, provider, { tenantId: 1, network: "testnet", createdBy: "ops" });
    expect(await source(1)).toEqual({ n: 2 });
    expect(made[1]).toBe(address);
    expect((await q("SELECT count(*)::int AS n FROM audit_logs WHERE action='business_wallet_key_open'"))[0].n).toBe(2);
  });
});

describe("fee address pool", () => {
  const pool = () => Array.from({ length: 6 }, () => Keypair.random().publicKey());

  it("loads public addresses once each and refuses anything else without echoing it", async () => {
    const addresses = pool();
    expect(await addFeeAddresses(db, { network: "public", addresses: [...addresses, addresses[0]], addedBy: "owner" })).toEqual({ added: 6, alreadyThere: 0 });
    expect(await addFeeAddresses(db, { network: "public", addresses: addresses.slice(0, 2), addedBy: "owner" })).toEqual({ added: 0, alreadyThere: 2 });
    const secret = Keypair.random().secret();
    let message = "";
    try { await addFeeAddresses(db, { network: "public", addresses: [Keypair.random().publicKey(), secret], addedBy: "owner" }); } catch (e) { message = (e as Error).message; }
    expect(message).toContain("nothing was added");
    expect(message).not.toContain(secret);
    expect((await q("SELECT count(*)::int AS n FROM fee_address_pool"))[0].n).toBe(6);
  });

  it("gives the LMS the hardware address the owner named, and keeps it", async () => {
    await addFeeAddresses(db, { network: "public", addresses: [LMS_FEE, ...pool()], addedBy: "owner" });
    expect(await assignFeeAddress(db, { tenantId: 1, network: "public", now, address: LMS_FEE, by: "owner" })).toEqual({ address: LMS_FEE, assigned: true, free: 6 });
    expect(await assignFeeAddress(db, { tenantId: 1, network: "public", now, by: "deposit" })).toEqual({ address: LMS_FEE, assigned: false, free: 6 });
    await expect(assignFeeAddress(db, { tenantId: 1, network: "public", now, address: Keypair.random().publicKey(), by: "owner" })).rejects.toThrow("already has a different fee address");
    await expect(assignFeeAddress(db, { tenantId: 2, network: "public", now, address: LMS_FEE, by: "owner" })).rejects.toThrow("another business");
    expect((await q("SELECT detail FROM audit_logs WHERE action='fee_address_assigned'"))[0].detail).toMatchObject({ tenantId: 1, address: LMS_FEE });
  });

  it("gives a new business the oldest free address, and warns when fewer than five are left", async () => {
    const addresses = pool();
    await addFeeAddresses(db, { network: "public", addresses, addedBy: "owner" });
    const r = await assignFeeAddress(db, { tenantId: 2, network: "public", now, by: "deposit" });
    expect(r).toEqual({ address: addresses[0], assigned: true, free: 5 });
    expect(logs.some((l) => l.msg === "fee_address_pool_low")).toBe(false);
    await assignFeeAddress(db, { tenantId: 1, network: "public", now, by: "deposit" });
    expect(logs.find((l) => l.msg === "fee_address_pool_low")?.obj).toEqual({ network: "public", free: 4 });
  });

  it("says so when the pool is empty or the named address is not in it", async () => {
    await expect(assignFeeAddress(db, { tenantId: 1, network: "public", now, by: "deposit" })).rejects.toThrow("No free fee address");
    await expect(assignFeeAddress(db, { tenantId: 1, network: "public", now, address: LMS_FEE, by: "owner" })).rejects.toThrow("not in the fee address pool");
    await expect(assignFeeAddress(db, { tenantId: 1, network: "public", now, address: "SNOTANADDRESS", by: "owner" })).rejects.toThrow("Not a Stellar public address");
  });
});
