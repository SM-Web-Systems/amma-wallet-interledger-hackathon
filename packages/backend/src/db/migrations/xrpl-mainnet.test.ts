import { afterEach, describe, expect, it } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import { legacyDatabase, migrate } from "./chain-storage.test-support";
import { applyPaymentStorage } from "./xrpl-payments";
import { applyReconciliationStorage } from "./xrpl-reconciliation";
import { applyIntegrationStorage } from "./xrpl-integration";
import { applyXrplMainnet } from "./xrpl-mainnet";
import type { MigrationConnection } from "./chain-storage";

let pg: PGlite;
const run = (apply: (c: MigrationConnection) => Promise<string>) => pg.transaction(tx => apply({ execute: async s => { await tx.exec(s); }, rows: async <T extends Record<string, unknown>>(s: string) => (await tx.query<T>(s)).rows }));
const insert = (network: string) => pg.query(`INSERT INTO xrpl_payments (id,user_id,wallet_id,network,idempotency_key,request_digest,reference,source,request)
  VALUES (gen_random_uuid(),1,(SELECT id FROM user_wallets LIMIT 1),$1,gen_random_uuid(),$2,gen_random_uuid(),'r','{}')`, [network, "d".repeat(64)]);
afterEach(async () => { await pg?.close(); });

describe("xrpl-mainnet-v1", { timeout: 60_000 }, () => {
  it("needs the payment, reconciliation and integration migrations first", async () => {
    pg = await legacyDatabase(); await migrate(pg);
    await expect(run(applyXrplMainnet)).rejects.toThrow("xrpl-payments-v1");
    await run(applyPaymentStorage);
    await expect(run(applyXrplMainnet)).rejects.toThrow("xrpl-reconciliation-v1");
    await run(applyReconciliationStorage);
    await expect(run(applyXrplMainnet)).rejects.toThrow("xrpl-integration-v1");
  });
  it("widens the payment network to mainnet, is idempotent and refuses a tampered marker", async () => {
    pg = await legacyDatabase(); await migrate(pg);
    for (const apply of [applyPaymentStorage, applyReconciliationStorage, applyIntegrationStorage]) await run(apply);
    await pg.query("INSERT INTO user_wallets (user_id, chain, network, public_key, name, is_active) VALUES (1,'xrpl','mainnet','rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh','w',true)");
    await expect(insert("mainnet")).rejects.toThrow();
    expect(await run(applyXrplMainnet)).toBe("applied");
    expect(await run(applyXrplMainnet)).toBe("already-applied");
    await insert("mainnet"); await insert("testnet");
    await expect(insert("devnet")).rejects.toThrow();
    // Tenant receipt claims stay testnet-only.
    const def = (await pg.query<{ def: string }>("SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conname='xrpl_claim_network'")).rows[0].def;
    expect(def).not.toContain("mainnet");
    await pg.exec("UPDATE amma_chain_migrations SET checksum='tampered' WHERE version='xrpl-mainnet-v1'");
    await expect(run(applyXrplMainnet)).rejects.toThrow("checksum mismatch");
  });
});
