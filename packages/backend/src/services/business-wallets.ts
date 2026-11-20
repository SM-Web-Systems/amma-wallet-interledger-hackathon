/**
 * Business wallets and fee addresses (BUSINESS_WALLETS=on; owner decisions of 16 Nov 2026).
 *
 * Each business has one Amma-held Stellar wallet per network. Its deposits land there and its activations are paid from it.
 * The secret is made here, sealed at once with the master key provider (bound to business, network and address) and never
 * stored, logged or returned in plain text, except to the activation rail after an audit row is written.
 *
 * Fees go to the owner's hardware wallet. Its public addresses sit in fee_address_pool, and each business is given the next
 * free one the first time it funds its account (or a named one, as for the LMS). Only public addresses are stored.
 */
import { sql } from "drizzle-orm";
import { Keypair, StrKey } from "@stellar/stellar-sdk";
import { appLog } from "../lib/app-log";
import { sealBound, unsealBound, type MasterKeyProvider } from "../lib/key-wrapper";
import type { AuditAction } from "../lib/audit";
import { iso, rowsOf, type ActivationDb } from "../modules/activation/errors";

// The same row shape as the activation module's auditInTx, written on the caller's connection or transaction.
const auditInTx = async (tx: Pick<ActivationDb, "execute">, action: AuditAction, userId: number | null, detail: Record<string, unknown>) =>
  tx.execute(sql`INSERT INTO audit_logs (user_id, action, detail) VALUES (${userId}, ${action}, ${JSON.stringify(detail)}::jsonb)`);

export type StellarNetwork = "testnet" | "public";
export const FEE_POOL_LOW = 5;

const NETWORKS = new Set<StellarNetwork>(["testnet", "public"]);
const checkNetwork = (network: string): StellarNetwork => {
  if (!NETWORKS.has(network as StellarNetwork)) throw new Error("Network must be testnet or public");
  return network as StellarNetwork;
};
const checkActor = (who: string): string => {
  if (!who || who.length > 80) throw new Error("Say who is acting (1 to 80 characters)");
  return who;
};

/** The sealed secret can only be opened for the business, network and address it was made for. */
export const businessWalletContext = (tenantId: number, network: StellarNetwork, address: string) =>
  `amma-business-wallet:v1:${tenantId}:${network}:${address}`;

/** Makes the business's wallet on this network, or returns the one it already has. Only the public address comes back. */
export async function createBusinessWallet(db: ActivationDb, provider: MasterKeyProvider, input: { tenantId: number; network: StellarNetwork; createdBy: string }): Promise<{ address: string; created: boolean }> {
  const network = checkNetwork(input.network);
  const createdBy = checkActor(input.createdBy);
  return db.transaction(async (tx) => {
    const tenant = rowsOf<{ id: string }>(await tx.execute(sql`SELECT id FROM tenants WHERE id = ${input.tenantId} FOR UPDATE`))[0];
    if (!tenant) throw new Error("No such business");
    const live = rowsOf<{ address: string }>(await tx.execute(sql`SELECT address FROM business_wallets WHERE tenant_id = ${input.tenantId} AND network = ${network} AND retired_at IS NULL`))[0];
    if (live) return { address: live.address, created: false };
    const keypair = Keypair.random();
    const address = keypair.publicKey();
    const sealed = await sealBound(provider, keypair.secret(), businessWalletContext(input.tenantId, network, address));
    await tx.execute(sql`INSERT INTO business_wallets (tenant_id, network, address, sealed_secret, provider, created_by) VALUES (${input.tenantId}, ${network}, ${address}, ${sealed}, ${provider.id}, ${createdBy})`);
    await auditInTx(tx, "business_wallet_created", null, { tenantId: input.tenantId, network, address, provider: provider.id, by: createdBy });
    return { address, created: true };
  });
}

/** The business's live wallet address on this network, or null. */
export async function businessWalletAddress(db: Pick<ActivationDb, "execute">, tenantId: number, network: StellarNetwork): Promise<string | null> {
  return rowsOf<{ address: string }>(await db.execute(sql`SELECT address FROM business_wallets WHERE tenant_id = ${tenantId} AND network = ${network} AND retired_at IS NULL`))[0]?.address ?? null;
}

/**
 * Opens the business wallet's secret for the activation rail. The audit row is committed first; if it cannot be written the
 * secret is not released. The opened secret must match the stored address. Returns null when the business has no live wallet.
 */
export async function openBusinessWallet(db: ActivationDb, provider: MasterKeyProvider, input: { tenantId: number; network: StellarNetwork; reason: string }): Promise<{ walletId: number; address: string; secret: string } | null> {
  const network = checkNetwork(input.network);
  const row = rowsOf<{ id: string; address: string; sealed_secret: string }>(await db.execute(sql`
    SELECT id, address, sealed_secret FROM business_wallets WHERE tenant_id = ${input.tenantId} AND network = ${network} AND retired_at IS NULL`))[0];
  if (!row) return null;
  const secret = await unsealBound(provider, row.sealed_secret, businessWalletContext(input.tenantId, network, row.address));
  if (!StrKey.isValidEd25519SecretSeed(secret) || Keypair.fromSecret(secret).publicKey() !== row.address) throw new Error("This business wallet key does not match its address");
  try {
    await auditInTx(db, "business_wallet_key_open", null, { tenantId: input.tenantId, network, address: row.address, reason: input.reason, provider: provider.id });
  } catch {
    throw new Error("The access could not be audited, so the business wallet key was not released.");
  }
  return { walletId: Number(row.id), address: row.address, secret };
}

/** Loads hardware wallet addresses into the pool. Public keys only; anything else is refused before anything is written. */
export async function addFeeAddresses(db: ActivationDb, input: { network: StellarNetwork; addresses: string[]; addedBy: string }): Promise<{ added: number; alreadyThere: number }> {
  const network = checkNetwork(input.network);
  const addedBy = checkActor(input.addedBy);
  const addresses = [...new Set(input.addresses.map((a) => a.trim()).filter(Boolean))];
  // A secret seed starts with S and would fail this check, so one pasted by mistake is never stored or echoed.
  const bad = addresses.filter((a) => !StrKey.isValidEd25519PublicKey(a)).length;
  if (bad) throw new Error(`${bad} entr${bad === 1 ? "y is" : "ies are"} not a Stellar public address (G...); nothing was added`);
  return db.transaction(async (tx) => {
    let added = 0;
    for (const address of addresses) {
      const inserted = rowsOf(await tx.execute(sql`INSERT INTO fee_address_pool (network, address, added_by) VALUES (${network}, ${address}, ${addedBy}) ON CONFLICT (address) DO NOTHING RETURNING id`));
      if (inserted.length) { added++; await auditInTx(tx, "fee_address_added", null, { network, address, by: addedBy }); }
    }
    return { added, alreadyThere: addresses.length - added };
  });
}

/**
 * Gives the business its fee address on this network: the one it already has, else the named pool address, else the oldest
 * free one. Called when a business first funds its account. Warns when fewer than FEE_POOL_LOW free addresses are left.
 */
export async function assignFeeAddress(db: ActivationDb, input: { tenantId: number; network: StellarNetwork; now: Date; address?: string; by: string }): Promise<{ address: string; assigned: boolean; free: number }> {
  const network = checkNetwork(input.network);
  const by = checkActor(input.by);
  if (input.address !== undefined && !StrKey.isValidEd25519PublicKey(input.address)) throw new Error("Not a Stellar public address (G...)");
  const result = await db.transaction(async (tx) => {
    const tenant = rowsOf(await tx.execute(sql`SELECT id FROM tenants WHERE id = ${input.tenantId} FOR UPDATE`))[0];
    if (!tenant) throw new Error("No such business");
    const free = async () => Number(rowsOf<{ n: number }>(await tx.execute(sql`SELECT count(*)::int AS n FROM fee_address_pool WHERE network = ${network} AND tenant_id IS NULL`))[0].n);
    const current = rowsOf<{ address: string }>(await tx.execute(sql`SELECT address FROM fee_address_pool WHERE tenant_id = ${input.tenantId} AND network = ${network}`))[0];
    if (current) {
      if (input.address && input.address !== current.address) throw new Error("This business already has a different fee address; change it by hand with the owner's go");
      return { address: current.address, assigned: false, free: await free() };
    }
    const pick = rowsOf<{ id: string; address: string; tenant_id: string | null }>(await tx.execute(input.address
      ? sql`SELECT id, address, tenant_id FROM fee_address_pool WHERE address = ${input.address} AND network = ${network} FOR UPDATE`
      : sql`SELECT id, address, tenant_id FROM fee_address_pool WHERE network = ${network} AND tenant_id IS NULL ORDER BY id FOR UPDATE SKIP LOCKED LIMIT 1`))[0];
    if (!pick) throw new Error(input.address ? "That address is not in the fee address pool for this network" : "No free fee address is left; add hardware wallet addresses to the pool");
    if (pick.tenant_id !== null) throw new Error("That fee address already belongs to another business");
    await tx.execute(sql`UPDATE fee_address_pool SET tenant_id = ${input.tenantId}, assigned_at = ${iso(input.now)}::timestamptz WHERE id = ${Number(pick.id)}`);
    await auditInTx(tx, "fee_address_assigned", null, { tenantId: input.tenantId, network, address: pick.address, by });
    return { address: pick.address, assigned: true, free: await free() };
  });
  if (result.free < FEE_POOL_LOW) appLog().warn({ network, free: result.free }, "fee_address_pool_low");
  return result;
}

/**
 * For the activation worker: the rail that pays from a business's own wallet. The key is opened (and audited) once per
 * process and wallet; a retired or replaced wallet is noticed on the next call and the new one is opened.
 */
export function businessRailSource<R>(db: ActivationDb, provider: MasterKeyProvider, network: StellarNetwork, makeRail: (secret: string) => R): (tenantId: number) => Promise<R | null> {
  const cache = new Map<number, { walletId: number; rail: R }>();
  return async (tenantId) => {
    const live = rowsOf<{ id: string }>(await db.execute(sql`SELECT id FROM business_wallets WHERE tenant_id = ${tenantId} AND network = ${network} AND retired_at IS NULL`))[0];
    if (!live) { cache.delete(tenantId); return null; }
    const hit = cache.get(tenantId);
    if (hit && hit.walletId === Number(live.id)) return hit.rail;
    const opened = await openBusinessWallet(db, provider, { tenantId, network, reason: "activation-rail" });
    if (!opened) { cache.delete(tenantId); return null; }
    const rail = makeRail(opened.secret);
    cache.set(tenantId, { walletId: opened.walletId, rail });
    return rail;
  };
}
