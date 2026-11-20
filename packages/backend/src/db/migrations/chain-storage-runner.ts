import { mainnetCustodyOn } from "../../lib/custody-networks";

/** The chain-storage runner may run on testnet, or on mainnet only when mainnet custody mode is explicitly on. */
export function chainStorageRunnerAllowed(env: Record<string, string | undefined>): boolean {
  return env.STELLAR_NETWORK === "testnet" || mainnetCustodyOn(env);
}
