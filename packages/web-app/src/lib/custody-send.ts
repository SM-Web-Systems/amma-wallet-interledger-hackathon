import { parseEther } from "viem";
import { request } from "./api";
import { xrplMainnetBuild } from "./custody-network";

export interface SendResult { state: string; hash?: string | null; [k: string]: unknown }
export interface EvmTransfer { id: string; from: string; to: string; amountWei: string; hash: string; state: string }

const post = (path: string, body: unknown) => request<SendResult>(path, { method: "POST", body: JSON.stringify(body) });

/** Testnet explorer. Use xrpExplorerTxUrl() (lib/custody-network), which gives livenet on a mainnet build. */
export const XRP_TX_URL = "https://testnet.xrpl.org/transactions/";
export const SEPOLIA_TX_URL = "https://sepolia.etherscan.io/tx/";
/** The most the server will pay as the XRP network fee (its ceiling is 200 drops). */
export const XRP_MAX_FEE_DROPS = 200n;

export const sendCustodyXrp = (b: { from: string; to: string; amountDrops: string; destinationTag?: number; password: string; idempotencyKey: string }) =>
  post("/api/v1/custody/xrpl/send", b);
export const sendCustodyEvm = (b: { from: string; to: string; amountWei: string; password: string; idempotencyKey: string }) =>
  post("/api/v1/custody/evm/send", b);
/** Mainnet builds read the status through the custody route (the browser-signing payment routes stay testnet-only). */
export const getXrpPaymentStatus = (id: string) => request<SendResult>(xrplMainnetBuild()
  ? `/api/v1/custody/xrpl/payments/${encodeURIComponent(id)}`
  : `/api/v1/xrpl/payment-intents/${encodeURIComponent(id)}`);
export interface CustodyXrpAccount { address: string; network: string; activated: boolean; balanceDrops: string; reserveDrops: string; spendableDrops: string; baseReserveDrops: string }
/** Balance and activation of one of the user's Amma-held XRP wallets (no wallet registration needed). */
export const getCustodyXrpAccount = (address: string) => request<CustodyXrpAccount>(`/api/v1/custody/xrpl/account?address=${encodeURIComponent(address)}`);
export const listCustodyEvmTransfers = async (from: string): Promise<EvmTransfer[]> =>
  (await request<{ transfers: EvmTransfer[] }>(`/api/v1/custody/evm/transfers?from=${encodeURIComponent(from)}`)).transfers;

/** Exact XRP to drops using string math only. Null when the text is not a positive amount with at most 6 decimals. */
export function xrpToDrops(input: string): string | null {
  const m = /^(\d{1,11})(?:\.(\d{1,6}))?$/.exec(input.trim());
  if (!m) return null;
  const drops = BigInt(m[1]) * 1_000_000n + BigInt((m[2] ?? "").padEnd(6, "0"));
  return drops > 0n ? drops.toString() : null;
}
export function dropsToXrp(drops: bigint): string {
  const whole = drops / 1_000_000n;
  const frac = (drops % 1_000_000n).toString().padStart(6, "0").replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : whole.toString();
}
/** Exact ETH to wei with viem parseEther, after rejecting more than 18 decimals (which it would round). */
export function ethToWei(input: string): bigint | null {
  const t = input.trim();
  // 22 whole digits keeps wei within the server's 41-digit limit.
  if (!/^\d{1,22}(\.\d{1,18})?$/.test(t)) return null;
  const wei = parseEther(t);
  return wei > 0n ? wei : null;
}
export function weiToEth(wei: bigint): string {
  const whole = wei / 10n ** 18n;
  const frac = (wei % 10n ** 18n).toString().padStart(18, "0").replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : whole.toString();
}
