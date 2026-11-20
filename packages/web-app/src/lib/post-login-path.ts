// Where a plain password login or sign-up lands. Email recovery set-up (returnTo /settings)
// must stay reachable before a Stellar wallet exists, and users without an
// active wallet go to onboarding instead of racing the dashboard's wallet guard.
export function postLoginPath({ returnTo, hasActiveWallet }: { returnTo?: unknown; hasActiveWallet: boolean }): string {
  if (returnTo === "/settings") return "/settings";
  // An LMS reward claim is always honoured (WA-06); signing falls back to the device passphrase when Amma does not hold the destination.
  if (isLmsClaimReturn(returnTo)) return returnTo;
  return hasActiveWallet ? "/dashboard" : "/onboarding";
}

/** `/lms/claim` with its challenge fragment; nothing else is accepted as a return target. */
export function isLmsClaimReturn(value: unknown): value is string {
  return typeof value === "string" && /^\/lms\/claim#message=[A-Za-z0-9_-]+(={0,2})&return=[A-Za-z0-9%._~-]+$/.test(value);
}

// Where an already signed-in user is sent from /login or /register. A validated
// XRP approval or payment link wins; then an OAuth request saved before sign-in
// (so a relying party's user goes straight back to consent, never via the
// dashboard); otherwise the settings return target is kept.
export function authenticatedAuthRouteTarget({ approval, returnTo, pendingOAuth }: { approval: string | null; returnTo?: unknown; pendingOAuth?: string | null }): string {
  if (approval) return approval;
  if (typeof pendingOAuth === "string" && pendingOAuth.length > 1 && pendingOAuth.startsWith("?")) return `/oauth/authorize${pendingOAuth}`;
  if (isLmsClaimReturn(returnTo)) return returnTo;
  return returnTo === "/settings" ? "/settings" : "/dashboard";
}
