import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { purgeOldAuditLogs, RETAINED_AUDIT_ACTIONS } from "./audit-retention";

let pg: PGlite;
let db: any;
const seed = (action: string, daysAgo: number) =>
  pg.query(`INSERT INTO audit_logs (user_id, action, created_at) VALUES (1, $1, now() - ($2 || ' days')::interval)`, [action, String(daysAgo)]);
const actions = async () => (await pg.query(`SELECT action FROM audit_logs`)).rows.map((r: any) => r.action as string).sort();

beforeAll(async () => {
  pg = new PGlite();
  await pg.exec(`CREATE TABLE audit_logs (
    id bigserial PRIMARY KEY, user_id integer, action varchar(50) NOT NULL, detail jsonb DEFAULT '{}',
    ip_address varchar(45), user_agent text, created_at timestamp DEFAULT now())`);
  db = drizzle(pg);
}, 60000);
beforeEach(async () => { await pg.exec("TRUNCATE audit_logs RESTART IDENTITY"); });
afterAll(async () => { await pg?.close(); });

describe("audit log retention", () => {
  it("lists the custody and recovery actions", () => {
    expect([...RETAINED_AUDIT_ACTIONS].sort()).toEqual([
      "custody_limit_refused", "custody_lms_claim_signed", "custody_onboard", "custody_pin_copy_removed", "custody_send", "custody_stellar_sign", "custody_stellar_token_sign", "custody_wallet_added", "custody_wallet_imported", "custody_wallet_updated", "key_recovery_cancelled", "key_recovery_code_sent", "key_recovery_completed",
      "key_recovery_denied", "key_recovery_requested", "wallet_custody_sign", "wallet_custody_sign_denied",
      "wallet_key_backup_read", "wallet_key_escrow_denied", "wallet_key_escrow_open", "wallet_key_escrow_save",
      // Task-gated activation: grants and refunds are financial evidence.
      "activation_failed", "activation_funded", "activation_refunded", "activation_rejected", "activation_requested",
      "partner_signing_key_added", "partner_signing_key_revoked", "partner_task_changed",
    ].sort());
  });

  it("deletes an old login row", async () => {
    await seed("login", 100);
    await purgeOldAuditLogs(db);
    expect(await actions()).toEqual([]);
  });

  it("keeps old rows of every retained action", async () => {
    for (const a of RETAINED_AUDIT_ACTIONS) await seed(a, 400);
    await seed("login", 400);
    await purgeOldAuditLogs(db);
    expect(await actions()).toEqual([...RETAINED_AUDIT_ACTIONS].sort());
  });

  it("keeps new rows of any action", async () => {
    await seed("login", 1); await seed("wallet_custody_sign", 1);
    await purgeOldAuditLogs(db);
    expect(await actions()).toEqual(["login", "wallet_custody_sign"]);
  });

  it("honours the now argument for the 90-day cutoff", async () => {
    await seed("login", 10);
    await purgeOldAuditLogs(db, new Date(Date.now() + 100 * 86400000));
    expect(await actions()).toEqual([]);
  });
});
