import * as StellarSdk from "@stellar/stellar-sdk";
import { addOpsWithFeeAdjustments, assetKey, fromStroops, perOpFee, planCharges, settleFees, toStroops, type FeePlan, type Receivable } from "./fee-rebuild";
import { MAX_MAINNET_TX_FEE_STROOPS } from "./custody-limits";
import { stellarResultCodes } from "./stellar-submit-errors";
import { bounded } from "./stellar-submit";

/** PLATFORM_FEE_PERCENT above this charges nothing at all (logged once at start-up). */
export const MAX_PLATFORM_FEE_PERCENT = 1;
/** PLATFORM_FEE_MIN_XLM above this (or negative, or not a number) charges nothing at all (logged once at start-up). */
export const MAX_PLATFORM_FEE_MIN_XLM = 1;
/** Bound on each Horizon read (platform account, floor price). */
export const PLATFORM_ACCOUNT_TIMEOUT_MS = 3_000;
/** At most this many issued assets are priced per transaction (one Horizon read each); above it, percentage only. */
export const MAX_PRICED_ASSETS = 3;
/** Stellar's limit on operations per transaction. */
const MAX_OPS = 100;
const TTL_MS = 60_000;
const MAX_DECISION_MS = 15 * 60_000;
const MAX_DECISIONS = 5_000;

type Paths = { call(): Promise<{ records: any[] }> };
type Horizon = {
  loadAccount(id: string): Promise<{ balances: any[] }>;
  strictReceivePaths?(source: StellarSdk.Asset[], dest: StellarSdk.Asset, amount: string): Paths;
};
type Warn = (ctx: Record<string, unknown>, msg: string) => void;
export type PlatformFeeOptions = {
  feePercent: number;
  /** Minimum fee in XLM (PLATFORM_FEE_MIN_XLM); for an issued asset, that many XLM's worth of it. */
  minFeeXlm: number;
  platformWallet: string;
  platformSecret: string;
  /** The user's wallet (the transaction source). */
  source: string;
  passphrase: string;
  horizon: Horizon;
  warn: Warn;
  now?: () => number;
  timeoutMs?: number;
};

// Platform trustlines known to be good (authorised, with room as last read), kept briefly.
const receivable = new Map<string, { room: bigint; until: number }>();
// Floor prices (asset units worth the XLM floor), kept briefly.
const prices = new Map<string, { floor: bigint; until: number }>();
// Fee decision per original envelope: a retry of the same envelope gets the same fee, so the same rebuilt hash.
type Decision = { plan: FeePlan & { tooMany: number }; until: number };
const decisions = new Map<string, Decision>();

export function resetPlatformFeeCaches(): void {
  receivable.clear();
  prices.clear();
  decisions.clear();
}

function remember(key: string, d: Decision, now: number): void {
  if (decisions.size >= MAX_DECISIONS) {
    for (const [k, v] of decisions) if (v.until <= now) decisions.delete(k);
    while (decisions.size >= MAX_DECISIONS) decisions.delete(decisions.keys().next().value!);
  }
  decisions.set(key, d);
}

/**
 * How much of `asset` buys `xlmFloor` stroops of XLM on the DEX (Horizon strict-receive paths, read only, bounded, cheapest record).
 * null when there is no answer, no path, or the read fails or is too slow: the caller then charges the percentage only.
 */
async function quoteFloor(h: Horizon, asset: StellarSdk.Asset, xlmFloor: bigint, now: number, ms: number): Promise<bigint | null> {
  const k = `${assetKey(asset)}:${xlmFloor}`;
  const c = prices.get(k);
  if (c && c.until > now) return c.floor;
  if (typeof h.strictReceivePaths !== "function") return null;
  try {
    const r = await bounded(h.strictReceivePaths([asset], StellarSdk.Asset.native(), fromStroops(xlmFloor)).call(), ms, () => new Error("floor price read timed out"));
    let best: bigint | null = null;
    for (const rec of r?.records ?? []) {
      if (typeof rec?.source_amount !== "string") continue;
      const v = toStroops(rec.source_amount);
      if (v > 0n && (best === null || v < best)) best = v;
    }
    if (best !== null) prices.set(k, { floor: best, until: now + TTL_MS });
    return best;
  } catch {
    return null;
  }
}

/** The platform account's balances, or null when the read fails or is slower than the bound. */
async function platformBalances(h: Horizon, wallet: string, ms: number): Promise<any[] | null> {
  try {
    const account = await bounded(h.loadAccount(wallet), ms, () => new Error("platform account read timed out"));
    return Array.isArray(account?.balances) ? account.balances : null;
  } catch {
    return null;
  }
}

/** Works out the fee plan. Reads (in parallel, each bounded) only what issued assets need; XLM needs no read. */
async function decide(ops: any[], o: PlatformFeeOptions, xlmFloor: bigint, now: () => number): Promise<FeePlan & { tooMany: number }> {
  const charges = planCharges(ops, o.feePercent, o.platformWallet);
  const issued = [...new Map(charges.filter((c) => !c.asset.isNative()).map((c) => [assetKey(c.asset), c.asset])).values()];
  const own = (a: StellarSdk.Asset) => a.getIssuer() === o.platformWallet;
  const known = (a: StellarSdk.Asset) => { const c = receivable.get(assetKey(a)); return !!c && c.until > now(); };
  const needLoad = issued.some((a) => !own(a) && !known(a));
  const ms = o.timeoutMs ?? PLATFORM_ACCOUNT_TIMEOUT_MS;
  // Bounded work per request: above MAX_PRICED_ASSETS issued assets nothing is priced (percentage only).
  const tooMany = issued.length > MAX_PRICED_ASSETS;
  const [floors, balances] = await Promise.all([
    Promise.all(issued.map((a) => (tooMany ? Promise.resolve(null) : quoteFloor(o.horizon, a, xlmFloor, now(), ms)))),
    needLoad ? platformBalances(o.horizon, o.platformWallet, ms) : Promise.resolve(undefined),
  ]);
  const floorByKey = new Map(issued.map((a, i) => [assetKey(a), floors[i]]));
  const canReceive = (a: StellarSdk.Asset, amount: bigint): Receivable => {
    if (own(a)) return "ok";
    const k = assetKey(a);
    const c = receivable.get(k);
    if (c && c.until > now() && c.room >= amount) return "ok";
    if (balances === null) return "unknown";
    if (balances === undefined) return "no"; // known good trustline, but not enough room left as last read
    const b = balances.find((x) => x.asset_code === a.getCode() && x.asset_issuer === a.getIssuer());
    if (!b || b.is_authorized === false) return "no";
    const room = toStroops(b.limit) - toStroops(b.balance) - toStroops(b.buying_liabilities ?? "0");
    receivable.set(k, { room, until: now() + TTL_MS });
    return room >= amount ? "ok" : "no";
  };
  const plan = settleFees(charges, {
    xlmFloor,
    floorOf: (a) => floorByKey.get(assetKey(a)) ?? { reason: tooMany ? "too_many_assets" : "no_price" },
    receivable: canReceive,
  });
  return { ...plan, tooMany: tooMany ? issued.length : 0 };
}

/** Only a plain time window can be carried over to the rebuilt transaction. Anything else (no maxTime, ledger bounds, min sequence, extra signers) is not rebuilt. */
function plainTimeWindow(tx: StellarSdk.Transaction): boolean {
  const tb = tx.timeBounds;
  if (!tb || tb.maxTime === "0") return false;
  // Rebuilt with Number(): above 2^53 the time bound would change, so the transaction is not rebuilt.
  if (BigInt(tb.maxTime) > 2n ** 53n || BigInt(tb.minTime) > 2n ** 53n) return false;
  if (tx.ledgerBounds || tx.minAccountSequence !== undefined) return false;
  if (tx.minAccountSequenceAge !== undefined && tx.minAccountSequenceAge.toString() !== "0") return false;
  if (tx.minAccountSequenceLedgerGap) return false;
  if (tx.extraSigners && tx.extraSigners.length > 0) return false;
  return true;
}

/**
 * The sign-and-submit platform fee step. Every send pays: payments and account creation pay the fee ON TOP (the recipient gets
 * exactly the amount typed), swaps pay it WITHIN the approved amount. See settleFees for the amounts.
 * Returns the original transaction unchanged (feeDetails null) whenever no fee is charged.
 */
export async function applyPlatformFee(
  tx: StellarSdk.Transaction | StellarSdk.FeeBumpTransaction,
  o: PlatformFeeOptions,
): Promise<{ finalTx: StellarSdk.Transaction | StellarSdk.FeeBumpTransaction; feeDetails: any }> {
  const none = { finalTx: tx, feeDetails: null };
  const { feePercent, platformWallet, minFeeXlm } = o;
  if (!(feePercent > 0) || !platformWallet || !o.platformSecret || tx instanceof StellarSdk.FeeBumpTransaction) return none;
  if (feePercent > MAX_PLATFORM_FEE_PERCENT) return none; // logged once at start-up
  if (!(Number.isFinite(minFeeXlm) && minFeeXlm >= 0 && minFeeXlm <= MAX_PLATFORM_FEE_MIN_XLM)) return none; // logged once at start-up
  const ops: any[] = tx.operations || [];
  if (planCharges(ops, feePercent, platformWallet).length === 0) return none;
  const skip = (reason: string) => {
    o.warn({ reason }, "platform_fee_skipped");
    return none;
  };
  // A v0 envelope fails open: no fee.
  if (tx.toEnvelope().switch() !== StellarSdk.xdr.EnvelopeType.envelopeTypeTx()) return skip("envelope_v0");
  if (!plainTimeWindow(tx)) return skip("preconditions");

  const now = o.now ?? Date.now;
  const xlmFloor = toStroops(minFeeXlm.toFixed(7));
  const key = `${tx.hash().toString("hex")}:${feePercent}:${xlmFloor}:${platformWallet}`;
  let d = decisions.get(key);
  if (!d || d.until <= now()) {
    const plan = await decide(ops, o, xlmFloor, now);
    // Kept while the original envelope can still be submitted (at least 60 s, at most 15 min).
    const until = Math.max(now() + TTL_MS, Math.min(Number(tx.timeBounds!.maxTime) * 1000, now() + MAX_DECISION_MS));
    d = { plan, until };
    remember(key, d, now());
  }
  const { reduce, payments, notes, tooMany } = d.plan;
  if (tooMany) o.warn({ count: tooMany }, "platform_fee_too_many_assets");
  for (const u of notes.unpriced) if (u.reason !== "too_many_assets") o.warn(u, "platform_fee_floor_unpriced");
  for (const asset of notes.floorCapped) o.warn({ asset }, "platform_fee_floor_capped");
  for (const asset of notes.xlmFallback) o.warn({ asset }, "platform_fee_in_xlm_fallback");
  for (const asset of notes.horizon) o.warn({ reason: "horizon", asset }, "platform_fee_skipped");
  if (payments.length === 0) return none;

  if (ops.length + payments.length > MAX_OPS) return skip("op_limit");
  const rate = perOpFee(tx);
  // Over the custody fee cap signWithCustody would refuse the whole send: submit it without the fee instead.
  if (BigInt(rate) * BigInt(ops.length + payments.length) > MAX_MAINNET_TX_FEE_STROOPS) return skip("fee_cap");

  // Rebuild transaction with fee operations appended
  // Same sequence number as the client's envelope: a retry of one review can then apply only once.
  const account = new StellarSdk.Account(o.source, (BigInt(tx.sequence) - 1n).toString());
  const builder = new StellarSdk.TransactionBuilder(account, { fee: rate, networkPassphrase: o.passphrase });
  // The original operations; only swaps are reduced (by their fee). Direct sends are copied unchanged from the XDR.
  addOpsWithFeeAdjustments(builder, ops, reduce, tx.toEnvelope().v1().tx().operations());
  // The platform fee payments, one per asset, from the user's own account.
  for (const p of payments) {
    builder.addOperation(StellarSdk.Operation.payment({ destination: platformWallet, asset: p.asset, amount: p.amount }));
  }
  // Keep the sender's memo (exchange deposits depend on it)
  if (tx.memo && tx.memo.type !== "none") builder.addMemo(tx.memo);
  // The client's own time window, unchanged: no fresh window, and the same envelope rebuilds to the same hash.
  builder.setTimebounds(Number(tx.timeBounds!.minTime), Number(tx.timeBounds!.maxTime));
  const finalTx = builder.build();

  return {
    finalTx,
    feeDetails: {
      feePercent,
      minFeeXlm,
      // xlmFallbackFor: on the XLM line, the assets whose fee is paid in XLM because the platform wallet can't receive them.
      feeOperations: payments.map((p) => ({ asset: p.asset.isNative() ? "XLM" : p.asset.getCode(), amount: p.amount, xlmFallbackFor: p.asset.isNative() ? notes.xlmFallback : [] })),
      xlmFallback: notes.xlmFallback,
      platformWallet,
    },
  };
}

/**
 * The fee step as both routes run it: sign-and-submit (for real) and fee-quote (dry run, nothing signed or sent).
 * Any error inside it means no fee (logged platform_fee_skipped, reason "error"): the fee machinery never breaks a send.
 * Quote and charge for the same envelope are IDENTICAL, not "within a tolerance": the decision is cached per original
 * transaction hash (until the envelope expires, at least 60 s), so the second run reuses the first one's plan and rebuilds
 * the same transaction. If that cache entry is gone (server restart, eviction, >15 min), the plan is worked out again and may
 * differ (price moved); sign-and-submit then refuses with 409 fee_changed when the client sent the quoted hash as expectedHash.
 */
export async function platformFeeStep(
  tx: StellarSdk.Transaction | StellarSdk.FeeBumpTransaction,
  o: PlatformFeeOptions,
): Promise<{ finalTx: StellarSdk.Transaction | StellarSdk.FeeBumpTransaction; feeDetails: any }> {
  try {
    return await applyPlatformFee(tx, o);
  } catch (e: any) {
    o.warn({ reason: "error", errorName: e?.name }, "platform_fee_skipped");
    return { finalTx: tx, feeDetails: null };
  }
}

/**
 * sign-and-submit's fee step. The fee is charged ONLY when the client sent the fee quote's innerHash (expectedHash), and the
 * rebuilt transaction must have exactly that hash (else 409 fee_changed, nothing signed).
 * TODO(remove after the web release that sends expectedHash has been live for one full release, PR #261): a request WITHOUT
 * expectedHash comes from an old web bundle (open tab) or an API client that never saw the fee. It is submitted UNCHANGED, with no
 * fee, so its hash matches the client's own lookup (no "did not go through" for a payment that went through, no double pay).
 */
export async function feeForSubmit(
  tx: StellarSdk.Transaction | StellarSdk.FeeBumpTransaction,
  expectedHash: string | undefined,
  o: PlatformFeeOptions,
): Promise<{ finalTx: any; feeDetails: any; innerHash: string; refused?: { status: 409; code: "fee_changed"; error: string } }> {
  if (!expectedHash) {
    if (o.feePercent > 0 && o.platformWallet && o.platformSecret) o.warn({ reason: "no_expected_hash" }, "platform_fee_skipped");
    return { finalTx: tx, feeDetails: null, innerHash: tx.hash().toString("hex") };
  }
  const { finalTx, feeDetails } = await platformFeeStep(tx, o);
  const innerHash = finalTx.hash().toString("hex");
  if (innerHash !== expectedHash) {
    return { finalTx, feeDetails, innerHash, refused: { status: 409, code: "fee_changed", error: "The Amma fee for this payment changed. Check the new fee and confirm again." } };
  }
  return { finalTx, feeDetails, innerHash };
}

/** Result codes on the fee payment that mean the platform wallet can't receive the asset (stale trustline answer). */
const TRUSTLINE_CODES = new Set(["op_no_trust", "op_not_authorized", "op_line_full", "op_no_destination"]);
/** The result code on the fee payment that means the user has too little for the amount plus the fee (a payment never returns op_low_reserve). */
const FUNDS_CODES = new Set(["op_underfunded"]);

/**
 * After a definite rejection: was the failing operation one of the fee payments appended after the client's `originalOps`
 * operations? kind "trustline" (op_no_trust, op_not_authorized, op_line_full, op_no_destination): the platform wallet can't take
 * the asset any more, so the cached trustline answer and the cached plans paying in it are dropped (the next envelope reads Horizon
 * again and pays in XLM if needed). kind "funds" (op_underfunded): the user has too little for amount plus fee (for XLM: above the reserve);
 * nothing is dropped. Resubmitting the same envelope without the fee is NOT possible: a transaction that failed on the ledger has
 * used its sequence number.
 */
export function feePaymentFailure(finalTx: StellarSdk.Transaction, originalOps: number, error: unknown): { asset: string; code: string; kind: "trustline" | "funds" } | null {
  const codes = stellarResultCodes(error);
  const ops = codes?.operations ?? [];
  const i = ops.findIndex((c) => c !== "op_success");
  if (i < originalOps || i < 0) return null;
  const op: any = finalTx.operations[i];
  if (op?.type !== "payment" || !op.asset) return null;
  const code = ops[i];
  const asset = op.asset.isNative() ? "XLM" : op.asset.getCode();
  if (FUNDS_CODES.has(code)) return { asset, code, kind: "funds" };
  if (!TRUSTLINE_CODES.has(code)) return null;
  const k = assetKey(op.asset);
  receivable.delete(k);
  // Cached plans that pay in this asset relied on the stale answer (their retries re-decide; a changed result is a 409 fee_changed).
  for (const [key, d] of decisions) if (d.plan.payments.some((p) => assetKey(p.asset) === k)) decisions.delete(key);
  return { asset, code, kind: "trustline" };
}

/**
 * What the transaction takes out of the user's wallet, per asset (send operations only, fee payments included).
 * upTo: a strict-receive swap is counted at its sendMax, the most it can cost.
 */
export function userPays(operations: readonly any[]): { asset: string; issuer?: string; amount: string; upTo: boolean }[] {
  const sums = new Map<string, { asset: StellarSdk.Asset; stroops: bigint; upTo: boolean }>();
  for (const op of operations) {
    let asset: StellarSdk.Asset, amount: string, upTo = false;
    if (op.type === "payment") [asset, amount] = [op.asset, op.amount];
    else if (op.type === "createAccount") [asset, amount] = [StellarSdk.Asset.native(), op.startingBalance];
    else if (op.type === "pathPaymentStrictSend") [asset, amount] = [op.sendAsset, op.sendAmount];
    else if (op.type === "pathPaymentStrictReceive") [asset, amount, upTo] = [op.sendAsset, op.sendMax, true];
    else continue;
    const k = assetKey(asset);
    const prev = sums.get(k);
    sums.set(k, { asset, stroops: (prev?.stroops ?? 0n) + toStroops(amount), upTo: (prev?.upTo ?? false) || upTo });
  }
  return [...sums.values()].map((s) => ({
    asset: s.asset.isNative() ? "XLM" : s.asset.getCode(),
    ...(s.asset.isNative() ? {} : { issuer: s.asset.getIssuer() }),
    amount: fromStroops(s.stroops),
    upTo: s.upTo,
  }));
}

/** Wraps the signed inner transaction in a fee bump: the platform pays the network fee and signs only the bump. */
export function feeBumpFor(inner: StellarSdk.Transaction, platformSecret: string, passphrase: string): StellarSdk.FeeBumpTransaction {
  const platformKeypair = StellarSdk.Keypair.fromSecret(platformSecret);
  const feeBump = StellarSdk.TransactionBuilder.buildFeeBumpTransaction(
    platformKeypair, // fee source — platform pays
    StellarSdk.BASE_FEE, // max fee per operation
    inner, // inner transaction (already signed)
    passphrase,
  );
  feeBump.sign(platformKeypair);
  return feeBump;
}
