import { xrplMainnetCustodyOn } from "../../lib/custody-networks";

/** The released XRP payment runners (payments, reconciliation, integration): isolated testnet as before, or mainnet only with XRPL_MAINNET_CUSTODY=on. */
export function xrplRunnerAllowed(env: Record<string, string | undefined>): boolean {
  return (env.STELLAR_NETWORK === "testnet" && (env.XRPL_NETWORK ?? "testnet") === "testnet") || xrplMainnetCustodyOn(env);
}

/** xrpl-mainnet-v1 widens the payment network, so it runs only where XRP custody on mainnet is switched on. */
export const xrplMainnetRunnerAllowed = (env: Record<string, string | undefined>): boolean => xrplMainnetCustodyOn(env);

export const XRPL_RUNNER_REFUSED = "XRP payment runners need STELLAR_NETWORK=testnet with XRPL_NETWORK=testnet, or XRPL_MAINNET_CUSTODY=on with MAINNET_CUSTODY=on, STELLAR_NETWORK=public and XRPL_NETWORK=mainnet";
