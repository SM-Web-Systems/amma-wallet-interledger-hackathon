import { request } from "./api";

export type CustodyChain = "xrpl" | "evm";
export interface CustodyWallet {
  chain: "stellar" | "xrpl" | "evm"; network: string; address: string; name: string; index: number; active: boolean;
}

const BASE = "/api/v1/custody/wallets";
const json = (body: unknown) => ({ body: JSON.stringify(body) });

/** Amma-held wallets. Rejects when custody is off (503) or the user keeps their own keys (409). */
export const listCustodyWallets = async (): Promise<CustodyWallet[]> => (await request<{ wallets: CustodyWallet[] }>(BASE)).wallets;
export const addCustodyWallet = async (chain: CustodyChain, name?: string): Promise<CustodyWallet> =>
  (await request<{ wallet: CustodyWallet }>(BASE, { method: "POST", ...json(name ? { chain, name } : { chain }) })).wallet;
export const makeCustodyWalletMain = async (chain: CustodyChain, address: string): Promise<CustodyWallet> =>
  (await request<{ wallet: CustodyWallet }>(BASE, { method: "PATCH", ...json({ chain, address, active: true }) })).wallet;
export const renameCustodyWallet = async (chain: CustodyChain, address: string, name: string): Promise<CustodyWallet> =>
  (await request<{ wallet: CustodyWallet }>(BASE, { method: "PATCH", ...json({ chain, address, name }) })).wallet;

/** Asks the server to sign an LMS reward claim with the Amma-held key for its destination. Returns standard base64. The password is never kept. */
export const signLmsClaimWithAmma = async (message: string, password: string): Promise<string> =>
  (await request<{ signature: string }>("/api/v1/custody/lms-claim/sign", { method: "POST", ...json({ message, password }) })).signature;
