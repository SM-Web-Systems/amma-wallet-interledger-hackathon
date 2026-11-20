import { eq, sql } from "drizzle-orm";
import { db, schema } from "../db";
import { recoveryFreezeActive } from "./key-recovery";
import type { Refusal } from "./custody-sign";
import { importKind } from "./custody-import";
import { CUSTODY_NOT_AVAILABLE, custodyAllowedForUser, type CustodyFlags } from "./custody-flags";
import { networkOf, networksFor, type CustodyNetworks } from "./custody-networks";

const rowsOf = <T,>(r: any): T[] => (r?.rows ?? r) as T[];

/**
 * Everything that must hold before a send creates any row or opens any key: the account signs for itself on the server,
 * is not frozen by a recovery request, and `from` is one of its derived wallets (with the custody phrase) or one moved in from a device (with its own escrow row), on the right network.
 * withDelegatedKey checks the same things again at signing time.
 */
export async function custodyPreflight(o: { userId: number; chain: "stellar" | "xrpl" | "evm"; from: string; networks?: CustodyNetworks; flags?: CustodyFlags }): Promise<Refusal | null> {
  if (o.flags && !custodyAllowedForUser(o.flags, o.userId)) return { status: 403, error: CUSTODY_NOT_AVAILABLE };
  const [user] = await db.select({ signingMode: schema.users.signingMode }).from(schema.users).where(eq(schema.users.id, o.userId)).limit(1);
  if (!user || user.signingMode !== "delegated") return { status: 403, error: "Delegated signing is not enabled." };
  if (await recoveryFreezeActive(o.userId)) return { status: 423, error: "This account is frozen while a recovery request is waiting." };
  const network = networkOf(o.networks ?? networksFor({}), o.chain);
  const where = o.chain === "evm" ? sql`lower(public_key) = lower(${o.from})` : sql`public_key = ${o.from}`;
  const [wallet] = rowsOf<{ derivation_index: number | null }>(await db.execute(sql`SELECT derivation_index FROM user_wallets WHERE user_id = ${o.userId} AND chain = ${o.chain} AND network = ${network} AND ${where} ORDER BY derivation_index NULLS LAST LIMIT 1`));
  // Derived wallets need the account's custody phrase; wallets moved in from a device need their own import escrow row.
  const escrow = !wallet ? [] : typeof wallet.derivation_index === "number"
    ? rowsOf(await db.execute(sql`SELECT 1 FROM wallet_key_escrow WHERE user_id = ${o.userId} AND kind = 'phrase' AND origin = 'custody'`))
    : rowsOf(await db.execute(sql`SELECT 1 FROM wallet_key_escrow WHERE user_id = ${o.userId} AND kind = ${importKind(o.chain, o.from)} AND origin = 'import'`));
  if (!escrow.length) return { status: 403, error: "That is not one of your Amma-held wallets." };
  return null;
}
