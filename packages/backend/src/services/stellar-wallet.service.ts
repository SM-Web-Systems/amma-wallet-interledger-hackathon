import { and, eq } from "drizzle-orm";
import { db, schema } from "../db";
import { config } from "../config";

/** Shared by legacy signing and signing-mode changes; never selects XRP keys. */
export async function findActiveStellarWallet(userId: number) {
  const [wallet] = await db.select().from(schema.userWallets).where(and(
    eq(schema.userWallets.userId, userId),
    eq(schema.userWallets.chain, "stellar"),
    eq(schema.userWallets.network, config.STELLAR_NETWORK),
    eq(schema.userWallets.isActive, true),
  )).limit(1);
  return wallet;
}
