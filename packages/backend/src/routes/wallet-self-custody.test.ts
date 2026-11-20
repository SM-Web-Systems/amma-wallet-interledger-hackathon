import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { drizzle } from "drizzle-orm/pglite";
import type { PGlite } from "@electric-sql/pglite";
import { legacyDatabase, migrateWithCustodyV2 } from "../db/migrations/chain-storage.test-support";

// Audit F-1 / TODO D1b: in self-custody mode the server keeps no copy of a
// Stellar key, whatever a client sends. Delegated signing still needs one.
const state = vi.hoisted(() => ({ db: undefined as any }));
vi.mock("../db", async () => ({ get db() { return state.db; }, schema: await import("../db/schema") }));
vi.mock("../config", () => ({ config: { STELLAR_NETWORK: "testnet" } }));
vi.mock("../middleware/auth", () => ({ authMiddleware: async (request: any) => { request.user = { userId: 1, type: "user" }; } }));
vi.mock("../middleware/tenant-api-key", () => ({ attachTenantApiKey: async () => {}, requireScope: () => async () => {} }));
vi.mock("../services/billing.service", () => ({ checkWalletBilling: vi.fn(), checkWalletBillingTx: vi.fn(), writeBillingDebit: vi.fn(), upsertTenantUser: vi.fn(), maybeNotifyDeficit: vi.fn() }));

import { walletRoutes } from "./wallets";

let pg: PGlite;
let app: FastifyInstance;
const blob = Buffer.alloc(100, 7).toString("base64");
const PK = `G${"B".repeat(55)}`;
const secretOf = async (id: number) => (await pg.query("SELECT encrypted_secret AS s FROM user_wallets WHERE id=$1", [id])).rows[0] as { s: string | null } | undefined;
const mode = (m: "self" | "delegated") => pg.query("UPDATE users SET signing_mode=$1 WHERE id=1", [m]);

beforeAll(async () => {
  pg = await legacyDatabase(); await migrateWithCustodyV2(pg);
  state.db = drizzle(pg);
  app = Fastify();
  await app.register(walletRoutes);
  await app.ready();
}, 30000);
beforeEach(async () => {
  await pg.exec(`TRUNCATE user_wallets RESTART IDENTITY;
    INSERT INTO user_wallets(id,user_id,name,public_key,chain,network,is_active,encrypted_secret) VALUES
    (1,1,'Stellar','G${"A".repeat(55)}','stellar','testnet',true,'old'),
    (2,1,'No copy','G${"C".repeat(55)}','stellar','testnet',false,NULL),
    (3,2,'Other user','G-other','stellar','testnet',true,'old');
    SELECT setval('user_wallets_id_seq', 10);`);
});
afterAll(async () => { await app?.close(); await pg?.close(); });

describe("POST /api/v1/wallets", () => {
  it("drops encryptedSecret for a self-custody user", async () => {
    await mode("self");
    const res = await app.inject({ method: "POST", url: "/api/v1/wallets", payload: { name: "New", publicKey: PK, encryptedSecret: blob } });
    expect(res.statusCode).toBe(200);
    expect((await secretOf(res.json().id))!.s).toBeNull();
  });

  it("keeps encryptedSecret for a delegated user", async () => {
    await mode("delegated");
    const res = await app.inject({ method: "POST", url: "/api/v1/wallets", payload: { name: "New", publicKey: PK, encryptedSecret: blob } });
    expect(res.statusCode).toBe(200);
    expect((await secretOf(res.json().id))!.s).toBe(blob);
  });
});

describe("GET /api/v1/wallets", () => {
  it("says whether the server holds a key copy, without returning it", async () => {
    const res = await app.inject({ method: "GET", url: "/api/v1/wallets" });
    expect(res.body).not.toContain("old");
    const byId = Object.fromEntries(res.json().map((w: { id: number; hasServerKey: boolean }) => [w.id, w.hasServerKey]));
    expect(byId).toEqual({ 1: true, 2: false });
  });
});

describe("DELETE /api/v1/wallets/:id/secret", () => {
  it("removes the server copy for a self-custody user", async () => {
    await mode("self");
    const res = await app.inject({ method: "DELETE", url: "/api/v1/wallets/1/secret" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });
    expect((await secretOf(1))!.s).toBeNull();
  });

  it("refuses while delegated signing needs the copy", async () => {
    await mode("delegated");
    const res = await app.inject({ method: "DELETE", url: "/api/v1/wallets/1/secret" });
    expect(res.statusCode).toBe(409);
    expect((await secretOf(1))!.s).toBe("old");
  });

  it("cannot touch another user's wallet", async () => {
    await mode("self");
    const res = await app.inject({ method: "DELETE", url: "/api/v1/wallets/3/secret" });
    expect(res.statusCode).toBe(404);
    expect((await secretOf(3))!.s).toBe("old");
  });
});
