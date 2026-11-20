import { StrKey } from "@stellar/stellar-sdk";
import { mainnetCustodyOn } from "./custody-networks";

/** Stage 0b-lite send limits for Amma-held (custody) wallets. Testnet defaults (lower ones in mainnet custody mode), overridable from env. */
export interface CustodyLimits {
  xrpTxDrops: bigint; xrpDayDrops: bigint; xrpNewRecipientDrops: bigint;
  evmTxWei: bigint; evmDayWei: bigint; evmNewRecipientWei: bigint;
  /** Fixed testnet ceiling for the fee per gas (and priority fee per gas) the RPC may suggest. */
  evmMaxFeeWei: bigint;
  /** Cap on native XLM leaving a wallet in one server-signed transaction. Mainnet custody mode only; testnet has none. */
  xlmTxStroops?: bigint;
  /** Cap on native XLM (plus fees) leaving a user's Amma-held Stellar wallets in 24 hours of server-signing. Mainnet custody mode only. */
  xlmDayStroops?: bigint;
  /** Mainnet custody mode only: the stablecoins an Amma-held Stellar wallet may send, keyed "CODE:ISSUER", each with its own caps. Any other issued asset is refused. */
  tokens?: ReadonlyMap<string, TokenCap>;
}
export type StableClass = "usd" | "zar";
/** Caps for one allowed token, in 1e-7 units (1 unit of a stablecoin = 1 USD or 1 ZAR). */
export interface TokenCap { code: string; issuer: string; cls: StableClass; txUnits: bigint; dayUnits: bigint }
type Env = Record<string, string | undefined>;

const XRP = 1_000_000n;
const ETH = 1_000_000_000_000_000_000n;
const XLM = 10_000_000n;
export const DEFAULT_MAINNET_XLM_TX_STROOPS = 10n * XLM;
export const DEFAULT_MAINNET_XLM_DAY_STROOPS = 50n * XLM;
/** The most a server-signed mainnet transaction may bid in fees (0.1 XLM); the fee counts toward the daily cap. */
export const MAX_MAINNET_TX_FEE_STROOPS = 1_000_000n;

function positive(env: Env, name: string, fallback: bigint): bigint {
  const raw = env[name];
  if (raw === undefined || raw === "") return fallback;
  if (!/^[0-9]{1,40}$/.test(raw.trim())) throw new Error(`${name} must be a whole number more than 0.`);
  const v = BigInt(raw.trim());
  if (v <= 0n) throw new Error(`${name} must be a whole number more than 0.`);
  return v;
}

/** Parses an exact decimal with at most 7 places ("1", "0.5", "10.0000001") into 1e-7 units. No floats, no signs, no exponents. */
export function parseDecimal7(raw: string, name: string): bigint {
  const t = raw.trim();
  if (!/^[0-9]{1,12}(\.[0-9]{1,7})?$/.test(t)) throw new Error(`${name} must be an amount above 0 with at most 7 decimal places.`);
  const [w, f = ""] = t.split(".");
  const v = BigInt(w) * XLM + BigInt(f.padEnd(7, "0"));
  if (v <= 0n) throw new Error(`${name} must be an amount above 0 with at most 7 decimal places.`);
  return v;
}
function amountEnv(env: Env, name: string, fallback: string): bigint {
  const raw = env[name];
  return parseDecimal7(raw === undefined || raw === "" ? fallback : raw, name);
}

/** Stablecoins allowed by default: only issuers verified from the issuer's own stellar.toml (see docs/operations/mainnet-token-caps.md). */
export const DEFAULT_MAINNET_TOKEN_CAPS = "USDC:GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN:usd";

/**
 * CUSTODY_MAINNET_TOKEN_CAPS: comma separated CODE:ISSUER:CLASS entries, CLASS usd or zar. Unset or empty means DEFAULT_MAINNET_TOKEN_CAPS; "none" allows no token.
 * Anything malformed throws, so start-up stops. Caps come from CUSTODY_CAP_{USD,ZAR}_{TX,DAY} (exact decimals).
 */
export function parseTokenCaps(env: Env): Map<string, TokenCap> {
  const name = "CUSTODY_MAINNET_TOKEN_CAPS";
  const caps = {
    usd: { txUnits: amountEnv(env, "CUSTODY_CAP_USD_TX", "1"), dayUnits: amountEnv(env, "CUSTODY_CAP_USD_DAY", "5") },
    zar: { txUnits: amountEnv(env, "CUSTODY_CAP_ZAR_TX", "10"), dayUnits: amountEnv(env, "CUSTODY_CAP_ZAR_DAY", "50") },
  };
  const out = new Map<string, TokenCap>();
  const raw = (env[name] ?? "").trim();
  if (raw === "none") return out;
  for (const entry of (raw === "" ? DEFAULT_MAINNET_TOKEN_CAPS : raw).split(",")) {
    const parts = entry.trim().split(":");
    const [code, issuer, cls] = parts;
    if (parts.length !== 3 || !/^[A-Za-z0-9]{1,12}$/.test(code) || !StrKey.isValidEd25519PublicKey(issuer) || (cls !== "usd" && cls !== "zar"))
      throw new Error(`${name} must be CODE:ISSUER:CLASS entries separated by commas (CLASS is usd or zar).`);
    const key = `${code}:${issuer}`;
    if (out.has(key)) throw new Error(`${name} lists ${code} twice.`);
    out.set(key, { code, issuer, cls, ...caps[cls] });
  }
  return out;
}

export function custodyLimitsFromEnv(env: Env = process.env): CustodyLimits {
  const mainnet = mainnetCustodyOn(env);
  const xrpTxDrops = positive(env, "CUSTODY_LIMIT_XRP_TX_DROPS", (mainnet ? 5n : 100n) * XRP);
  const xrpDayDrops = positive(env, "CUSTODY_LIMIT_XRP_DAY_DROPS", (mainnet ? 20n : 500n) * XRP);
  const evmTxWei = positive(env, "CUSTODY_LIMIT_EVM_TX_WEI", mainnet ? ETH / 500n : ETH / 20n);
  const evmDayWei = positive(env, "CUSTODY_LIMIT_EVM_DAY_WEI", mainnet ? ETH / 100n : ETH / 5n);
  return {
    ...(mainnet ? {
      xlmTxStroops: positive(env, "CUSTODY_LIMIT_XLM_TX_STROOPS", DEFAULT_MAINNET_XLM_TX_STROOPS),
      xlmDayStroops: positive(env, "CUSTODY_LIMIT_XLM_DAY_STROOPS", DEFAULT_MAINNET_XLM_DAY_STROOPS),
      tokens: parseTokenCaps(env),
    } : {}),
    xrpTxDrops, xrpDayDrops, evmTxWei, evmDayWei,
    evmMaxFeeWei: positive(env, "CUSTODY_EVM_MAX_FEE_GWEI", 100n) * 1_000_000_000n,
    xrpNewRecipientDrops: positive(env, "CUSTODY_NEW_RECIPIENT_MAX_XRP_DROPS", xrpTxDrops),
    evmNewRecipientWei: positive(env, "CUSTODY_NEW_RECIPIENT_MAX_EVM_WEI", evmTxWei),
  };
}

export interface LimitRefusal { status: 403; error: string; limit: "tx" | "day" | "new_recipient" }
export interface LimitCheck { amount: bigint; sentToday: bigint; newRecipient: boolean }

type Caps = { tx: bigint; day: bigint; fresh: bigint; unit: string; show: (v: bigint) => string };
function check(c: Caps, o: LimitCheck): LimitRefusal | null {
  if (o.amount > c.tx) return { status: 403, limit: "tx", error: `That is more than the ${c.show(c.tx)} ${c.unit} limit for one payment.` };
  if (o.newRecipient && o.amount > c.fresh) return { status: 403, limit: "new_recipient", error: `A first payment to a new address is limited to ${c.show(c.fresh)} ${c.unit}.` };
  if (o.sentToday + o.amount > c.day) return { status: 403, limit: "day", error: `That would go over the ${c.show(c.day)} ${c.unit} daily limit.` };
  return null;
}

const showUnits = (unit: bigint) => (v: bigint) => {
  const whole = v / unit, frac = (v % unit).toString().padStart(unit.toString().length - 1, "0").replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : `${whole}`;
};

export const checkXrpLimits = (l: CustodyLimits, o: LimitCheck) =>
  check({ tx: l.xrpTxDrops, day: l.xrpDayDrops, fresh: l.xrpNewRecipientDrops, unit: "XRP", show: showUnits(XRP) }, o);
export const checkEvmLimits = (l: CustodyLimits, o: LimitCheck) =>
  check({ tx: l.evmTxWei, day: l.evmDayWei, fresh: l.evmNewRecipientWei, unit: "ETH", show: showUnits(ETH) }, o);

/** "10.0000001" -> stroops. Stellar amounts have at most 7 decimals. */
const stroops = (amount: string): bigint => { const [w, f = ""] = amount.split("."); return BigInt(w || "0") * XLM + BigInt(f.padEnd(7, "0").slice(0, 7) || "0"); };

type StellarOp = { type: string; [k: string]: any };
const isNative = (a: any) => !!a && typeof a.isNative === "function" && a.isNative();

/** The only operation types the server signs for an Amma-held wallet on mainnet. Everything else (setOptions, merges, contract calls, offers, pools, sponsorship, data, clawback...) is refused. */
export const MAINNET_SIGNABLE_OPS: readonly string[] = ["payment", "createAccount", "pathPaymentStrictSend", "pathPaymentStrictReceive", "changeTrust"];

/** First operation whose own source account is set and is not `wallet` (null when none). Applies on every network: a foreign source would be authorised by whichever key co-signs. */
export function foreignSourceOp(operations: readonly StellarOp[], wallet: string): StellarOp | null {
  for (const op of operations) if (op.source && op.source !== wallet) return op;
  return null;
}
export const FOREIGN_SOURCE_ERROR = "Operations on someone else's account can't be signed here.";

/** Native XLM an operation list can move out, in stroops (path payments count the send side's maximum). */
export function stellarOutflow(operations: readonly StellarOp[]): bigint {
  let out = 0n;
  for (const op of operations) {
    if (op.type === "payment" && isNative(op.asset)) out += stroops(op.amount);
    else if (op.type === "createAccount") out += stroops(op.startingBalance);
    else if (op.type === "pathPaymentStrictSend" && isNative(op.sendAsset)) out += stroops(op.sendAmount);
    else if (op.type === "pathPaymentStrictReceive" && isNative(op.sendAsset)) out += stroops(op.sendMax);
  }
  return out;
}

export const TOKEN_REFUSED_ERROR = "This token can't be sent from an Amma-held wallet yet.";

/** The issued asset an operation sends out of the wallet and how much (path payments count the send side's maximum). Key "CODE:ISSUER", or "?" when it can't be read (always refused). */
function tokenSend(op: StellarOp): { key: string; amount: bigint } | null {
  let asset: any, amount: string;
  if (op.type === "payment") { asset = op.asset; amount = op.amount; }
  else if (op.type === "pathPaymentStrictSend") { asset = op.sendAsset; amount = op.sendAmount; }
  else if (op.type === "pathPaymentStrictReceive") { asset = op.sendAsset; amount = op.sendMax; }
  else return null;
  if (isNative(asset)) return null;
  if (!asset || typeof asset.code !== "string" || typeof asset.issuer !== "string") return { key: "?", amount: 0n };
  return { key: `${asset.code}:${asset.issuer}`, amount: stroops(String(amount)) };
}
/** Issued-asset amounts an operation list can send out, per "CODE:ISSUER", from the final transaction. */
export function tokenOutflows(operations: readonly StellarOp[]): Map<string, bigint> {
  const out = new Map<string, bigint>();
  for (const op of operations) { const t = tokenSend(op); if (t) out.set(t.key, (out.get(t.key) ?? 0n) + t.amount); }
  return out;
}

/** Issued-asset outflow summed per class (usd, zar): every token of a class shares that class's caps. Tokens not in `tokens` are skipped (checkStellarTx refuses them first). */
export function tokenOutflowsByClass(operations: readonly StellarOp[], tokens: ReadonlyMap<string, TokenCap>): Map<StableClass, { amount: bigint; cap: TokenCap }> {
  const out = new Map<StableClass, { amount: bigint; cap: TokenCap }>();
  for (const [key, amount] of tokenOutflows(operations)) {
    const cap = tokens.get(key);
    if (cap) out.set(cap.cls, { amount: (out.get(cap.cls)?.amount ?? 0n) + amount, cap });
  }
  return out;
}

/**
 * Mainnet custody mode: what one server-signed Stellar transaction may do. Allow-list of operation types (see MAINNET_SIGNABLE_OPS), no operation
 * with another account as its source, a ceiling on the fee bid, a cap on native XLM moved out (native payments, account creation, path payments),
 * and for issued assets: only the configured stablecoins (ctx.tokens), with the per-transaction cap of its class (usd, zar) shared by all tokens of that class in the transaction. Fails closed when ctx.tokens is missing.
 * changeTrust moves no value and stays allowed.
 */
export function checkStellarTx(capStroops: bigint, operations: readonly StellarOp[], ctx: { wallet: string; feeStroops?: bigint; tokens?: ReadonlyMap<string, TokenCap> }): LimitRefusal | null {
  for (const op of operations) {
    if (!MAINNET_SIGNABLE_OPS.includes(op.type)) return { status: 403, limit: "tx", error: "That kind of transaction can't be signed by Amma for an Amma-held wallet on mainnet." };
    const t = tokenSend(op);
    if (t && !ctx.tokens?.has(t.key)) return { status: 403, limit: "tx", error: TOKEN_REFUSED_ERROR };
  }
  if (foreignSourceOp(operations, ctx.wallet)) return { status: 403, limit: "tx", error: FOREIGN_SOURCE_ERROR };
  if (ctx.feeStroops !== undefined && ctx.feeStroops > MAX_MAINNET_TX_FEE_STROOPS) return { status: 403, limit: "tx", error: "That transaction's network fee is higher than Amma allows." };
  // The Amma platform fee payment is outflow too, so the limit includes it (PR #261).
  if (stellarOutflow(operations) > capStroops) return { status: 403, limit: "tx", error: `That is more than the ${showUnits(XLM)(capStroops)} XLM limit for one payment.${FEE_NOTE}` };
  for (const [cls, { amount, cap }] of tokenOutflowsByClass(operations, ctx.tokens!)) {
    if (amount > cap.txUnits) return { status: 403, limit: "tx", error: `That is more than the ${showUnits(XLM)(cap.txUnits)} ${cls.toUpperCase()} limit for one payment.${FEE_NOTE}` };
  }
  return null;
}
export const showTokenUnits = showUnits(XLM);
/** Appended to Stellar cap refusals: the Amma fee payment counts toward the caps. */
export const FEE_NOTE = " This limit includes the Amma fee.";

/** What a server-signed transaction counts against the daily cap: the native XLM it can move out plus its fee bid. */
export const stellarDailyCost = (operations: readonly StellarOp[], feeStroops: bigint): bigint => stellarOutflow(operations) + feeStroops;
