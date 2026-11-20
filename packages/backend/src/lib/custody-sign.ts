import { eq, sql } from "drizzle-orm";
import * as StellarSdk from "@stellar/stellar-sdk";
import { db, schema } from "../db";
import { verifyPassword } from "./auth";
import { appLog } from "./app-log";
import type { AuditAction } from "./audit";
import { CustodyRefused, withDelegatedKey } from "./custody-signer";
import { CUSTODY_NOT_AVAILABLE, custodyAllowedForUser, type CustodyFlags } from "./custody-flags";
import { DEFAULT_MAINNET_XLM_DAY_STROOPS, DEFAULT_MAINNET_XLM_TX_STROOPS, FEE_NOTE, checkStellarTx, custodyLimitsFromEnv, showTokenUnits, stellarDailyCost, TOKEN_REFUSED_ERROR, tokenOutflows, tokenOutflowsByClass, type CustodyLimits } from "./custody-limits";
import type { MasterKeyProvider } from "./key-wrapper";

let startupLimits: CustodyLimits | undefined;
/** Parses the custody limits from env once. Called at server start-up so a malformed value stops the server there instead of failing each request. */
export function initCustodyLimits(env: Record<string, string | undefined> = process.env): CustodyLimits {
  startupLimits = custodyLimitsFromEnv(env);
  return startupLimits;
}
const limitsOf = (o: { limits?: CustodyLimits }): CustodyLimits => o.limits ?? startupLimits ?? initCustodyLimits();

type Tx = StellarSdk.Transaction | StellarSdk.FeeBumpTransaction;
const innerOf = (tx: Tx) => (tx instanceof StellarSdk.FeeBumpTransaction ? tx.innerTransaction : tx);
/** The mainnet transaction rules for what is about to be signed: allow-listed operations, own-source only, fee ceiling, per-transaction cap. */
function mainnetTxRefusal(o: { tx: Tx; walletAddress: string; limits?: CustodyLimits }): Refusal | null {
  const cap = limitsOf(o).xlmTxStroops ?? DEFAULT_MAINNET_XLM_TX_STROOPS;
  const fee = BigInt(o.tx.fee);
  const over = checkStellarTx(cap, innerOf(o.tx).operations, { wallet: o.walletAddress, feeStroops: fee, tokens: limitsOf(o).tokens });
  return over ? { status: over.status, error: over.error } : null;
}

/**
 * Counts `cost` (XLM) and each issued asset in `tokens` against the user's 24-hour mainnet caps and records them (audit log rows) in one step under a per-user lock.
 * Refused without recording anything when any one would pass its cap. The audit rows are the usage ledger, so it survives restarts.
 */
async function reserveDay(userId: number, ops: readonly any[], cost: bigint, cap: bigint, limits: CustodyLimits, o: { ip?: string; userAgent?: string }): Promise<Refusal | null> {
  try {
    return await db.transaction(async (q) => {
      const tokens = tokenOutflows(ops);
      await q.execute(sql`SELECT pg_advisory_xact_lock(hashtext('custody-stellar-day'), ${userId})`);
      const res = await q.execute(sql`SELECT GREATEST(COALESCE(SUM((detail->>'stroops')::numeric), 0), 0)::text AS used FROM audit_logs
        WHERE user_id = ${userId} AND action = 'custody_stellar_sign' AND created_at > now() - interval '24 hours'`);
      const used = BigInt((((res as any).rows ?? res) as { used: string }[])[0]?.used ?? "0");
      if (used + cost > cap) return { status: 403, error: `That would go over the ${Number(cap) / 1e7} XLM daily limit for signing from an Amma-held wallet.${FEE_NOTE}` } as Refusal;
      for (const key of tokens.keys()) if (!limits.tokens?.has(key)) return { status: 403, error: TOKEN_REFUSED_ERROR } as Refusal;
      // Caps are per class (usd, zar): every token of a class counts against the same day total.
      for (const [cls, { amount, cap: tc }] of tokenOutflowsByClass(ops, limits.tokens ?? new Map())) {
        const r = await q.execute(sql`SELECT GREATEST(COALESCE(SUM((detail->>'units')::numeric), 0), 0)::text AS used FROM audit_logs
          WHERE user_id = ${userId} AND action = 'custody_stellar_token_sign' AND detail->>'cls' = ${cls} AND created_at > now() - interval '24 hours'`);
        const usedTok = BigInt((((r as any).rows ?? r) as { used: string }[])[0]?.used ?? "0");
        if (usedTok + amount > tc.dayUnits) return { status: 403, error: `That would go over the ${showTokenUnits(tc.dayUnits)} ${cls.toUpperCase()} daily limit for signing from an Amma-held wallet.${FEE_NOTE}` } as Refusal;
      }
      await q.insert(schema.auditLogs).values({ userId, action: "custody_stellar_sign" satisfies AuditAction, detail: { stroops: cost.toString() }, ipAddress: o.ip ?? null, userAgent: o.userAgent ?? null });
      for (const [key, amount] of tokens) {
        await q.insert(schema.auditLogs).values({ userId, action: "custody_stellar_token_sign" satisfies AuditAction, detail: { asset: key, cls: limits.tokens!.get(key)!.cls, units: amount.toString() }, ipAddress: o.ip ?? null, userAgent: o.userAgent ?? null });
      }
      return null;
    });
  } catch (e) {
    appLog().error({ code: typeof (e as any)?.code === "string" ? (e as any).code : "unknown" }, "custody_stellar_day_check_failed");
    return { status: 500, error: "The daily limit could not be checked, so nothing was signed." };
  }
}

/**
 * Gives back what signWithCustody reserved for `tx`, for a transaction Horizon definitely did not apply (a result code came back).
 * Never call it for a timeout or unknown outcome. The original audit row stays; a second, negative row under the same lock
 * offsets it, so the usage ledger keeps both facts. Failure to record is logged, not thrown: the user keeps the error they already have.
 */
export async function releaseCustodyDay(o: { flags: CustodyFlags; userId: number; tx: Tx; ip?: string; userAgent?: string }): Promise<void> {
  if (!o.flags.mainnet) return;
  try {
    const cost = stellarDailyCost(innerOf(o.tx).operations, BigInt(o.tx.fee));
    const tokens = tokenOutflows(innerOf(o.tx).operations);
    if (cost <= 0n && tokens.size === 0) return;
    await db.transaction(async (q) => {
      await q.execute(sql`SELECT pg_advisory_xact_lock(hashtext('custody-stellar-day'), ${o.userId})`);
      // The offset copies the reservation's own timestamp, so the pair enters and leaves the 24-hour window together.
      // It claims the oldest in-window reservation of this cost that nothing has offset yet (equal costs are interchangeable, and the
      // oldest leaves the window first, so the day is never under-counted). None found means nothing to give back.
      await q.execute(sql`INSERT INTO audit_logs (user_id, action, detail, ip_address, user_agent, created_at)
        SELECT r.user_id, 'custody_stellar_sign', jsonb_build_object('stroops', ${(-cost).toString()}::text, 'released', true, 'of', r.id), ${o.ip ?? null}, ${o.userAgent ?? null}, r.created_at
        FROM audit_logs r
        WHERE r.user_id = ${o.userId} AND r.action = 'custody_stellar_sign' AND r.detail->>'stroops' = ${cost.toString()}
          AND NOT EXISTS (SELECT 1 FROM audit_logs x WHERE x.user_id = r.user_id AND x.action = 'custody_stellar_sign' AND x.detail->>'of' = r.id::text)
          AND r.created_at > now() - interval '24 hours'
        ORDER BY r.id ASC LIMIT 1`);
      for (const [key, amount] of tokens) {
        if (amount <= 0n) continue;
        await q.execute(sql`INSERT INTO audit_logs (user_id, action, detail, ip_address, user_agent, created_at)
          SELECT r.user_id, 'custody_stellar_token_sign', jsonb_build_object('asset', ${key}::text, 'cls', r.detail->'cls', 'units', ${(-amount).toString()}::text, 'released', true, 'of', r.id), ${o.ip ?? null}, ${o.userAgent ?? null}, r.created_at
          FROM audit_logs r
          WHERE r.user_id = ${o.userId} AND r.action = 'custody_stellar_token_sign' AND r.detail->>'asset' = ${key} AND r.detail->>'units' = ${amount.toString()}
            AND NOT EXISTS (SELECT 1 FROM audit_logs x WHERE x.user_id = r.user_id AND x.action = 'custody_stellar_token_sign' AND x.detail->>'of' = r.id::text)
            AND r.created_at > now() - interval '24 hours'
          ORDER BY r.id ASC LIMIT 1`);
      }
    });
  } catch (e) {
    appLog().error({ code: typeof (e as any)?.code === "string" ? (e as any).code : "unknown" }, "custody_stellar_day_release_failed");
  }
}

export interface Refusal { status: 400 | 403 | 409 | 423 | 429 | 500; error: string }
const notAllowed: Refusal = { status: 403, error: CUSTODY_NOT_AVAILABLE };

/** Password check then signing, for routes that sign straight away. */
export async function custodySignStellar(o: CheckOpts): Promise<Refusal | null> {
  return (await checkCustodyPassword(o)) ?? (await signWithCustody(o));
}

type CheckOpts = {
  provider: MasterKeyProvider | null; flags: CustodyFlags; userId: number; password: string; walletAddress: string;
  tx: StellarSdk.Transaction | StellarSdk.FeeBumpTransaction; ip?: string; userAgent?: string;
  /** Mainnet custody mode only: the limits that cap native XLM leaving the wallet (default: from env). */
  limits?: CustodyLimits;
};

/** Thrown from inside the signing callback when a daily cap refuses, so withDelegatedKey records no signature. Never leaves signWithCustody. */
class DayCapRefused extends Error {
  constructor(public refusal: Refusal) { super("custody daily cap"); this.name = "DayCapRefused"; }
}

/** Signs `tx` in place with the phrase-derived key. Call only after checkCustodyPassword passed. */
export async function signWithCustody(o: Omit<CheckOpts, "password">): Promise<Refusal | null> {
  const { tx, userId } = o;
  if (!o.provider) return { status: 400, error: "Approving with your Amma password is switched off here." };
  if (!custodyAllowedForUser(o.flags, userId)) return notAllowed;
  if (o.flags.mainnet) {
    // The transaction actually being signed (for sign-and-submit that is the one with platform fee operations added), not only what the client sent.
    const bad = mainnetTxRefusal(o);
    if (bad) return bad;
  }
  try {
    await withDelegatedKey({ provider: o.provider, flags: o.flags, userId, chain: "stellar", expectedAddress: o.walletAddress, reason: "sign", ip: o.ip, userAgent: o.userAgent },
      async ({ stellarSecret }) => {
        // Reserved here, after withDelegatedKey's checks (frozen, self-signing, address) passed and right before the signature,
        // so a refused signing never uses part of the day.
        if (o.flags.mainnet) {
          const limits = limitsOf(o), ops = innerOf(tx).operations;
          const day = await reserveDay(userId, ops, stellarDailyCost(ops, BigInt(tx.fee)), limits.xlmDayStroops ?? DEFAULT_MAINNET_XLM_DAY_STROOPS, limits, o);
          if (day) throw new DayCapRefused(day);
        }
        tx.sign(StellarSdk.Keypair.fromSecret(stellarSecret!));
      });
    return null;
  } catch (e) {
    if (e instanceof DayCapRefused) return e.refusal;
    if (!(e instanceof CustodyRefused)) throw e;
    // Refused after the day was reserved: nothing was signed, so give the reservation back.
    if (o.flags.mainnet) await releaseCustodyDay({ flags: o.flags, userId, tx, ip: o.ip, userAgent: o.userAgent });
    switch (e.code) {
      case "off": return { status: 400, error: "Approving with your Amma password is switched off here." };
      case "self": return { status: 403, error: "Delegated signing is not enabled." };
      case "frozen": return { status: 423, error: "This account is frozen while a recovery request is waiting." };
      case "not-allowed": return notAllowed;
      default: return { status: 409, error: "Amma can't sign for this wallet. Use your wallet passphrase." };
    }
  }
}

const MAX_WRONG = 10;

/** Source check, per-user wrong-password limit (counted from the audit log, so it survives restarts and header tricks), then the password compare. */
export async function checkCustodyPassword(o: CheckOpts): Promise<Refusal | null> {
  const { tx, userId } = o;
  if (!custodyAllowedForUser(o.flags, userId)) return notAllowed;
  const source = tx instanceof StellarSdk.FeeBumpTransaction ? tx.innerTransaction.source : tx.source;
  if (source !== o.walletAddress) return { status: 403, error: "Transaction source does not match your active wallet" };
  if (o.flags.mainnet) {
    // Before the password is looked at or any attempt is recorded: a transaction the mainnet rules refuse is never signed here.
    const bad = mainnetTxRefusal(o);
    if (bad) return bad;
  }
  return checkCustodyPasswordOnly({ provider: o.provider, flags: o.flags, userId, password: o.password, ip: o.ip, userAgent: o.userAgent }, "stellar");
}

/** The same password step-up for chains with no Stellar transaction to inspect (XRP, Ethereum): flags, per-user limit, one attempt at a time, compare. */
export async function checkCustodyPasswordOnly(o: { provider: MasterKeyProvider | null; flags: CustodyFlags; userId: number; password: string; ip?: string; userAgent?: string }, chain: "stellar" | "xrpl" | "evm"): Promise<Refusal | null> {
  const { userId } = o;
  if (!o.provider || !o.flags.serverSigning) return { status: 400, error: "Approving with your Amma password is switched off here." };
  // Before the password is looked at, counted or recorded.
  if (!custodyAllowedForUser(o.flags, userId)) return notAllowed;

  try {
    return await db.transaction(async (q) => {
      // One attempt at a time per user (try-lock, so a parallel attempt gets 429 instead of queueing): count, compare and denial row all happen under this lock.
      const got = await q.execute(sql`SELECT pg_try_advisory_xact_lock(hashtext('custody-pw'), ${userId}) AS ok`);
      if (!(((got as any).rows ?? got) as { ok?: boolean }[])[0]?.ok) return { status: 429, error: "Another attempt is already in progress. Try again in a moment." } as Refusal;
      const res = await q.execute(sql`SELECT count(*)::int AS n FROM audit_logs WHERE user_id = ${userId} AND action = 'wallet_custody_sign_denied' AND created_at > now() - interval '15 minutes'`);
      if ((((res as any).rows ?? res) as { n: number }[])[0]?.n >= MAX_WRONG) return { status: 429, error: "Too many wrong passwords. Try again in 15 minutes." } as Refusal;
      const [user] = await q.select({ passwordHash: schema.users.passwordHash }).from(schema.users).where(eq(schema.users.id, userId)).limit(1);
      if (!user || !(await verifyPassword(o.password, user.passwordHash))) {
        // Not swallowed: if this insert fails the transaction rolls back and the attempt is refused below.
        await q.insert(schema.auditLogs).values({ userId, action: "wallet_custody_sign_denied" satisfies AuditAction, detail: { chain, why: "password" }, ipAddress: o.ip ?? null, userAgent: o.userAgent ?? null });
        return { status: 403, error: "That password is not correct." } as Refusal;
      }
      return null;
    });
  } catch (e) {
    appLog().error({ code: typeof (e as any)?.code === "string" ? (e as any).code : "unknown" }, "custody_password_check_failed");
    return { status: 500, error: "The attempt could not be recorded, so it was refused." };
  }
}
