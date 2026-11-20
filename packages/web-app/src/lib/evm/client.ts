import { EvmRpcReader, NETWORKS, type Transport } from "@amma-wallet/evm-core";
import { mainnetRpcUrls, sepoliaRpcUrls } from "./feature";
import { mainnetCustodyBuild } from "../custody-network";

const browserTransport: Transport = (url, body, signal) =>
  fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body, signal, credentials: "omit", referrerPolicy: "no-referrer", cache: "no-store" });

/** Null when no Sepolia RPC is configured for this build: the page then stays read-only and says so. */
export function sepoliaReader(): EvmRpcReader | null {
  if (sepoliaRpcUrls.length === 0) return null;
  return new EvmRpcReader(NETWORKS["ethereum-sepolia"], sepoliaRpcUrls, browserTransport);
}

/** Reader for Amma-held wallets: Ethereum mainnet in a mainnet custody build, Sepolia otherwise. Null when no RPC is configured for that network. */
export function custodyReader(): EvmRpcReader | null {
  if (!mainnetCustodyBuild()) return sepoliaReader();
  if (mainnetRpcUrls.length === 0) return null;
  return new EvmRpcReader(NETWORKS["ethereum-mainnet"], mainnetRpcUrls, browserTransport);
}
