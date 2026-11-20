// What the sign-out dialog says must be true for the mode (G-04).
export function signOutNotice(mode: "self" | "delegated"): { key: string; fallback: string } {
  return mode === "self"
    ? {
        key: "settings.logoutKeepsKeys",
        fallback: "You will be signed out. Your wallet keys stay encrypted on this device, so you can sign back in. To erase them from this browser, use Remove wallets from this browser.",
      }
    : {
        key: "settings.logoutDelegated",
        fallback: "You will be signed out. Your wallets stay safe with Amma and come back when you sign in again.",
      };
}
