import type { AccountSnapshot, FeeSnapshot } from "../modules/xrpl/read-adapter";
import type { XrplNetwork } from "../modules/xrpl/config";
import type { CustodyFlags } from "./custody-flags";
import { custodyPreflight } from "./custody-preflight";
import { networksFor, xrplCustodyAllowed } from "./custody-networks";

/**
 * Activation of an XRP Ledger account: it exists on the ledger once it holds at least the base reserve.
 * This is the read-only interface the activation-funding service (built separately) calls before and after funding a wallet
 * when its owner completes an eligible task. Nothing here moves money.
 */
export interface XrplActivation {
  address: string;
  network: XrplNetwork;
  activated: boolean;
  balanceDrops: string;
  /** The account's full reserve now (base + owner reserve per owned object); for an unactivated account, the base reserve. */
  reserveDrops: string;
  spendableDrops: string;
  /** The ledger base reserve. */
  baseReserveDrops: string;
  /** Fee a funding payment would pay right now. */
  feeDrops: string;
  /** Exact drops a funder must spend to activate the account: base reserve + fee. "0" once activated. */
  neededDrops: string;
  validatedLedgerIndex: number;
}

export type ActivationReader = { getAccount(address: string): Promise<AccountSnapshot>; getFee(): Promise<FeeSnapshot> };

/** Reads one address. Throws the reader's own errors (XrplReadError) when the ledger cannot be read; never guesses a zero balance. */
export async function xrplActivationStatus(reader: ActivationReader, address: string): Promise<XrplActivation> {
  const [account, fee] = await Promise.all([reader.getAccount(address), reader.getFee()]);
  const base = account.baseReserveDrops ?? (account.funded ? undefined : account.reserveDrops);
  if (base === undefined || account.network !== fee.network) throw new Error("XRP activation could not be read consistently.");
  return {
    address: account.address, network: account.network, activated: account.funded,
    balanceDrops: account.balanceDrops, reserveDrops: account.reserveDrops, spendableDrops: account.spendableDrops,
    baseReserveDrops: base, feeDrops: fee.feeDrops,
    neededDrops: account.funded ? "0" : (BigInt(base) + BigInt(fee.feeDrops)).toString(),
    validatedLedgerIndex: account.validatedLedgerIndex,
  };
}

export type CustodyActivationResult = { ok: true; activation: XrplActivation } | { ok: false; status: number; error: string };

/**
 * The same, only for one of this user's own Amma-held XRP wallets on the network custody runs on (testnet, or mainnet with XRPL_MAINNET_CUSTODY=on).
 * Refuses (no ledger read) for anyone outside the mainnet allow-list, a frozen account, or an address that is not an Amma-held wallet of this user.
 */
export async function custodyXrplActivation(o: { userId: number; address: string; flags: CustodyFlags; reader: ActivationReader }): Promise<CustodyActivationResult> {
  if (!xrplCustodyAllowed(o.flags)) return { ok: false, status: 503, error: "XRP for Amma-held wallets isn't available on mainnet yet." };
  const refused = await custodyPreflight({ userId: o.userId, chain: "xrpl", from: o.address, networks: networksFor(o.flags), flags: o.flags });
  if (refused) return { ok: false, ...refused };
  const activation = await xrplActivationStatus(o.reader, o.address);
  if (activation.network !== networksFor(o.flags).xrpl) return { ok: false, status: 503, error: "The XRP Ledger connection is not on the expected network." };
  return { ok: true, activation };
}
