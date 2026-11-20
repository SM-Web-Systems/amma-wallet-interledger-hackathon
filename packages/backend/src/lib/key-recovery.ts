import { sql } from "drizzle-orm";
import { db } from "../db";

/**
 * Managed wallet (custody plan, step 5): while a recovery request is waiting, the account is frozen.
 * Signing and sending refuse for that user (step 5b) so a thief who started a recovery cannot move funds
 * out from under the real owner during the wait.
 */
export async function recoveryFreezeActive(userId: number): Promise<boolean> {
  const res = await db.execute(sql`SELECT 1 FROM wallet_key_recovery WHERE user_id = ${userId} AND state = 'pending' LIMIT 1`);
  return (((res as any).rows ?? res) as unknown[]).length > 0;
}

// ── Step 5b: the freeze ────────────────────────────────────────────────────
// Routes that move money, change keys or change the account's password. Matched on the route pattern,
// for any method other than a read. Recovery's own routes, sign-in and webhooks are never frozen.
const FROZEN_PREFIXES = [
  "/api/v1/transactions/",
  "/api/v1/trustlines/",
  "/api/v1/nfts/transfer",
  "/api/v1/nfts/mint",
  "/api/v1/payments/",
  "/api/v1/xrpl/payment-intents",
  "/api/v1/fiat/buy",
  "/api/v1/fiat/sell",
  "/api/v1/wallets",
  "/api/v1/user/signing-mode",
  "/api/v1/auth/change-password",
  "/api/v1/auth/email",
  "/api/v1/key-escrow/phrase",
];
const NEVER_FROZEN = [/^\/api\/v1\/payments\/webhooks\//];
const READS = new Set(["GET", "HEAD", "OPTIONS"]);

export function isFrozenRoute(method: string, url: string): boolean {
  if (READS.has(method.toUpperCase())) return false;
  if (NEVER_FROZEN.some((re) => re.test(url))) return false;
  return FROZEN_PREFIXES.some((p) => url === p || url.startsWith(p.endsWith("/") ? p : p + "/"));
}

/** Runs after the route's own sign-in check. Fails closed: if the database cannot answer, the call errors. */
export async function recoveryFreezeGuard(request: any, reply: any): Promise<void> {
  const userId = request.user?.userId as number | undefined;
  if (!userId) return; // not signed in: the route's own auth answers
  if (await recoveryFreezeActive(userId)) {
    return reply.status(423).send({
      code: "recovery_pending",
      error: "A wallet recovery is waiting on your account, so sending and key changes are paused. Cancel the recovery to continue.",
    });
  }
}

/** Call once, before the routes are registered. Does nothing when recovery is switched off. */
export function installRecoveryFreeze(app: { addHook: (name: "onRoute", fn: (route: any) => void) => unknown }, opts: { enabled: boolean }): void {
  if (!opts.enabled) return;
  app.addHook("onRoute", (route: any) => {
    const methods = (Array.isArray(route.method) ? route.method : [route.method]) as string[];
    if (!methods.some((m) => isFrozenRoute(m, route.url))) return;
    const existing = route.preHandler;
    route.preHandler = [...(Array.isArray(existing) ? existing : existing ? [existing] : []), recoveryFreezeGuard];
  });
}
