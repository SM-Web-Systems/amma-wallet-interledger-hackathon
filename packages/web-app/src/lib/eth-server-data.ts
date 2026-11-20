import { useEffect, useState } from "react";
import { request } from "./api";

/** Ethereum data for Amma-held wallets served by Amma's own server (ETH_SERVER_DATA=on there). The browser never sees an RPC key. */
export interface EvmServerConfig { serverData: boolean; simulate: boolean; alerts: boolean; network: string }
export interface EvmToken { contract: string; symbol: string | null; name: string | null; decimals: number | null; logo: string | null; balance: string }
export interface EvmBalances { address: string; network: string; wei: string; tokens: EvmToken[]; tokensUnavailable: boolean }
export interface EvmHistoryItem { hash: string; direction: "in" | "out"; asset: string; value: string | null; counterparty: string | null; timestamp: string | null }
export interface EvmHistory { address: string; transfers: EvmHistoryItem[]; pageKey: string | null }
export interface EvmPreview { changes: { asset: string; direction: "in" | "out" | "other"; amount: string }[]; gasEstimateWei: string | null; warnings: string[] }
export interface EvmAlert { id: string; hash: string; to: string; from: string | null; asset: string; value: string; createdAt: string }

const BASE = "/api/v1/custody/evm";
const q = (address: string) => `address=${encodeURIComponent(address)}`;

export const getEvmConfig = () => request<EvmServerConfig>(`${BASE}/config`);
export const getEvmBalances = (address: string) => request<EvmBalances>(`${BASE}/balances?${q(address)}`);
export const getEvmHistory = (address: string, pageKey?: string | null) => request<EvmHistory>(`${BASE}/history?${q(address)}${pageKey ? `&pageKey=${encodeURIComponent(pageKey)}` : ""}`);
export const previewEvmSend = (b: { from: string; to: string; amountWei: string }) => request<EvmPreview>(`${BASE}/preview`, { method: "POST", body: JSON.stringify(b) });
export const getEvmAlerts = async () => (await request<{ alerts: EvmAlert[] }>(`${BASE}/alerts`)).alerts;
/** Tell the server these alerts are stored on this device, so they are not sent again. */
export const markEvmAlertsSeen = (ids: string[]) => request<{ marked: number }>(`${BASE}/alerts/seen`, { method: "POST", body: JSON.stringify({ ids }) });

/** "idle" until the server answers; "off" when the flag is off or the server has no such endpoint (older server): the page then uses its own RPC as before. */
export function useEvmServerConfig(): { status: "loading" | "on" | "off"; config?: EvmServerConfig } {
  const [state, setState] = useState<{ status: "loading" | "on" | "off"; config?: EvmServerConfig }>({ status: "loading" });
  useEffect(() => {
    let live = true;
    getEvmConfig().then((config) => { if (live) setState(config?.serverData === true ? { status: "on", config } : { status: "off", config }); }).catch(() => { if (live) setState({ status: "off" }); });
    return () => { live = false; };
  }, []);
  return state;
}

/** Whole token units from a raw balance and decimals, trimmed. Exact (string math). */
export function formatTokenBalance(raw: string, decimals: number | null): string {
  if (!/^\d+$/.test(raw)) return "0";
  const d = decimals ?? 0;
  if (d === 0) return raw;
  const padded = raw.padStart(d + 1, "0");
  const whole = padded.slice(0, -d), frac = padded.slice(-d).replace(/0+$/, "");
  return frac ? `${whole}.${frac.slice(0, 8)}` : whole;
}

/** Fee from the preview in ETH, "about" because it is an estimate. */
export function formatWei(wei: string | null): string | null {
  if (!wei || !/^\d+$/.test(wei)) return null;
  return formatTokenBalance(wei, 18);
}
