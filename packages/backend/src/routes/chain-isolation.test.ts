import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { drizzle } from "drizzle-orm/pglite";
import type { PGlite } from "@electric-sql/pglite";
import { legacyDatabase, migrateWithCustodyV2 } from "../db/migrations/chain-storage.test-support";

const state = vi.hoisted(() => ({ db: undefined as any }));
vi.mock("../db", async () => ({ get db() { return state.db; }, schema: await import("../db/schema") }));
vi.mock("../config", () => ({ config: { STELLAR_NETWORK: "testnet" } }));
vi.mock("../middleware/auth", () => ({ authMiddleware: async (request: any) => { request.user = { userId: 1, type: "user" }; } }));
vi.mock("../middleware/tenant-api-key", () => ({ attachTenantApiKey: async () => {}, requireScope: () => async () => {} }));
vi.mock("../services/billing.service", () => ({ checkWalletBilling: vi.fn(), checkWalletBillingTx: vi.fn(), writeBillingDebit: vi.fn(), upsertTenantUser: vi.fn(), maybeNotifyDeficit: vi.fn() }));

import { walletRoutes } from "./wallets";
import { addressBookRoutes } from "./contacts";
import { portfolioRoutes } from "./portfolio";
import { findActiveStellarWallet } from "../services/stellar-wallet.service";

let pg: PGlite;
let app: FastifyInstance;
const stellarAddress = "G" + "A".repeat(55);
beforeAll(async () => {
  pg = await legacyDatabase(); await migrateWithCustodyV2(pg);
  state.db = drizzle(pg);
  app = Fastify();
  await app.register(walletRoutes); await app.register(addressBookRoutes); await app.register(portfolioRoutes);
  await app.ready();
}, 90000);
beforeEach(async () => {
  await pg.exec(`TRUNCATE user_wallets, address_book, portfolio_snapshots RESTART IDENTITY;
    INSERT INTO user_wallets(id,user_id,name,public_key,chain,network,is_active) VALUES
    (1,1,'Stellar','${stellarAddress}','stellar','testnet',true),
    (2,1,'XRP','r-example','xrpl','testnet',true),
    (3,2,'Other user','G-other','stellar','testnet',true),
    (4,1,'Mainnet','G-public','stellar','public',true),
    (5,1,'Inactive','G-inactive','stellar','testnet',false);`);
  await pg.exec("SELECT setval('user_wallets_id_seq', 5)");
});
afterAll(async () => { await app?.close(); await pg?.close(); });

describe("real legacy routes with a mixed-chain PostgreSQL database", () => {
  it("lists only the caller's configured Stellar network", async () => {
    const res = await app.inject({ method: "GET", url: "/api/v1/wallets" });
    expect(res.statusCode).toBe(200);
    expect(res.json().map((w: any) => w.id).sort()).toEqual([1, 5]);
  });

  it("the legacy signing selector never returns an XRP or foreign-network active wallet", async () => {
    expect((await findActiveStellarWallet(1))?.id).toBe(1);
    await pg.exec("UPDATE user_wallets SET is_active=false WHERE chain='stellar' AND network='testnet'");
    expect(await findActiveStellarWallet(1)).toBeUndefined();
  });

  it("registration remains Stellar-only and does not deactivate other chains/networks", async () => {
    const res = await app.inject({ method: "POST", url: "/api/v1/wallets", payload: {
      name: "New", publicKey: "G" + "B".repeat(55), network: "public", chain: "xrpl",
    } });
    expect(res.statusCode).toBe(200);
    const row = (await pg.query("SELECT chain,network FROM user_wallets WHERE name='New'")).rows[0];
    expect(row).toEqual({ chain: "stellar", network: "testnet" });
    expect((await pg.query("SELECT id FROM user_wallets WHERE id IN (2,3,4) AND is_active=true ORDER BY id")).rows).toEqual([{ id: 2 }, { id: 3 }, { id: 4 }]);
  });

  it.each([2, 3, 4])("cannot activate, rename or delete foreign-chain/network/user wallet %i", async (id) => {
    for (const [method, suffix, payload] of [["PATCH", "/activate", {}], ["PATCH", "", { name: "changed" }], ["DELETE", "", undefined]] as const) {
      const res = await app.inject({ method, url: `/api/v1/wallets/${id}${suffix}`, payload });
      expect(res.statusCode).toBe(404);
    }
    expect((await pg.query("SELECT count(*)::int AS n FROM user_wallets WHERE is_active=true")).rows[0]).toEqual({ n: 4 });
  });

  it("activation and active deletion affect only the selected chain/network", async () => {
    expect((await app.inject({ method: "PATCH", url: "/api/v1/wallets/5/activate", payload: {} })).statusCode).toBe(200);
    expect((await pg.query("SELECT id FROM user_wallets WHERE is_active=true ORDER BY id")).rows).toEqual([{ id: 2 }, { id: 3 }, { id: 4 }, { id: 5 }]);
    expect((await app.inject({ method: "DELETE", url: "/api/v1/wallets/5" })).statusCode).toBe(200);
    expect((await pg.query("SELECT id FROM user_wallets WHERE is_active=true ORDER BY id")).rows).toEqual([{ id: 1 }, { id: 2 }, { id: 3 }, { id: 4 }]);
  });

  it("deleting an inactive wallet does not create a second active wallet", async () => {
    const res = await app.inject({ method: "DELETE", url: "/api/v1/wallets/5" });
    expect(res.statusCode).toBe(200);
    expect((await pg.query("SELECT id FROM user_wallets WHERE chain='stellar' AND network='testnet' AND user_id=1 AND is_active=true")).rows).toEqual([{ id: 1 }]);
  });

  it("filters XRP contacts and refuses their mutation through Stellar routes", async () => {
    await pg.exec(`INSERT INTO address_book(id,user_id,name,address,chain,network) VALUES (1,1,'S','G-contact','stellar',NULL),(2,1,'X','r-contact','xrpl','testnet'),(3,2,'Other','G-other','stellar',NULL),(4,1,'Mainnet','G-public','stellar','public');`);
    const res = await app.inject({ method: "GET", url: "/api/v1/contacts" });
    expect(res.json().map((c: any) => c.id)).toEqual([1]);
    expect((await app.inject({ method: "PATCH", url: "/api/v1/contacts/2", payload: { name: "changed" } })).statusCode).toBe(404);
    expect((await app.inject({ method: "DELETE", url: "/api/v1/contacts/2" })).statusCode).toBe(404);
    expect((await app.inject({ method: "DELETE", url: "/api/v1/contacts/4" })).statusCode).toBe(404);
    expect((await app.inject({ method: "PATCH", url: "/api/v1/contacts/1", payload: { name: "Renamed" } })).statusCode).toBe(200);
    expect((await pg.query("SELECT name FROM address_book WHERE id=1")).rows[0]).toEqual({ name: "Renamed" });
    expect((await app.inject({ method: "DELETE", url: "/api/v1/contacts/1" })).statusCode).toBe(200);
  });

  it("portfolio uses authenticated userId and excludes other users and known foreign networks", async () => {
    await pg.exec(`INSERT INTO portfolio_snapshots(user_id,wallet_public_key,total_xlm,network) VALUES (1,'G-own',10,'testnet'),(2,'G-other',999,'testnet'),(1,'G-public',888,'public');`);
    const res = await app.inject({ method: "GET", url: "/api/v1/portfolio/summary" });
    expect(res.statusCode).toBe(200);
    expect(res.json().totalXlm).toBe("10");
  });
});
