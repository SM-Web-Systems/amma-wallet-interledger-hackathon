import { FastifyInstance } from "fastify";
import { eq, sql } from "drizzle-orm";
import { createHash, randomBytes, randomInt } from "node:crypto";
import { db, schema } from "../db";
import { config } from "../config";
import { authMiddleware } from "../middleware/auth";
import { auditLog } from "../lib/audit";
import { hashEmailCode } from "../lib/code-hash";
import { verifyPassword } from "../lib/auth";
import { masterKeyProviderFromEnv, openFromEscrow, type MasterKeyProvider } from "../lib/key-wrapper";

/**
 * Managed wallet (custody plan, step 5a): a user who forgot their wallet passphrase can recover.
 * 1. Signed in, then an emailed 6 digit code (proves they can read the account's mailbox).
 * 2. Request = account password + code. This starts a wait (48 hours by default) and emails the owner
 *    an alert with a cancel link. While it waits, the account is frozen (see recoveryFreezeActive).
 * 3. After the wait, the owner types the password again and the sealed phrase is handed back, once.
 * Nothing secret (code, cancel token, password, phrase) is logged or written to audit rows.
 */
export interface RecoveryMail {
  code(to: string, code: string): Promise<void>;
  alert(to: string, readyAt: Date, cancelUrl: string): Promise<void>;
  cancelled(to: string): Promise<void>;
}
export interface KeyRecoveryOptions { provider?: MasterKeyProvider | null; mail?: RecoveryMail; waitHours?: number }

const KIND = "phrase" as const;
const CODE_MINUTES = 15;
const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");
const rowsOf = <T,>(res: unknown): T[] => (((res as any).rows ?? res) as T[]);

async function defaultMail(): Promise<RecoveryMail> {
  const m = await import("../lib/email");
  return { code: m.sendKeyRecoveryCode, alert: m.sendKeyRecoveryAlert, cancelled: m.sendKeyRecoveryCancelled };
}

function waitHoursFromEnv(): number {
  const n = Number(process.env.KEY_RECOVERY_WAIT_HOURS);
  return Number.isFinite(n) && n > 0 ? n : 48;
}

export async function keyRecoveryRoutes(app: FastifyInstance, opts: KeyRecoveryOptions = {}) {
  const provider = opts.provider === undefined ? masterKeyProviderFromEnv() : opts.provider;
  const waitHours = opts.waitHours ?? waitHoursFromEnv();
  const mail = opts.mail ?? (await defaultMail());
  const off = { error: "Wallet recovery is not switched on yet." };
  const meta = (request: any) => ({ ip: request.ip as string, userAgent: request.headers["user-agent"] as string | undefined });

  async function account(userId: number) {
    const [u] = await db.select({ email: schema.users.email, passwordHash: schema.users.passwordHash, signingMode: schema.users.signingMode })
      .from(schema.users).where(eq(schema.users.id, userId)).limit(1);
    return u;
  }
  const deny = async (request: any, userId: number, why: string) => {
    await auditLog("key_recovery_denied", { userId, detail: { why }, ...meta(request) });
  };

  app.get("/api/v1/key-recovery/status", { preHandler: authMiddleware }, async (request, reply) => {
    reply.header("Cache-Control", "no-store");
    if (!provider) return { enabled: false, state: "none" };
    const userId = (request as any).user.userId as number;
    const [row] = rowsOf<{ ready_at: string | Date; ready: boolean }>(await db.execute(
      sql`SELECT ready_at, (ready_at <= now()) AS ready FROM wallet_key_recovery WHERE user_id = ${userId} AND state = 'pending'`));
    if (!row) return { enabled: true, state: "none" };
    return { enabled: true, state: row.ready ? "ready" : "waiting", readyAt: new Date(row.ready_at).toISOString() };
  });

  app.post("/api/v1/key-recovery/code", {
    preHandler: authMiddleware,
    config: { rateLimit: { max: 5, timeWindow: "15 minutes" } },
  }, async (request, reply) => {
    if (!provider) return reply.status(503).send(off);
    const { userId } = (request as any).user as { userId: number };
    const u = await account(userId);
    if (!u?.email) return reply.status(400).send({ error: "Your account has no email address." });
    const code = String(randomInt(0, 1_000_000)).padStart(6, "0");
    await db.execute(sql`UPDATE email_codes SET used = true WHERE user_id = ${userId} AND type = 'key-recovery' AND used = false`);
    await db.execute(sql`INSERT INTO email_codes (user_id, code, type, expires_at)
      VALUES (${userId}, ${hashEmailCode(code)}, 'key-recovery', now() + ${`${CODE_MINUTES} minutes`}::interval)`);
    try { await mail.code(u.email, code); }
    catch { return reply.status(502).send({ error: "The email could not be sent. Try again." }); }
    reply.header("Cache-Control", "no-store");
    return { sent: true };
  });

  app.post("/api/v1/key-recovery/request", {
    preHandler: authMiddleware,
    config: { rateLimit: { max: 5, timeWindow: "15 minutes" } },
  }, async (request, reply) => {
    if (!provider) return reply.status(503).send(off);
    const { userId } = (request as any).user as { userId: number };
    const body = (request.body ?? {}) as { password?: unknown; code?: unknown };
    if (typeof body.password !== "string" || !body.password || body.password.length > 256 || typeof body.code !== "string" || !/^\d{6}$/.test(body.code)) {
      return reply.status(400).send({ error: "Enter your account password and the 6 digit code from your email." });
    }
    const u = await account(userId);
    if (!u || !u.email || !(await verifyPassword(body.password, u.passwordHash))) {
      await deny(request, userId, "password");
      return reply.status(403).send({ error: "That password is not correct." });
    }
    const [code] = rowsOf<{ id: number }>(await db.execute(sql`SELECT id FROM email_codes
      WHERE user_id = ${userId} AND type = 'key-recovery' AND used = false AND expires_at > now() AND code = ${hashEmailCode(body.code)}
      ORDER BY id DESC LIMIT 1`));
    if (!code) {
      await deny(request, userId, "code");
      return reply.status(403).send({ error: "That code is not correct or has expired." });
    }
    if (u.signingMode === "self") return reply.status(409).send({ error: "You keep your own keys, so Amma cannot recover them for you." });
    const has = rowsOf<unknown>(await db.execute(sql`SELECT 1 FROM wallet_key_escrow WHERE user_id = ${userId} AND kind = ${KIND}`));
    if (!has.length) return reply.status(404).send({ error: "Amma has no backup of a recovery phrase for you." });

    // Use up the code atomically, so two parallel requests cannot both use it.
    const used = rowsOf<{ id: number }>(await db.execute(sql`UPDATE email_codes SET used = true WHERE id = ${code.id} AND used = false RETURNING id`));
    if (!used.length) { await deny(request, userId, "code"); return reply.status(403).send({ error: "That code is not correct or has expired." }); }

    const token = randomBytes(32).toString("hex");
    const [created] = rowsOf<{ id: number; ready_at: string | Date }>(await db.execute(sql`
      INSERT INTO wallet_key_recovery (user_id, state, ready_at, cancel_token_hash)
      VALUES (${userId}, 'pending', now() + ${`${waitHours} hours`}::interval, ${sha256(token)})
      ON CONFLICT DO NOTHING RETURNING id, ready_at`));
    if (!created) return reply.status(409).send({ error: "A recovery is already waiting for your account." });
    const readyAt = new Date(created.ready_at);

    try {
      await mail.alert(u.email, readyAt, `${config.WEB_APP_URL}/recovery/cancel?token=${token}`);
    } catch {
      // An owner who cannot be warned must not have a recovery running against them.
      await db.execute(sql`UPDATE wallet_key_recovery SET state = 'cancelled', resolved_at = now() WHERE id = ${created.id}`);
      return reply.status(502).send({ error: "The alert email could not be sent, so recovery was not started. Try again." });
    }
    await auditLog("key_recovery_requested", { userId, detail: { readyAt: readyAt.toISOString() }, ...meta(request) });
    reply.header("Cache-Control", "no-store");
    return { state: "waiting", readyAt: readyAt.toISOString() };
  });

  app.post("/api/v1/key-recovery/cancel", { preHandler: authMiddleware }, async (request, reply) => {
    if (!provider) return reply.status(503).send(off);
    const { userId } = (request as any).user as { userId: number };
    const done = rowsOf<{ id: number }>(await db.execute(sql`UPDATE wallet_key_recovery SET state = 'cancelled', resolved_at = now()
      WHERE user_id = ${userId} AND state = 'pending' RETURNING id`));
    if (!done.length) return reply.status(404).send({ error: "No recovery is waiting." });
    await auditLog("key_recovery_cancelled", { userId, detail: { by: "owner-signed-in" }, ...meta(request) });
    const u = await account(userId);
    if (u?.email) await mail.cancelled(u.email).catch(() => {});
    return { cancelled: true };
  });

  // The link in the alert email. No sign-in: the owner may be locked out or on another device.
  app.post("/api/v1/key-recovery/cancel-by-token", { config: { rateLimit: { max: 20, timeWindow: "15 minutes" } } }, async (request, reply) => {
    if (!provider) return reply.status(503).send(off);
    const token = (request.body as { token?: unknown } | undefined)?.token;
    if (typeof token !== "string" || !/^[0-9a-f]{64}$/.test(token)) return reply.status(400).send({ error: "That link is not valid." });
    const [done] = rowsOf<{ user_id: number }>(await db.execute(sql`UPDATE wallet_key_recovery SET state = 'cancelled', resolved_at = now()
      WHERE cancel_token_hash = ${sha256(token)} AND state = 'pending' RETURNING user_id`));
    if (!done) return reply.status(404).send({ error: "That recovery was already cancelled or finished." });
    await auditLog("key_recovery_cancelled", { userId: done.user_id, detail: { by: "email-link" }, ...meta(request) });
    const u = await account(done.user_id);
    if (u?.email) await mail.cancelled(u.email).catch(() => {});
    return { cancelled: true };
  });

  app.post("/api/v1/key-recovery/complete", {
    preHandler: authMiddleware,
    config: { rateLimit: { max: 5, timeWindow: "15 minutes" } },
  }, async (request, reply) => {
    if (!provider) return reply.status(503).send(off);
    const { userId } = (request as any).user as { userId: number };
    const password = (request.body as { password?: unknown } | undefined)?.password;
    if (typeof password !== "string" || !password || password.length > 256) return reply.status(400).send({ error: "Enter your account password." });
    const [pending] = rowsOf<{ id: number; ready: boolean }>(await db.execute(sql`SELECT id, (ready_at <= now()) AS ready
      FROM wallet_key_recovery WHERE user_id = ${userId} AND state = 'pending'`));
    if (!pending) return reply.status(404).send({ error: "No recovery is waiting." });
    const u = await account(userId);
    if (!u || !(await verifyPassword(password, u.passwordHash))) {
      await deny(request, userId, "password");
      return reply.status(403).send({ error: "That password is not correct." });
    }
    if (!pending.ready) return reply.status(409).send({ error: "The wait is not over yet." });

    const [row] = rowsOf<{ sealed: string }>(await db.execute(sql`SELECT sealed FROM wallet_key_escrow WHERE user_id = ${userId} AND kind = ${KIND}`));
    if (!row) return reply.status(404).send({ error: "Amma has no backup of a recovery phrase for you." });
    let phrase: string;
    try {
      phrase = await openFromEscrow(provider, row.sealed, { userId, kind: KIND, reason: "recovery", ...meta(request) });
    } catch {
      return reply.status(500).send({ error: "The backup could not be opened right now. Try again later." });
    }
    // Hand it back once: only the request that flips pending -> completed gets the phrase.
    const claimed = rowsOf<{ id: number }>(await db.execute(sql`UPDATE wallet_key_recovery SET state = 'completed', resolved_at = now()
      WHERE id = ${pending.id} AND state = 'pending' RETURNING id`));
    if (!claimed.length) return reply.status(404).send({ error: "No recovery is waiting." });
    await auditLog("key_recovery_completed", { userId, detail: {}, ...meta(request) });
    reply.header("Cache-Control", "no-store");
    return { phrase };
  });
}
