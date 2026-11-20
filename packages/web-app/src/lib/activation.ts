import { request } from "./api";

/** The state of one Amma-held Stellar wallet's task activation, as the server reports it. */
export type ActivationState = "not_activated" | "activating" | "delayed" | "failed" | "active";
export interface ActivationInfo { chain: "stellar"; network: string; address: string; state: ActivationState; activatedBy?: string; activatedAt?: string; txHash?: string }

/** Rejects when activation is off (503), not allowed for this account (403) or the call fails. Callers treat that as "no activation info". */
export const fetchActivation = async (): Promise<ActivationInfo[]> => (await request<{ wallets: ActivationInfo[] }>("/api/v1/custody/activation")).wallets;

/** The activation state to show for the wallet on screen, or null when there is nothing to say about it. */
export const activationFor = (wallets: readonly ActivationInfo[] | undefined, address: string | null): ActivationInfo | null =>
  (address && wallets?.find((w) => w.chain === "stellar" && w.address === address)) || null;

/** Where a wallet owner does the partner task that switches the wallet on. Same address the app menu already links to. */
export const LMS_URL = "https://lms.smwebsystems.com";
