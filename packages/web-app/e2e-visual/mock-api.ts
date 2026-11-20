import type { BrowserContext } from "@playwright/test";

/** A public test-vector address; no secret is used anywhere in this suite. */
export const DEMO_PUBLIC_KEY = "GBRPYHIL2CI3FNQ4BXLFMNDLFJUNPU2HY3ZMFSHONUCEOASW7QC7OX2H";

function reply(path: string): unknown {
  if (path.endsWith("/auth/refresh")) return { accessToken: "visual-test", refreshToken: "visual-test" };
  if (path.endsWith("/auth/me")) return { user: { id: 1, email: "demo@example.com", emailVerified: true, name: "Demo" }, wallets: [] };
  if (/\/signing[-/]?mode/.test(path)) return { mode: "self" };
  if (/\/(wallets|contacts|api-keys)$/.test(path)) return [];
  if (/\/transactions\//.test(path)) return { records: [] };
  return {};
}

/** Answers every same-origin /api call and blocks all other hosts, so the test is hermetic. */
export async function mockApi(context: BrowserContext, origin: string, opts: { signedIn: boolean }): Promise<void> {
  await context.route("**/*", (route) => {
    const url = new URL(route.request().url());
    if (url.origin !== origin) return route.abort();
    // A signed-out visitor has no refresh cookie, so the server refuses to restore a session.
    if (!opts.signedIn && /\/auth\/(refresh|me)$/.test(url.pathname)) return route.fulfill({ status: 401, json: { error: "Not signed in" } });
    if (url.pathname.startsWith("/api/")) return route.fulfill({ json: reply(url.pathname) });
    return route.continue();
  });
}

/** Seeds a signed-in session with one watch-only Stellar account (public key only). */
export async function signIn(context: BrowserContext, theme: "light" | "dark"): Promise<void> {
  await context.addInitScript(([theme, pk]) => {
    localStorage.setItem("amma-wallet-theme", theme);
    localStorage.setItem("amma-wallet-auth", JSON.stringify({ state: { isAuthenticated: true }, version: 0 }));
    // ownerId 1 = the mocked /auth/me user: wallets on a device are bound to the signed-in user (key storage H1),
    // and an unowned wallet that the server does not list for this user is set aside.
    localStorage.setItem("amma-wallet", JSON.stringify({ state: { accounts: [{ id: "a1", name: "Main", publicKey: pk, createdAt: 1 }], activeAccountId: "a1", ownerId: 1 }, version: 0 }));
  }, [theme, DEMO_PUBLIC_KEY] as const);
}

export async function signedOut(context: BrowserContext, theme: "light" | "dark"): Promise<void> {
  await context.addInitScript((theme) => localStorage.setItem("amma-wallet-theme", theme), theme);
}
