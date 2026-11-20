import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { drizzle } from "drizzle-orm/pglite";
import type { PGlite } from "@electric-sql/pglite";
import { legacyDatabase, migrateWithCustodyV2 } from "../db/migrations/chain-storage.test-support";

// H1-b: a Stellar public key registered to one user cannot be added by another, so nobody can reach
// a victim's key on a shared browser by listing the victim's address in their own wallets.
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
}, 90000);
beforeEach(async () => {
  await pg.exec(`TRUNCATE user_wallets RESTART IDENTITY;
    INSERT INTO user_wallets(id,user_id,name,public_key,chain,network,is_active,encrypted_secret) VALUES
    (1,1,'Stellar','G${"A".repeat(55)}','stellar','testnet',true,'old'),
    (2,1,'No copy','G${"C".repeat(55)}','stellar','testnet',false,NULL),
    (3,2,'Other user','G-other','stellar','testnet',true,'old');
    SELECT setval('user_wallets_id_seq', 10);`);
});
afterAll(async () => { await app?.close(); await pg?.close(); });

describe("POST /api/v1/wallets with a key another user already registered", () => {
  it("refuses with 409 and adds nothing", async () => {
    const res = await app.inject({ method: "POST", url: "/api/v1/wallets", payload: { name: "Mine", publicKey: `G${"D".repeat(55)}` } });
    expect(res.statusCode).toBe(200);
    await pg.exec(`INSERT INTO user_wallets(id,user_id,name,public_key,chain,network,is_active) VALUES (20,2,'Victim','G${"E".repeat(55)}','stellar','testnet',false)`);
    const taken = await app.inject({ method: "POST", url: "/api/v1/wallets", payload: { name: "Steal", publicKey: `G${"E".repeat(55)}` } });
    expect(taken.statusCode).toBe(409);
    const mine = await pg.query("SELECT 1 FROM user_wallets WHERE user_id=1 AND public_key=$1", [`G${"E".repeat(55)}`]);
    expect(mine.rows).toHaveLength(0);
  });

  it("still lets a user add a key nobody else has", async () => {
    const res = await app.inject({ method: "POST", url: "/api/v1/wallets", payload: { name: "Fresh", publicKey: `G${"F".repeat(55)}` } });
    expect(res.statusCode).toBe(200);
  });
});
