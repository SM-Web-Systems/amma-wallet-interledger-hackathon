/**
 * Owner rule: no charge at sign-up, only for the completed task. A partner that uses task activation (it has a
 * partner_activation_settings row) is billed 3.1 XLM per activation; creating the learner's wallet at sign-up through
 * POST /api/v1/wallets must not bill it again (it used to debit 1 XLM funding + 2 XLM fee per account).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { drizzle } from "drizzle-orm/pglite";
import type { PGlite } from "@electric-sql/pglite";
import { activationDatabase } from "../db/migrations/activation.test-support";

const state = vi.hoisted(() => ({ db: undefined as any }));
vi.mock("../db", async () => ({ get db() { return state.db; }, schema: await import("../db/schema") }));
vi.mock("../lib/mailer", () => ({ sendEmail: vi.fn() }));

import { checkWalletBilling, checkWalletBillingTx } from "./billing.service";

let pg: PGlite;
beforeAll(async () => { pg = await activationDatabase(); state.db = drizzle(pg); }, 60_000);
afterAll(async () => { await pg?.close(); });

beforeEach(async () => {
  await pg.exec(`TRUNCATE partner_activation_settings, tenant_billing_policy, user_wallets CASCADE;
    DELETE FROM tenants;
    INSERT INTO tenants (id, slug, name, prepaid_xlm_balance) VALUES (1, 'lms', 'LMS', 57.6), (2, 'other', 'Other', 57.6);
    INSERT INTO tenant_billing_policy (tenant_id) VALUES (1), (2);
    INSERT INTO users (id, email, password_hash) VALUES (501, 'learner@example.test', 'x') ON CONFLICT DO NOTHING;`);
});

describe("sign-up wallet billing for task-activation partners", () => {
  it("does not bill a partner that uses task activation (pre-flight and in-transaction checks)", async () => {
    await pg.exec(`INSERT INTO partner_activation_settings (tenant_id, enabled, daily_cap, updated_by) VALUES (1, false, 34, 'test')`);
    expect(await checkWalletBilling({ tenantId: 1, userId: 501 })).toEqual({ ok: true, eventType: "task_activation_partner" });
    const inTx = await state.db.transaction((tx: any) => checkWalletBillingTx(tx, { tenantId: 1, userId: 501 }));
    expect(inTx).toEqual({ ok: true, eventType: "task_activation_partner" });
  });

  it("still bills a tenant without task activation as before (1 + 2 = 3 XLM for a new wallet)", async () => {
    const r = await checkWalletBilling({ tenantId: 2, userId: 501 });
    expect(r).toMatchObject({ ok: true, eventType: "new_wallet_activation", amountXlm: "-3.0000000" });
  });

  it("an inactive or suspended task partner is still refused", async () => {
    await pg.exec(`INSERT INTO partner_activation_settings (tenant_id, enabled, daily_cap, updated_by) VALUES (1, true, 34, 'test');
      UPDATE tenants SET is_active = false WHERE id = 1`);
    expect(await checkWalletBilling({ tenantId: 1, userId: 501 })).toMatchObject({ ok: false, httpStatus: 403 });
  });
});
