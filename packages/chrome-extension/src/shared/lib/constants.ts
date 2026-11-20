// The build requires VITE_API_URL (see build-env.ts); there is no production fallback.
export const API_BASE: string = import.meta.env.VITE_API_URL ?? "";
export const HORIZON_URL = "https://horizon-testnet.stellar.org";
export const NETWORK_PASSPHRASE = "Test SDF Network ; September 2015";
export const FRIENDBOT_URL = "https://friendbot.stellar.org";
