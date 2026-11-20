import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { drizzle } from "drizzle-orm/pglite";
import type { PGlite } from "@electric-sql/pglite";
import { legacyDatabase, migrateWithCustodyV2 } from "../db/migrations/chain-storage.test-support";

// Managed wallet (custody plan, step 1): a signed-in delegated user whose device has no key
// can get their stored copy back. The copy is encrypted with their passphrase; the server
// does not decrypt it for this call.
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
const mode = (m: "self" | "delegated") => pg.query("UPDATE users SET signing_mode=$1 WHERE id=1", [m]);

beforeAll(async () => {
  pg = await legacyDatabase(); await migrateWithCustodyV2(pg);
  // The shared test database has no audit table; create the one the app uses.
  await pg.exec(`CREATE TABLE IF NOT EXISTS audit_logs (
    id bigserial PRIMARY KEY, user_id integer, action varchar(50) NOT NULL, detail jsonb DEFAULT '{}',
    ip_address varchar(45), user_agent text, created_at timestamp DEFAULT now())`);
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


const COPY = Buffer.alloc(100, 9).toString("base64");
const auditRows = async () => (await pg.query("SELECT action, detail FROM audit_logs ORDER BY id")).rows as { action: string; detail: any }[];

beforeEach(async () => {
  await pg.exec(`TRUNCATE user_wallets RESTART IDENTITY; TRUNCATE audit_logs RESTART IDENTITY;
    INSERT INTO user_wallets(id,user_id,name,public_key,chain,network,is_active,encrypted_secret) VALUES
    (1,1,'Stellar','G${"A".repeat(55)}','stellar','testnet',true,'${COPY}'),
    (2,1,'No copy','G${"C".repeat(55)}','stellar','testnet',false,NULL),
    (3,2,'Other user','G-other','stellar','testnet',true,'${COPY}');`);
  await pg.query("UPDATE users SET signing_mode='delegated' WHERE id=1");
});

describe("GET /api/v1/wallets/:id/secret", () => {
  it("gives a delegated user their own stored copy", async () => {
    const res = await app.inject({ method: "GET", url: "/api/v1/wallets/1/secret" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ encryptedSecret: COPY });
  });

  it("does not give out another user's copy", async () => {
    const res = await app.inject({ method: "GET", url: "/api/v1/wallets/3/secret" });
    expect(res.statusCode).toBe(404);
    expect(res.body).not.toContain(COPY);
  });

  it("says 404 when the server holds no copy of that wallet", async () => {
    const res = await app.inject({ method: "GET", url: "/api/v1/wallets/2/secret" });
    expect(res.statusCode).toBe(404);
  });

  it("refuses a self-custody user, who keeps their own keys", async () => {
    await pg.query("UPDATE users SET signing_mode='self' WHERE id=1");
    const res = await app.inject({ method: "GET", url: "/api/v1/wallets/1/secret" });
    expect(res.statusCode).toBe(409);
    expect(res.body).not.toContain(COPY);
  });

  it("records who read a copy and which wallet, never the copy itself", async () => {
    await app.inject({ method: "GET", url: "/api/v1/wallets/1/secret" });
    const rows = await auditRows();
    expect(rows).toHaveLength(1);
    expect(rows[0].action).toBe("wallet_key_backup_read");
    expect(rows[0].detail).toEqual({ walletId: 1 });
    expect(JSON.stringify(rows)).not.toContain(COPY);
  });

  it("records nothing when the request is refused", async () => {
    await app.inject({ method: "GET", url: "/api/v1/wallets/3/secret" });
    expect(await auditRows()).toHaveLength(0);
  });
});
