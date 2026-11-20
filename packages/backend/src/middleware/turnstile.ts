import { FastifyRequest, FastifyReply } from "fastify";
import { config } from "../config";
import { resolveTenantApiKey } from "./tenant-api-key";
import { db, schema } from "../db";
import { eq } from "drizzle-orm";

/**
 * The second (2FA) step of a login may skip Turnstile, because the first step
 * already passed it. Only trust that for an account that really has 2FA on:
 * otherwise adding any `twoFaToken` to a first-step login would skip the
 * captcha for every account without 2FA.
 */
async function accountHasTwoFa(body: { email?: unknown; phoneNumber?: unknown }): Promise<boolean> {
  const email = typeof body.email === "string" ? body.email.toLowerCase().trim() : "";
  const phone = typeof body.phoneNumber === "string" ? body.phoneNumber : "";
  if (!email && !phone) return false;
  const [user] = await db
    .select({ twoFaEnabled: schema.users.twoFaEnabled })
    .from(schema.users)
    .where(email ? eq(schema.users.email, email) : eq(schema.users.phoneNumber, phone))
    .limit(1);
  return Boolean(user?.twoFaEnabled);
}

export async function verifyTurnstile(request: FastifyRequest, reply: FastifyReply) {
  // Skip in development if no key configured
  if (!config.TURNSTILE_SECRET_KEY || config.TURNSTILE_SECRET_KEY === "placeholder_get_from_cloudflare") {
    return;
  }

  // Skip Turnstile for authorized API integrations (DB keys or legacy env var keys).
  const rawKey = request.headers["x-api-key"] as string | undefined;
  if (rawKey) {
    const ctx = await resolveTenantApiKey(rawKey);
    if (ctx) return;
  }

  const body = request.body as any;

  // Skip turnstile on 2FA step — user already passed verification on the first login attempt.
  // Only allow this bypass on login route (not register or other routes).
  if (body?.twoFaToken && request.routeOptions?.url === "/api/v1/auth/login" && (await accountHasTwoFa(body))) {
    return;
  }

  const turnstileToken = body?.turnstileToken || body?.cfTurnstileResponse;

  if (!turnstileToken) {
    return reply.status(400).send({
      error: "Human verification required. Please complete the captcha.",
    });
  }

  try {
    const formData = new URLSearchParams();
    formData.append("secret", config.TURNSTILE_SECRET_KEY);
    formData.append("response", turnstileToken);
    formData.append("remoteip", request.ip);

    const res = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
      method: "POST",
      body: formData,
    });

    const result = await res.json() as { success: boolean; "error-codes"?: string[] };

    if (!result.success) {
      console.warn("Turnstile verification failed:", result["error-codes"]);
      return reply.status(403).send({
        error: "Human verification failed. Please try again.",
      });
    }
  } catch (err) {
    console.error("Turnstile verification error:", err);
    return reply.status(503).send({
      error: "Verification service unavailable. Please try again shortly.",
    });
  }
}
