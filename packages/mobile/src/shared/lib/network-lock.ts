// G-09 (phone): the testnet build cannot be switched to Mainnet and always says so.
// Only the EAS "testnet" profile sets EXPO_PUBLIC_NETWORK_LOCK=testnet. Preview and production builds are not locked.
export type Network = "testnet" | "public";
export type NetworkLock = "testnet" | "none";

export function resolveLock(raw: string | undefined): NetworkLock {
  return raw === "testnet" ? "testnet" : "none";
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

// Expo inlines EXPO_PUBLIC_* only for this literal `process.env.X` form.
export const NETWORK_LOCK: NetworkLock = resolveLock(process.env.EXPO_PUBLIC_NETWORK_LOCK);
