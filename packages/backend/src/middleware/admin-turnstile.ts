import { FastifyRequest, FastifyReply } from "fastify";
import { config } from "../config";
import { appLog } from "../lib/app-log";

/**
 * Cloudflare Turnstile on the internal admin console sign-in (POST /api/v1/internal/auth/login).
 *
 * Separate from the user sign-in check (middleware/turnstile.ts) and switched off unless ADMIN_TURNSTILE=on.
 * When on it fails closed: no token, a bad token, a token for another hostname or action, a missing key, or
 * Cloudflare not answering all refuse the sign-in.
 *
 * Break-glass (the widget is broken and an admin must get in): set ADMIN_TURNSTILE=off and restart the API.
 * The site key is read from config and served to the admin page by GET /api/v1/internal/auth/config, so a key
 * change needs only an API restart, not a web rebuild. The secret is never logged or sent to the browser.
 */
export const ADMIN_TURNSTILE_ACTION = "admin-login";
const SITEVERIFY_URL = "https://challenges.cloudflare.com/turnstile/v0/siteverify";
const SITEVERIFY_TIMEOUT_MS = 8000;

const isOn = () => String(config.ADMIN_TURNSTILE ?? "").trim().toLowerCase() === "on";

/** What the admin page needs to show the widget. Public: the site key is not a secret. */
export function adminTurnstilePublicConfig(): { enabled: boolean; siteKey: string | null } {
  if (!isOn()) return { enabled: false, siteKey: null };
  return { enabled: true, siteKey: config.ADMIN_TURNSTILE_SITE_KEY || null };
}

type SiteverifyResult = { success?: boolean; hostname?: string; action?: string; "error-codes"?: string[] };

export async function verifyAdminTurnstile(request: FastifyRequest, reply: FastifyReply) {
  if (!isOn()) return;

  if (!config.ADMIN_TURNSTILE_SITE_KEY || !config.ADMIN_TURNSTILE_SECRET_KEY) {
    appLog().error({ check: "admin_turnstile" }, "Admin Turnstile is on but its site key or secret is not set - refusing admin sign-in");
    return reply.status(503).send({ error: "Admin sign-in verification is not configured." });
  }

  const body = request.body as { turnstileToken?: unknown } | undefined;
  const token = typeof body?.turnstileToken === "string" ? body.turnstileToken : "";
  if (!token) {
    return reply.status(400).send({ error: "Human verification required. Please complete the check." });
  }

  let result: SiteverifyResult;
  try {
    const form = new URLSearchParams();
    form.append("secret", config.ADMIN_TURNSTILE_SECRET_KEY);
    form.append("response", token);
    form.append("remoteip", request.ip);
    const res = await fetch(SITEVERIFY_URL, { method: "POST", body: form, signal: AbortSignal.timeout(SITEVERIFY_TIMEOUT_MS) });
    if (!res.ok) throw new Error(`siteverify HTTP ${res.status}`);
    const parsed: unknown = await res.json();
    if (!parsed || typeof parsed !== "object") throw new Error("siteverify returned no object");
    result = parsed as SiteverifyResult;
  } catch (err) {
    // Only the error's type: a message could echo what was sent.
    appLog().error({ check: "admin_turnstile", errorType: (err as Error)?.name ?? "Error" }, "Admin Turnstile: verification service unavailable");
    return reply.status(503).send({ error: "Verification service unavailable. Please try again shortly." });
  }

  const allowedHosts = (config.ADMIN_TURNSTILE_HOSTNAMES ?? []).map((h) => h.toLowerCase());
  const hostOk = typeof result.hostname === "string" && allowedHosts.includes(result.hostname.toLowerCase());
  const actionOk = result.action === ADMIN_TURNSTILE_ACTION;
  if (result.success !== true || !hostOk || !actionOk) {
    const codes = Array.isArray(result["error-codes"]) ? result["error-codes"].filter((c) => typeof c === "string") : [];
    appLog().warn({ check: "admin_turnstile", codes, hostOk, actionOk }, "Admin Turnstile: refused");
    return reply.status(403).send({ error: "Human verification failed. Please try again." });
  }
}
