/**
 * POST /api/v1/wallets with a tenant key from a task-activation partner (the LMS): the learner is linked to the partner,
 * but nothing is charged at sign-up; the partner is billed per completed task by the activation intake instead.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { drizzle } from "drizzle-orm/pglite";
import type { PGlite } from "@electric-sql/pglite";
import { legacyDatabase, migrateWithCustodyV2 } from "../db/migrations/chain-storage.test-support";

const state = vi.hoisted(() => ({ db: undefined as any }));
vi.mock("../db", async () => ({ get db() { return state.db; }, schema: await import("../db/schema") }));
vi.mock("../config", () => ({ config: { STELLAR_NETWORK: "testnet" } }));
vi.mock("../middleware/auth", () => ({ authMiddleware: async (request: any) => { request.user = { userId: 1, type: "user" }; } }));
vi.mock("../middleware/tenant-api-key", () => ({
  attachTenantApiKey: async (request: any) => { request.tenantApiKeyContext = { tenantId: 2, keyId: 7 }; },
  requireScope: () => async () => {},
}));
const billing = vi.hoisted(() => ({
  checkWalletBilling: vi.fn(), checkWalletBillingTx: vi.fn(), writeBillingDebit: vi.fn(), upsertTenantUser: vi.fn(), maybeNotifyDeficit: vi.fn(),
}));
vi.mock("../services/billing.service", () => billing);

import { walletRoutes } from "./wallets";

let pg: PGlite;
let app: FastifyInstance;
beforeAll(async () => {
  pg = await legacyDatabase(); await migrateWithCustodyV2(pg);
  state.db = drizzle(pg);
  app = Fastify(); await app.register(walletRoutes); await app.ready();
}, 30000);
beforeEach(async () => {
  Object.values(billing).forEach((f) => f.mockReset());
  await pg.exec(`TRUNCATE user_wallets RESTART IDENTITY`);
});
afterAll(async () => { await app?.close(); await pg?.close(); });

describe("sign-up wallet for a task-activation partner", () => {
  it("creates the wallet and links the learner to the partner without writing a charge", async () => {
    billing.checkWalletBilling.mockResolvedValue({ ok: true, eventType: "task_activation_partner" });
    billing.checkWalletBillingTx.mockResolvedValue({ ok: true, eventType: "task_activation_partner" });
    const res = await app.inject({ method: "POST", url: "/api/v1/wallets", payload: { name: "LMS", publicKey: `G${"H".repeat(55)}` } });
    expect(res.statusCode).toBe(200);
    expect(billing.writeBillingDebit).not.toHaveBeenCalled();
    expect(billing.upsertTenantUser).toHaveBeenCalledWith(expect.anything(), 2, 1);
  });

  it("other tenants are still charged at sign-up", async () => {
    const charge = { ok: true, eventType: "new_wallet_activation", amountXlm: "-3.0000000", policy: { id: 1, walletFundingEnabled: true, walletFundingXlm: "1.0000", newWalletPlatformFeeXlm: "2.0000" } };
    billing.checkWalletBilling.mockResolvedValue(charge);
    billing.checkWalletBillingTx.mockResolvedValue(charge);
    billing.writeBillingDebit.mockResolvedValue({ newBalance: "54.6" });
    billing.maybeNotifyDeficit.mockResolvedValue(undefined);
    const res = await app.inject({ method: "POST", url: "/api/v1/wallets", payload: { name: "LMS", publicKey: `G${"J".repeat(55)}` } });
    expect(res.statusCode).toBe(200);
    expect(billing.writeBillingDebit).toHaveBeenCalledTimes(1);
  });
});
