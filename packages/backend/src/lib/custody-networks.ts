/**
 * Which networks the custody code uses. Testnet unless MAINNET_CUSTODY=on on a server whose STELLAR_NETWORK is "public".
 * One mapping for everything that used to hard-code "testnet" or "sepolia".
 */
type Env = Record<string, string | undefined>;

export interface CustodyNetworks {
  mainnet: boolean;
  stellar: "testnet" | "public";
  xrpl: "testnet" | "mainnet";
  evm: "sepolia" | "ethereum";
  evmChainId: number;
}

const TESTNET: CustodyNetworks = { mainnet: false, stellar: "testnet", xrpl: "testnet", evm: "sepolia", evmChainId: 11155111 };
const MAINNET: CustodyNetworks = { mainnet: true, stellar: "public", xrpl: "mainnet", evm: "ethereum", evmChainId: 1 };

/** Only the exact value "on" enables mainnet custody. */
export const mainnetCustodyOn = (env: Env): boolean => env.MAINNET_CUSTODY === "on" && env.STELLAR_NETWORK === "public";

export const custodyNetworks = (env: Env = process.env): CustodyNetworks => (mainnetCustodyOn(env) ? MAINNET : TESTNET);

/**
 * XRP for Amma-held wallets on mainnet: only with XRPL_MAINNET_CUSTODY=on, on a mainnet custody server (MAINNET_CUSTODY=on, STELLAR_NETWORK=public)
 * whose XRP pipeline is pointed at mainnet (XRPL_NETWORK=mainnet). Anything less keeps refusing XRP on mainnet as before.
 */
export const xrplMainnetCustodyOn = (env: Env): boolean =>
  mainnetCustodyOn(env) && env.XRPL_MAINNET_CUSTODY === "on" && env.XRPL_NETWORK === "mainnet";

/** Refuses start-up on any inconsistent XRP network setting. Testnet settings and the full mainnet set pass. */
export function assertXrplNetworkConfig(env: Env): void {
  const sw = env.XRPL_MAINNET_CUSTODY;
  if (sw !== undefined && sw !== "" && sw !== "on" && sw !== "off") throw new Error("XRPL_MAINNET_CUSTODY must be on or off.");
  const network = env.XRPL_NETWORK ?? "testnet";
  if (network !== "testnet" && network !== "mainnet") throw new Error("XRPL_NETWORK must be testnet or mainnet.");
  if (sw === "on") {
    if (!mainnetCustodyOn(env)) throw new Error("XRPL_MAINNET_CUSTODY=on needs MAINNET_CUSTODY=on and STELLAR_NETWORK=public.");
    if (network !== "mainnet") throw new Error("XRPL_MAINNET_CUSTODY=on needs XRPL_NETWORK=mainnet.");
  }
  if (network === "mainnet" && sw !== "on") throw new Error("XRPL_NETWORK=mainnet needs XRPL_MAINNET_CUSTODY=on (with MAINNET_CUSTODY=on and STELLAR_NETWORK=public).");
}

/** The same mapping from the flags object the routes already carry. */
export const networksFor = (flags: { mainnet?: boolean; xrplMainnet?: boolean }): CustodyNetworks => (flags.mainnet === true ? MAINNET : TESTNET);

/** Whether Amma-held XRP wallets may be created, imported or sent from: always on testnet; on mainnet only with XRPL_MAINNET_CUSTODY=on. */
export const xrplCustodyAllowed = (flags: { mainnet?: boolean; xrplMainnet?: boolean }): boolean => flags.mainnet !== true || flags.xrplMainnet === true;

/** The network a chain's custody wallets live on. */
export const networkOf = (n: CustodyNetworks, chain: "stellar" | "xrpl" | "evm"): string => n[chain];
