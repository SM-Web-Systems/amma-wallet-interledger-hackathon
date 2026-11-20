/**
 * The Amma API the app talks to. Production by default; a test build sets
 * EXPO_PUBLIC_API_URL (for example https://testnet.ammawallet.com) at build time.
 * Expo inlines EXPO_PUBLIC_* only for this literal `process.env.X` form.
 */
export const API_BASE = (process.env.EXPO_PUBLIC_API_URL || "https://ammawallet.com").replace(/\/+$/, "");
