import { chainStorageChecksum, chainStorageVersion } from "./migrations/chain-storage";
import { paymentStorageChecksum, paymentStorageVersion } from "./migrations/xrpl-payments";
import { reconciliationStorageChecksum, reconciliationStorageVersion } from "./migrations/xrpl-reconciliation";
import { integrationStorageChecksum, integrationStorageVersion } from "./migrations/xrpl-integration";
import { interledgerPaymentsChecksum, interledgerPaymentsVersion } from "./migrations/interledger-payments";
import { keyEscrowChecksum, keyEscrowVersion } from "./migrations/key-escrow";
import { keyRecoveryChecksum, keyRecoveryVersion } from "./migrations/key-recovery";
import { flagOn } from "../lib/custody-flags";
import { activationOn } from "../lib/activation-flags";
import { custodyChecksum, custodyVersion } from "./migrations/custody";
import { custodyV2Checksum, custodyV2Version } from "./migrations/custody-v2";
import { custodyV3Checksum, custodyV3Version } from "./migrations/custody-v3";
import { custodyV4Checksum, custodyV4Version } from "./migrations/custody-v4";
import { custodyV5Checksum, custodyV5Version } from "./migrations/custody-v5";
import { activationV1Checksum, activationV1Version } from "./migrations/activation-v1";
import { creditsV1Checksum, creditsV1Version } from "./migrations/credits-v1";
import { businessWalletsV1Checksum, businessWalletsV1Version } from "./migrations/business-wallets-v1";
import { businessDepositsV1Checksum, businessDepositsV1Version } from "./migrations/business-deposits-v1";
import { feeSweepsV1Checksum, feeSweepsV1Version } from "./migrations/fee-sweeps-v1";
import { activationRequirementsV1Checksum, activationRequirementsV1Version } from "./migrations/activation-requirements-v1";
import { businessControlsV1Checksum, businessControlsV1Version } from "./migrations/business-controls-v1";
import { xrplMainnetChecksum, xrplMainnetVersion } from "./migrations/xrpl-mainnet";
import { xrplMainnetCustodyOn } from "../lib/custody-networks";
import { ethAlertsChecksum, ethAlertsVersion } from "./migrations/eth-alerts";
import { oidcNonceChecksum, oidcNonceVersion } from "./migrations/oidc-nonce";

// Deploy-time schema gate. The release must not restart the API on code whose
// schema has not been applied by the reviewed, guarded migrations. Nothing here
// changes the database: it only compares markers and required columns.

export interface Marker { version: string; checksum: string }
export interface SchemaFacts { markerTable: boolean; markers: Marker[]; columns: string[]; validIndexes?: string[] }
export interface GateResult { ok: boolean; problems: string[]; required: string[]; warnings?: string[] }

const known: Record<string, string> = {
  [chainStorageVersion]: chainStorageChecksum,
  [paymentStorageVersion]: paymentStorageChecksum,
  [reconciliationStorageVersion]: reconciliationStorageChecksum,
  [integrationStorageVersion]: integrationStorageChecksum,
  [interledgerPaymentsVersion]: interledgerPaymentsChecksum,
  [keyEscrowVersion]: keyEscrowChecksum,
  [keyRecoveryVersion]: keyRecoveryChecksum,
  [custodyVersion]: custodyChecksum,
  [custodyV2Version]: custodyV2Checksum,
  [custodyV3Version]: custodyV3Checksum,
  [custodyV4Version]: custodyV4Checksum,
  [custodyV5Version]: custodyV5Checksum,
  [activationV1Version]: activationV1Checksum,
  [creditsV1Version]: creditsV1Checksum,
  [businessWalletsV1Version]: businessWalletsV1Checksum,
  [businessDepositsV1Version]: businessDepositsV1Checksum,
  [feeSweepsV1Version]: feeSweepsV1Checksum,
  [activationRequirementsV1Version]: activationRequirementsV1Checksum,
  [businessControlsV1Version]: businessControlsV1Checksum,
  [xrplMainnetVersion]: xrplMainnetChecksum,
  [ethAlertsVersion]: ethAlertsChecksum,
  [oidcNonceVersion]: oidcNonceChecksum,
};

// Columns the always-on code paths read, as "table.column".
export const requiredColumns = [
  "user_wallets.chain", "tx_history.chain", "tx_history.network", "address_book.chain", "address_book.network",
  // PR #1 credit idempotency: packages/backend/migrations/001_add_idempotency_key.sql
  "billing_events.idempotency_key",
  // oidc-nonce-v1: declared in the Drizzle tokenRegistry table, so every OAuth code insert and lookup reads it.
  "token_registry.nonce",
];
// Indexes that must exist and be valid (a failed CREATE INDEX CONCURRENTLY leaves an invalid one).
export const requiredIndexes = ["uq_billing_credit_idempotency"];
// custody-v2: read by every custody send (lib/custody-signer.ts, lib/custody-preflight.ts) and, because the Drizzle schema declares it,
// by every full-row user_wallets query. A marker row does not prove it survived (drizzle-kit push drops undeclared columns), so it
// is required with every flag setting.
export const custodyColumns = ["user_wallets.derivation_index"];
export const custodyIndexes = ["idx_user_wallets_derivation"];

const on = (env: NodeJS.ProcessEnv, key: string) => env[key] === "true";

export function requiredMarkers(env: NodeJS.ProcessEnv): string[] {
  const required = [chainStorageVersion];
  if (on(env, "XRPL_PAYMENTS_ENABLED") || on(env, "XRPL_RECONCILIATION_ENABLED") || on(env, "XRPL_INTEGRATION_ENABLED")) required.push(paymentStorageVersion);
  if (on(env, "XRPL_RECONCILIATION_ENABLED") || on(env, "XRPL_INTEGRATION_ENABLED")) required.push(reconciliationStorageVersion);
  if (on(env, "XRPL_INTEGRATION_ENABLED")) required.push(integrationStorageVersion);
  if (on(env, "PAYMENTS_ENABLED")) required.push(interledgerPaymentsVersion);
  if (env.KEY_WRAP_PROVIDER) required.push(keyEscrowVersion, keyRecoveryVersion);
  if (flagOn(env.CUSTODY_SERVER_SIGNING) || flagOn(env.WELCOME_FUNDING)) required.push(custodyVersion, custodyV2Version, custodyV3Version, custodyV4Version, custodyV5Version);
  if (activationOn(env)) required.push(activationV1Version);
  // Business credit plans (monthly and annual bundles, pots, credit ledger) build on activation-v1.
  if (env.BUSINESS_CREDITS === "on") required.push(...[activationV1Version].filter((v) => !required.includes(v)), creditsV1Version);
  // Business wallets (a Stellar wallet per business, the fee address pool) build on credits-v1.
  if (env.BUSINESS_WALLETS === "on") required.push(...[activationV1Version, creditsV1Version].filter((v) => !required.includes(v)), businessWalletsV1Version);
  if (env.BUSINESS_DEPOSITS === "on") required.push(...[activationV1Version, creditsV1Version, businessWalletsV1Version].filter((v) => !required.includes(v)), businessDepositsV1Version);
  if (env.BUSINESS_FEE_SWEEPS === "on") required.push(...[activationV1Version, creditsV1Version, businessWalletsV1Version, businessDepositsV1Version].filter((v) => !required.includes(v)), feeSweepsV1Version);
  // The balance floor, pause and alerts build on credits-v1.
  if (env.BUSINESS_CONTROLS === "on") required.push(...[activationV1Version, creditsV1Version].filter((v) => !required.includes(v)), businessControlsV1Version);
  // The self-serve business page reads all of the business tables.
  if (env.BUSINESS_PAGE === "on") required.push(...[activationV1Version, creditsV1Version, businessWalletsV1Version, businessDepositsV1Version, feeSweepsV1Version].filter((v) => !required.includes(v)));
  // XRP for Amma-held wallets on mainnet: the send path writes the payment, reconciliation and integration columns, on the widened network.
  if (xrplMainnetCustodyOn(env)) for (const v of [paymentStorageVersion, reconciliationStorageVersion, integrationStorageVersion, xrplMainnetVersion]) if (!required.includes(v)) required.push(v);
  // Incoming Ethereum payment alerts need their table (and, before it, the custody migrations).
  if (env.ETH_ALERTS === "on") required.push(...[custodyVersion, custodyV2Version, custodyV3Version, custodyV4Version, custodyV5Version].filter((v) => !required.includes(v)), ethAlertsVersion);
  return required;
}

/** allowNewerMarkers is for API start-up only: a marker this build does not know means the database is newer (forward migration, then a restart or rollback), which must not stop the API. deploy.sh stays strict. */
export function evaluateSchema(facts: SchemaFacts, env: NodeJS.ProcessEnv, options: { allowNewerMarkers?: boolean } = {}): GateResult {
  const required = requiredMarkers(env);
  const problems: string[] = [];
  const warnings: string[] = [];
  if (!facts.markerTable) problems.push("amma_chain_migrations is missing: run the reviewed guarded migrations first");
  const applied = new Map(facts.markers.map((m) => [m.version, m.checksum]));
  for (const [version, checksum] of applied) {
    if (!(version in known)) { (options.allowNewerMarkers ? warnings : problems).push(`unrecognized migration marker ${version}: this build is older than the database`); }
    else if (known[version] !== checksum) problems.push(`checksum mismatch for ${version}`);
  }
  for (const version of required) if (!applied.has(version)) problems.push(`required migration ${version} has not been applied`);
  const present = new Set(facts.columns);
  for (const column of [...requiredColumns, ...custodyColumns]) if (!present.has(column)) problems.push(`missing column ${column}`);
  const valid = new Set(facts.validIndexes ?? []);
  for (const index of [...requiredIndexes, ...custodyIndexes]) if (!valid.has(index)) problems.push(`missing or invalid index ${index}`);
  return { ok: problems.length === 0, problems, required, ...(warnings.length ? { warnings } : {}) };
}

export type Rows = <T extends Record<string, unknown>>(statement: string) => Promise<T[]>;

/** Reads only catalog metadata and marker rows; never customer data. */
export async function readSchemaFacts(rows: Rows): Promise<SchemaFacts> {
  const [{ name }] = await rows<{ name: string | null }>("SELECT to_regclass('public.amma_chain_migrations')::text AS name");
  const markers = name ? await rows<Marker & Record<string, unknown>>("SELECT version, checksum FROM amma_chain_migrations") : [];
  const tables = [...new Set([...requiredColumns, ...custodyColumns].map((c) => c.split(".")[0]))].map((t) => `'${t}'`).join(",");
  const columns = (await rows<{ c: string }>(
    `SELECT table_name || '.' || column_name AS c FROM information_schema.columns WHERE table_schema='public' AND table_name IN (${tables})`,
  )).map((r) => r.c);
  const names = [...requiredIndexes, ...custodyIndexes].map((i) => `'${i}'`).join(",");
  const validIndexes = (await rows<{ name: string }>(
    `SELECT c.relname AS name FROM pg_index i JOIN pg_class c ON c.oid=i.indexrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND i.indisvalid AND c.relname IN (${names})`,
  )).map((r) => r.name);
  return { markerTable: Boolean(name), markers: markers.map(({ version, checksum }) => ({ version, checksum })), columns, validIndexes };
}

export interface StartupGateResult extends GateResult { skipped?: true; unreadable?: true }

/**
 * The same read-only gate deploy.sh runs (same requiredMarkers(env)), for API start-up; the caller exits on a real problem.
 * - A read failure, or a read slower than timeoutMs, is "unreadable": one fixed problem (driver errors can contain the
 *   connection string). The caller serves as it did before this gate existed: a database that is down is not a wrong schema.
 * - A marker newer than this build is allowed, so a restart or rollback after a forward migration still starts.
 * - SCHEMA_GATE_AT_START=off skips it only when NODE_ENV is exactly "development" or "test" (an unset NODE_ENV on a host does not open it).
 */
export async function startupSchemaGate(rows: Rows, env: NodeJS.ProcessEnv, timeoutMs = 5000): Promise<StartupGateResult> {
  if (env.SCHEMA_GATE_AT_START === "off" && (env.NODE_ENV === "development" || env.NODE_ENV === "test")) return { ok: true, problems: [], required: [], skipped: true };
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const facts = await Promise.race([
      readSchemaFacts(rows),
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("timeout")), timeoutMs); }),
    ]);
    return evaluateSchema(facts, env, { allowNewerMarkers: true });
  } catch {
    return { ok: false, problems: ["the schema gate could not read the database"], required: requiredMarkers(env), unreadable: true };
  } finally {
    clearTimeout(timer);
  }
}
