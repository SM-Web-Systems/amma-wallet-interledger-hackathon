import { beforeAll, beforeEach, afterAll, describe, it, expect, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import jwt from "jsonwebtoken";
import { drizzle } from "drizzle-orm/pglite";
import type { PGlite } from "@electric-sql/pglite";
import { legacyDatabase, migrateWithCustodyV2 } from "../db/migrations/chain-storage.test-support";
import { XrplReadError } from "../modules/xrpl/validation";

const state = vi.hoisted(() => ({ db: undefined as any, enabled: true }));
vi.mock("../db", async () => ({ get db() { return state.db; }, schema: await import("../db/schema") }));
vi.mock("../config", () => ({ config: { JWT_SECRET: "local-only-xrp-route-secret", XRPL: { get enabled() { return state.enabled; } } } }));
import { xrplWalletRoutes } from "./xrpl-wallets";

const address = "rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh";
const otherAddress = "rhqAt5JBEyKnHrs6QSwKjqxFmu2iLcA5vA";
const headers = (userId = 1, type: string | undefined = "user") => ({ authorization: "Bearer " + jwt.sign({ userId, type }, "local-only-xrp-route-secret") });
let app: FastifyInstance; let pg: PGlite;
const reader = { getAccount: vi.fn(async (address: string) => ({ address, funded: false, balanceDrops: "0", reserveDrops: "1000000", spendableDrops: "0" })) };
beforeAll(async () => {
  pg = await legacyDatabase(); await migrateWithCustodyV2(pg); state.db = drizzle(pg);
  app = Fastify(); await app.register(xrplWalletRoutes, { reader }); await app.ready();
}, 30000);
beforeEach(async () => {
  state.enabled = true; reader.getAccount.mockClear();
  await pg.exec(`TRUNCATE user_wallets RESTART IDENTITY;
    INSERT INTO user_wallets(id,user_id,name,public_key,chain,network,is_active) VALUES
    (1,1,'Stellar','G-stellar','stellar','testnet',true), (2,1,'XRP','${address}','xrpl','testnet',true),
    (3,2,'Other user','${otherAddress}','xrpl','testnet',true), (4,1,'Other network','${otherAddress}','xrpl','mainnet',true);
    SELECT setval('user_wallets_id_seq',4);`);
});
afterAll(async () => { await app?.close(); await pg?.close(); });

describe("XRP public metadata routes with actual JWT and database", () => {
  it("rejects disabled features, missing/legacy/admin tokens and API-key callers", async () => {
    state.enabled = false;
    expect((await app.inject({ method: "GET", url: "/api/v1/xrpl/wallets", headers: headers() })).statusCode).toBe(503);
    state.enabled = true;
    for (const value of [{}, headers(1, "admin"), headers(1, ""), headers(0), { ...headers(), "x-api-key": "legacy-key" }]) {
      expect([401, 403]).toContain((await app.inject({ method: "GET", url: "/api/v1/xrpl/wallets", headers: value })).statusCode);
    }
    expect(reader.getAccount).not.toHaveBeenCalled();
  });
  it("returns only the authenticated owner's XRP Testnet public metadata", async () => {
    const response = await app.inject({ method: "GET", url: "/api/v1/xrpl/wallets", headers: headers() });
    expect(response.statusCode).toBe(200); expect(response.json()).toEqual([{ id: "2", ownerId: "1", name: "XRP", address, chain: "xrpl", network: "testnet", custody: "self", isActive: true }]);
  });
  it.each(["seed", "passphrase", "encryptedSecret", "privateKey", "userId", "chain"])("rejects extra body field %s before Fastify strips it", async (field) => {
    const response = await app.inject({ method: "POST", url: "/api/v1/xrpl/wallets", headers: headers(), payload: { name: "New", address: otherAddress, [field]: "forbidden" } });
    expect(response.statusCode).toBe(400); expect(response.body).not.toContain("forbidden");
    expect((await pg.query("SELECT count(*)::int AS n FROM user_wallets")).rows[0]).toEqual({ n: 4 });
  });
  it("registers public metadata idempotently and never stores a server-side secret", async () => {
    const request = { method: "POST" as const, url: "/api/v1/xrpl/wallets", headers: headers(), payload: { name: "Restored", address: otherAddress } };
    const a = await app.inject(request); const b = await app.inject(request);
    expect(a.statusCode).toBe(200); expect(b.json().id).toBe(a.json().id);
    expect((await pg.query("SELECT chain,network,encrypted_secret,is_active FROM user_wallets WHERE id=5")).rows[0]).toEqual({ chain: "xrpl", network: "testnet", encrypted_secret: null, is_active: true });
    expect((await pg.query("SELECT id FROM user_wallets WHERE is_active=true ORDER BY id")).rows).toEqual([{ id: 1 }, { id: 3 }, { id: 4 }, { id: 5 }]);
  });
  it("denies foreign user, chain and network reads/activation", async () => {
    for (const id of [1, 3, 4, 999]) {
      expect((await app.inject({ method: "GET", url: `/api/v1/xrpl/wallets/${id}/account`, headers: headers() })).statusCode).toBe(404);
      expect((await app.inject({ method: "PATCH", url: `/api/v1/xrpl/wallets/${id}/activate`, headers: headers(), payload: {} })).statusCode).toBe(404);
    }
    expect(reader.getAccount).not.toHaveBeenCalled();
  });
  it("reads only the owned address and does not turn RPC errors into zero balances", async () => {
    expect((await app.inject({ method: "GET", url: "/api/v1/xrpl/wallets/2/account", headers: headers() })).json()).toMatchObject({ address });
    expect(reader.getAccount).toHaveBeenCalledWith(address);
    reader.getAccount.mockRejectedValueOnce(new XrplReadError("XRPL_UNAVAILABLE", true));
    const failed = await app.inject({ method: "GET", url: "/api/v1/xrpl/wallets/2/account", headers: headers() });
    expect(failed.statusCode).toBe(503); expect(failed.json()).not.toHaveProperty("balanceDrops");
  });
  it("rejects invalid classic addresses and empty wallet names", async () => {
    for (const payload of [{ name: " ", address }, { name: "Bad", address: address.slice(0,-1)+"x" }]) {
      expect((await app.inject({ method: "POST", url: "/api/v1/xrpl/wallets", headers: headers(), payload })).statusCode).toBe(400);
    }
  });
});
