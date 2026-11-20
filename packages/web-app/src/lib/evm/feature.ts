/** Ethereum Sepolia in the web app. Off unless explicitly enabled at build time. */
export const evmEnabled = import.meta.env.VITE_EVM_ENABLED === "true";
/** Comma-separated https JSON-RPC URLs for Sepolia, primary first (max 3). */
export const sepoliaRpcUrls: string[] = (import.meta.env.VITE_EVM_SEPOLIA_RPC_URLS ?? "").split(",").map((u: string) => u.trim()).filter(Boolean);
/** Comma-separated https JSON-RPC URLs for Ethereum mainnet, read-only balances of Amma-held wallets in a mainnet custody build (max 3). */
export const mainnetRpcUrls: string[] = (import.meta.env.VITE_EVM_MAINNET_RPC_URLS ?? "").split(",").map((u: string) => u.trim()).filter(Boolean);
