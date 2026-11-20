/**
 * Mainnet custody mode in the web app. A build-time flag, off by default: VITE_MAINNET_CUSTODY=on shows Amma-held wallets
 * on the public Stellar network too (the server must be running with MAINNET_CUSTODY=on). Read at call time so tests can set it.
 */
export const mainnetCustodyBuild = (): boolean => import.meta.env.VITE_MAINNET_CUSTODY === "on";

/** Whether Amma-held (custody) features apply on this network: testnet always, public only in a mainnet-custody build. */
export const custodyNetworkOk = (network: "testnet" | "public"): boolean => network === "testnet" || (network === "public" && mainnetCustodyBuild());

export const evmExplorerTxUrl = (): string => (mainnetCustodyBuild() ? "https://etherscan.io/tx/" : "https://sepolia.etherscan.io/tx/");
export const evmExplorerName = (): string => (mainnetCustodyBuild() ? "Ethereum" : "Sepolia");

/**
 * XRP on mainnet: a second build flag, VITE_XRPL_MAINNET=on, honoured only in a VITE_MAINNET_CUSTODY=on build
 * (the server must run with XRPL_MAINNET_CUSTODY=on). Only Amma-held XRP wallets are shown there.
 */
export const xrplMainnetBuild = (): boolean => mainnetCustodyBuild() && import.meta.env.VITE_XRPL_MAINNET === "on";
/** Whether this build shows the XRP page at all (on top of VITE_XRPL_ENABLED): always on testnet builds; on mainnet custody builds only with VITE_XRPL_MAINNET=on. */
export const xrplNetworkShown = (): boolean => !mainnetCustodyBuild() || xrplMainnetBuild();
export const xrpNavLabel = (): string => (xrplMainnetBuild() ? "XRP" : "XRP Testnet");
export const xrpExplorerTxUrl = (): string => (xrplMainnetBuild() ? "https://livenet.xrpl.org/transactions/" : "https://testnet.xrpl.org/transactions/");
export const xrpExplorerName = (): string => (xrplMainnetBuild() ? "XRP Ledger" : "XRP testnet");
/** Shown for an Amma-held XRP mainnet wallet that holds no XRP yet. Amma activates it after an eligible task; the user is never asked to fund it. */
export const XRP_NOT_ACTIVATED = "Not activated yet. This wallet is activated when you complete an eligible task.";

/** True when Amma-held Ethereum is real ETH: a mainnet custody build, or the server reports the wallet/balance on "ethereum". When the two disagree, err toward warning. */
export const evmCustodyReal = (serverNetwork?: string | null): boolean => mainnetCustodyBuild() || serverNetwork === "ethereum";
export const evmCustodyName = (real: boolean): string => (real ? "Ethereum (real ETH)" : "Sepolia ETH");
export const evmSymbol = (real: boolean): string => (real ? "ETH" : "SepoliaETH");

/** The closing sentence of the Move to Amma explanations: says what network Amma will hold the wallet on. */
export function moveToAmmaNote(chain: "evm" | "xrpl" | "stellar", stellarNetwork?: "testnet" | "public"): string {
  if (!mainnetCustodyBuild()) return "Testnet only.";
  if (chain === "evm") return "Amma-held Ethereum wallets are on Ethereum mainnet and hold real ETH. Sepolia test ETH in this wallet will not show once Amma holds it.";
  if (chain === "stellar") return stellarNetwork === "public" ? "This wallet is on the Stellar public network and holds real XLM." : "Testnet only.";
  return xrplMainnetBuild() ? "Amma-held XRP wallets are on the XRP Ledger mainnet and hold real XRP." : "XRP cannot be moved to Amma on this build.";
}
