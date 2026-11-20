// G-09: a testnet build must not be switchable to Mainnet, and must always say so.
export type Network = "testnet" | "public";
export type NetworkLock = "testnet" | "none";

/** Only the exact value "none" turns the lock off. Anything else, or nothing, keeps it on. */
export function resolveLock(raw: string | undefined): NetworkLock {
  return raw === "none" ? "none" : "testnet";
}

export function availableNetworks(lock: NetworkLock): Network[] {
  return lock === "testnet" ? ["testnet"] : ["testnet", "public"];
}

/** A stored or requested network that the lock does not allow becomes testnet. */
export function effectiveNetwork(requested: Network | undefined, lock: NetworkLock): Network {
  return requested && availableNetworks(lock).includes(requested) ? requested : "testnet";
}

export function networkBadgeText(lock: NetworkLock): string | null {
  return lock === "testnet" ? "Test network, no real money" : null;
}

/** The token directory's name for the network: a locked build only ever asks about testnet. */
export function tokenNetworkParam(lock: NetworkLock = NETWORK_LOCK): "testnet" | "pubnet" {
  return lock === "testnet" ? "testnet" : "pubnet";
}

export const NETWORK_LOCK: NetworkLock = resolveLock(import.meta.env.VITE_NETWORK_LOCK);
