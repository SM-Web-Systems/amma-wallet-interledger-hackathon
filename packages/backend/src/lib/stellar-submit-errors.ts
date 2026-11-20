// Maps a Horizon submit rejection to a plain message for the user. Pure: it reads only the
// result codes (and the asset of the operation that failed), never the envelope XDR,
// addresses or the error message text.
export interface SubmitErrorReply {
  status: number;
  error: string;
  code: string;
  /** The problem is on Amma's side (platform fee account): the caller should alert, and the user gets a service message. */
  platform?: true;
}

export interface StellarResultCodes {
  transaction?: string;
  inner_transaction?: string;
  operations?: string[];
}

/** What the caller knows about the transaction that was submitted. */
export interface SubmitContext {
  /** True when the submitted envelope is a fee bump paid by the platform account. */
  feeBumped?: boolean;
  /** The inner transaction's operations, to name the asset of the one that failed. */
  operations?: readonly any[];
}

const TIMEOUT_MESSAGE = "The Stellar network didn't confirm in time. Check your history before trying again.";
const NOT_ENOUGH_XLM =
  "Not enough XLM. Your wallet must keep 1 XLM (plus 0.5 XLM for each token or offer) to stay open.";
const NO_TRUSTLINE = "The receiving account can't accept this asset yet (no trustline).";
const NO_DESTINATION_XLM = "That account doesn't exist yet. Send at least 1 XLM to create it.";
const NO_DESTINATION_ASSET = "The recipient must activate their account first.";
const PLATFORM_FEE = "Amma couldn't pay the network fee right now. Try again later.";

const KNOWN: Record<string, { status: number; error: string }> = {
  tx_insufficient_balance: { status: 400, error: NOT_ENOUGH_XLM },
  op_low_reserve: { status: 400, error: "That amount is too small to create a new account. Send at least 1 XLM." },
  op_no_trust: { status: 400, error: NO_TRUSTLINE },
  op_not_authorized: { status: 400, error: NO_TRUSTLINE },
  op_line_full: { status: 400, error: "The receiving account has reached its limit for this asset and can't accept more." },
  tx_bad_seq: { status: 409, error: "Your wallet was busy with another transaction. Try again." },
  tx_insufficient_fee: { status: 503, error: "The network is busy; the fee was too low. Try again." },
  tx_too_late: { status: 400, error: "This transaction expired. Try again." },
  tx_bad_auth: { status: 400, error: "The transaction signature was not accepted. Try again." },
  op_src_not_authorized: { status: 400, error: "Your account is not authorized to send this asset." },
};

/** Result codes from a Horizon error (stellar-sdk puts the problem body on response.data, or on response itself), or null. */
export function stellarResultCodes(error: any): StellarResultCodes | null {
  const extras = error?.response?.data?.extras ?? error?.response?.extras;
  const codes = extras?.result_codes;
  if (!codes || typeof codes !== "object") return null;
  const out: StellarResultCodes = {};
  if (typeof codes.transaction === "string") out.transaction = codes.transaction;
  if (typeof codes.inner_transaction === "string") out.inner_transaction = codes.inner_transaction;
  if (Array.isArray(codes.operations)) out.operations = codes.operations.filter((o: unknown) => typeof o === "string");
  return out;
}

/**
 * Thrown by submitStellarTx when the outcome is unknown: no answer, a timeout, or a Horizon 5xx without a result.
 * The transaction may still be on the ledger, so callers must not say it failed and must not release reservations.
 */
export class StellarSubmitUncertain extends Error {
  constructor() {
    super("Stellar submit outcome unknown");
    this.name = "StellarSubmitUncertain";
  }
}
/** Thrown when the recipient's memo requirement could not be looked up. Nothing was sent. */
export class StellarRecipientCheckFailed extends Error {
  constructor() {
    super("Stellar recipient check failed");
    this.name = "StellarRecipientCheckFailed";
  }
}
/** Errors that mean the transaction was never sent. */
export const isNeverSent = (error: unknown): boolean =>
  (error as any)?.name === "StellarRecipientCheckFailed" || (error as any)?.name === "AccountRequiresMemoError";
export const isSubmitUncertain =(error: unknown): boolean => (error as any)?.name === "StellarSubmitUncertain";

const isNativeAsset = (a: any): boolean => typeof a?.isNative === "function" ? a.isNative() : a?.code === "XLM" || a === "native";
const assetCodeOf = (a: any): string | null => {
  const code = typeof a?.getCode === "function" ? a.getCode() : a?.code;
  return typeof code === "string" && /^[A-Za-z0-9]{1,12}$/.test(code) ? code : null;
};
/** The asset an operation moves (payment asset, path payment send asset), or undefined when it has none. */
const assetOf = (op: any) => op?.type === "createAccount" ? "native" : op?.asset ?? op?.sendAsset;

/** null when the error is not a Horizon rejection or timeout (caller keeps its own 500). */
export function mapStellarSubmitError(error: any, ctx: SubmitContext = {}): SubmitErrorReply | null {
  if (isSubmitUncertain(error)) return { status: 504, error: TIMEOUT_MESSAGE, code: "timeout" };
  if (error?.name === "StellarRecipientCheckFailed") {
    return { status: 503, error: "Couldn't check the recipient right now. Try again.", code: "recipient_check_failed" };
  }
  if (error?.name === "AccountRequiresMemoError") {
    return { status: 400, error: "The receiving account requires a memo. Add the memo and try again.", code: "account_requires_memo" };
  }
  const codes = stellarResultCodes(error);
  if (!codes) return null;
  const outer = codes.transaction;
  if (ctx.feeBumped && (outer === "tx_insufficient_balance" || outer === "tx_insufficient_fee")) {
    return { status: 503, error: PLATFORM_FEE, code: outer, platform: true };
  }
  const opIndex = (codes.operations ?? []).findIndex((c) => c !== "op_success");
  const opCode = opIndex >= 0 ? codes.operations![opIndex] : undefined;
  const code = opCode ?? (outer === "tx_fee_bump_inner_failed" ? codes.inner_transaction : undefined) ?? outer;
  if (!code) return null;
  const asset = opIndex >= 0 ? assetOf(ctx.operations?.[opIndex]) : undefined;

  if (code === "op_no_destination") {
    return { status: 400, error: asset !== undefined && !isNativeAsset(asset) ? NO_DESTINATION_ASSET : NO_DESTINATION_XLM, code };
  }
  if (code === "op_already_exists") return { status: 400, error: "That account was just created. Send again.", code };
  if (code === "op_underfunded") {
    if (asset === undefined) return { status: 400, error: "Not enough funds for this payment.", code };
    if (isNativeAsset(asset)) return { status: 400, error: NOT_ENOUGH_XLM, code };
    const symbol = assetCodeOf(asset);
    return { status: 400, error: symbol ? `Not enough ${symbol}.` : "Not enough funds for this payment.", code };
  }
  const known = KNOWN[code];
  if (known) return { ...known, code };
  return { status: 400, error: `The Stellar network rejected this transaction (${code}).`, code };
}
