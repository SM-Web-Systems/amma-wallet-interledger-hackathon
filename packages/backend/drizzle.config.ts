import { drizzleCommandRefusal, envAtStart } from "./src/db/drizzle-guard"; // first: captures ALLOW_DRIZZLE_PUSH before dotenv can add one from .env
import "dotenv/config";
import { defineConfig } from "drizzle-kit";

const refused = drizzleCommandRefusal(process.argv, envAtStart);
if (refused) throw new Error(refused);

if (!process.env.DATABASE_URL) {
  throw new Error("DATABASE_URL_DIRECT is required for migrations");
}

export default defineConfig({
  schema: "./src/db/schema/index.ts",
  out: "./drizzle",
  dialect: "postgresql",
  // Tables owned by the guarded SQL migrations (payment ledger, XRP migration
  // markers) are not in the Drizzle schema. Without this filter, `drizzle-kit
  // push` drops them, and without a TTY it does so without asking.
  tablesFilter: ["*", "!payment_*", "!amma_chain_migrations", "!wallet_key_escrow", "!wallet_key_recovery", "!welcome_funding", "!custody_evm_transfers", "!partner_signing_keys", "!partner_activation_settings", "!partner_tasks", "!partner_task_completions", "!wallet_activations", "!activation_reconciliations", "!eth_incoming_alerts", "!tenant_credit_balances", "!credit_ledger", "!business_wallets", "!fee_address_pool", "!business_deposits", "!fee_sweeps", "!business_activation_controls", "!business_alerts"],
  dbCredentials: {
    url: process.env.DATABASE_URL,
  },
});
