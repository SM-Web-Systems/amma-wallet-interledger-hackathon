// An OAuth request that started while signed out (see pages/OAuthConsent.tsx).
// Kept in sessionStorage so it survives the trip through /login or /register.
const OAUTH_STORAGE_KEY = "pendingOAuth";

/** Save pending OAuth params before sending the user to sign in */
export function savePendingOAuth(search: string) {
  sessionStorage.setItem(OAUTH_STORAGE_KEY, search);
}

/** Read pending OAuth params without consuming them (safe during render) */
export function peekPendingOAuth(): string | null {
  return sessionStorage.getItem(OAUTH_STORAGE_KEY);
}

/** Check for and consume pending OAuth params after login */
export function consumePendingOAuth(): string | null {
  const params = sessionStorage.getItem(OAUTH_STORAGE_KEY);
  if (params) sessionStorage.removeItem(OAUTH_STORAGE_KEY);
  return params;
}
