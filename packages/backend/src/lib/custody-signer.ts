import { eq, sql } from "drizzle-orm";
import { Wallet } from "xrpl";
import { db, schema } from "../db";
import { auditLog } from "./audit";
import { CUSTODY_NOT_AVAILABLE, custodyAllowedForUser, type CustodyFlags } from "./custody-flags";
import { deriveAllChains } from "./one-phrase";
import { openFromEscrow, type MasterKeyProvider } from "./key-wrapper";
import { recoveryFreezeActive } from "./key-recovery";
import { importKind, keyFromImported, sameAddress } from "./custody-import";
import { networkOf, networksFor } from "./custody-networks";

export type CustodyChain = "stellar" | "xrpl" | "evm";

export class CustodyRefused extends Error {
  constructor(public code: "off" | "self" | "frozen" | "no-escrow" | "mismatch" | "not-allowed", message: string) { super(message); this.name = "CustodyRefused"; }
}

/**
 * Opens the user's escrowed phrase, or the secret of a wallet moved in from a device (audited by openFromEscrow before release), gets the key for one chain,
 * checks it belongs to expectedAddress, runs `use`, and records the signing. No phrase or key is logged or kept.
 */
export async function withDelegatedKey<T>(
  opts: { provider: MasterKeyProvider | null; flags: CustodyFlags; userId: number; chain: CustodyChain; expectedAddress: string; reason: string; ip?: string; userAgent?: string },
  use: (key: { stellarSecret?: string; xrplWallet?: Wallet; evmPrivateKey?: `0x${string}` }) => Promise<T>,
): Promise<T> {
  const { provider, flags, userId, chain, expectedAddress } = opts;
  if (!provider || !flags.serverSigning) throw new CustodyRefused("off", "Server signing is switched off.");
  // First: before any database read, escrow open or key derivation.
  if (!custodyAllowedForUser(flags, userId)) throw new CustodyRefused("not-allowed", CUSTODY_NOT_AVAILABLE);
  const [user] = await db.select({ signingMode: schema.users.signingMode }).from(schema.users).where(eq(schema.users.id, userId)).limit(1);
  if (!user || user.signingMode !== "delegated") throw new CustodyRefused("self", "This account signs on its owner's own device.");
  if (await recoveryFreezeActive(userId)) throw new CustodyRefused("frozen", "This account is frozen while a recovery request is waiting.");
  const rowOf = <R,>(r: any): R | undefined => (((r as any).rows ?? r) as R[])[0];
  const deny = async (): Promise<never> => {
    await auditLog("wallet_custody_sign_denied", { userId, detail: { chain, code: "mismatch" }, ip: opts.ip, userAgent: opts.userAgent });
    throw new CustodyRefused("mismatch", "The address does not belong to this account's recovery phrase.");
  };

  // The address must be one of this user's own wallet rows: derived from the account phrase (a recorded index) or moved in from a device (index null, with an import escrow row).
  const found = await db.execute(sql`SELECT derivation_index FROM user_wallets WHERE user_id = ${userId} AND chain = ${chain} AND network = ${networkOf(networksFor(flags), chain)}
    AND ${chain === "evm" ? sql`lower(public_key) = lower(${expectedAddress})` : sql`public_key = ${expectedAddress}`} ORDER BY derivation_index NULLS LAST LIMIT 1`);
  const wallet = rowOf<{ derivation_index: number | null }>(found);
  const index = wallet?.derivation_index;

  let key: { stellarSecret?: string; xrplWallet?: Wallet; evmPrivateKey?: `0x${string}` };
  if (typeof index === "number") {
    const row = rowOf<{ sealed: string }>(await db.execute(sql`SELECT sealed FROM wallet_key_escrow WHERE user_id = ${userId} AND kind = 'phrase' AND origin = 'custody'`));
    if (!row) throw new CustodyRefused("no-escrow", "No recovery phrase is stored for this account.");
    let phrase: string | null = await openFromEscrow(provider, row.sealed, { userId, kind: "phrase", reason: `custody-sign:${chain}:${index}`, ip: opts.ip, userAgent: opts.userAgent });
    const d = deriveAllChains(phrase, index);
    phrase = null;
    const matches = chain === "evm" ? d.evm.address.toLowerCase() === expectedAddress.toLowerCase()
      : chain === "stellar" ? d.stellar.publicKey === expectedAddress : d.xrpl.address === expectedAddress;
    if (!matches) return deny();
    key = chain === "stellar" ? { stellarSecret: d.stellar.secret() }
      : chain === "evm" ? { evmPrivateKey: d.evm.privateKey() }
      : { xrplWallet: (() => { const s = d.xrpl.seed(); return new Wallet(s.publicKey, s.privateKey); })() };
  } else {
    const kind = importKind(chain, expectedAddress);
    const imported = wallet ? rowOf<{ sealed: string }>(await db.execute(sql`SELECT sealed FROM wallet_key_escrow WHERE user_id = ${userId} AND kind = ${kind} AND origin = 'import'`)) : undefined;
    if (!imported) {
      const phrase = rowOf<{ sealed: string }>(await db.execute(sql`SELECT sealed FROM wallet_key_escrow WHERE user_id = ${userId} AND kind = 'phrase' AND origin = 'custody'`));
      if (!phrase) throw new CustodyRefused("no-escrow", "No recovery phrase is stored for this account.");
      return deny();
    }
    let secret: string | null = await openFromEscrow(provider, imported.sealed, { userId, kind, reason: `custody-sign:${chain}:import`, ip: opts.ip, userAgent: opts.userAgent });
    const derived = keyFromImported(chain, secret);
    secret = null;
    if (!derived || !sameAddress(chain, derived.address, expectedAddress)) return deny();
    key = derived.key;
  }
  const out = await use(key);
  await auditLog("wallet_custody_sign", { userId, detail: { chain, reason: opts.reason }, ip: opts.ip, userAgent: opts.userAgent });
  return out;
}
