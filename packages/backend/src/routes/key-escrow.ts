import { FastifyInstance } from "fastify";
import StellarHDWallet from "stellar-hd-wallet";
import { eq, sql } from "drizzle-orm";
import { db, schema } from "../db";
import { authMiddleware } from "../middleware/auth";
import { auditLog } from "../lib/audit";
import { verifyPassword } from "../lib/auth";
import { CUSTODY_NOT_AVAILABLE, custodyAllowedForUser, custodyFlagsFromEnv, type CustodyFlags } from "../lib/custody-flags";
import { masterKeyProviderFromEnv, openFromEscrow, sealForEscrow, type MasterKeyProvider } from "../lib/key-wrapper";
import { issueEmailCode, secondFactorColumns, secondFactorMethod, verifySecondFactor } from "../lib/second-factor";

/**
 * Managed wallet (custody plan, step 2): Amma keeps ONE sealed recovery phrase per user.
 * - Save: any signed-in delegated user. The phrase arrives over TLS, is sealed straight away and is never logged.
 * - Read back: the signed-in owner, after typing their account password again and, if they use two-factor sign-in,
 *   their second factor. The owner is emailed before the phrase is released; no email, no phrase. Rate limited and audited.
 * - Self-custody users (the opt-out) keep their own keys: nothing is saved or read for them.
 * - Off (503) until a master key provider is configured.
 */
export interface KeyEscrowOptions {
  provider?: MasterKeyProvider | null;
  /** The route that hands the phrase back is off unless KEY_ESCROW_OPEN_ENABLED=true (G-01 step A). */
  openEnabled?: boolean;
  /** Mainnet custody mode: only allow-listed users may have Amma keep a new phrase (default: from env). */
  flags?: CustodyFlags;
  /** Emails sent around a read-back (default: lib/email). */
  mail?: EscrowMail;
}

export interface EscrowMail {
  /** Must reach the owner before the phrase is released; a throw stops the release. */
  viewed(to: string, when: Date): Promise<void>;
  /** The email-method second factor. */
  code(to: string, code: string): Promise<void>;
}

const OPEN_CODE_PURPOSE = "key-escrow-open";

async function defaultMail(): Promise<EscrowMail> {
  const m = await import("../lib/email");
  return { viewed: m.sendRecoveryPhraseViewedAlert, code: m.sendRecoveryPhraseCode };
}

const KIND = "phrase" as const;
const WORDS = [12, 24];

function cleanPhrase(input: unknown): string | null {
  if (typeof input !== "string" || input.length > 400) return null;
  const phrase = input.normalize("NFKD").trim().toLowerCase().split(/\s+/).filter(Boolean).join(" ");
  if (!WORDS.includes(phrase.split(" ").length)) return null;
  return StellarHDWallet.validateMnemonic(phrase) ? phrase : null;
}

const rowsOf = (result: any): unknown[] => (result?.rows ?? result) as unknown[];

// Databases without custody-v1 have no origin column. Cache only a positive answer, so applying the migration is noticed.
let originColumn = false;
async function hasOriginColumn(q: { execute: typeof db.execute }): Promise<boolean> {
  if (originColumn) return true;
  const rows = rowsOf(await q.execute(sql`SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'wallet_key_escrow' AND column_name = 'origin'`));
  return (originColumn = rows.length > 0);
}

async function selfCustody(userId: number): Promise<boolean> {
  const [user] = await db.select({ signingMode: schema.users.signingMode }).from(schema.users).where(eq(schema.users.id, userId)).limit(1);
  return user?.signingMode === "self";
}

export async function keyEscrowRoutes(app: FastifyInstance, opts: KeyEscrowOptions = {}) {
  // Read once at start-up: a bad setting stops the server instead of failing later for a user.
  const provider = opts.provider === undefined ? masterKeyProviderFromEnv() : opts.provider;
  const openEnabled = opts.openEnabled === undefined ? process.env.KEY_ESCROW_OPEN_ENABLED === "true" : opts.openEnabled;
  const flags = opts.flags ?? custodyFlagsFromEnv();
  const mail = () => (opts.mail ? Promise.resolve(opts.mail) : defaultMail());
  const off = { error: "Key backup is not switched on yet." };

  app.get("/api/v1/key-escrow/status", { preHandler: authMiddleware }, async (request, reply) => {
    reply.header("Cache-Control", "no-store");
    if (!provider) return { enabled: false, hasPhrase: false };
    const userId = (request as any).user.userId as number;
    // Not-allowed accounts see key backup as off, so the web stays quiet for them.
    if (!custodyAllowedForUser(flags, userId)) return { enabled: false, hasPhrase: false };
    const rows = await db.execute(sql`SELECT 1 FROM wallet_key_escrow WHERE user_id = ${userId} AND kind = ${KIND}`);
    return { enabled: true, hasPhrase: ((rows as any).rows ?? (rows as any)).length > 0 };
  });

  app.put("/api/v1/key-escrow/phrase", {
    preHandler: authMiddleware,
    config: { rateLimit: { max: 10, timeWindow: "15 minutes" } },
  }, async (request, reply) => {
    if (!provider) return reply.status(503).send(off);
    const { userId } = (request as any).user as { userId: number };
    if (!custodyAllowedForUser(flags, userId)) return reply.status(403).send({ error: CUSTODY_NOT_AVAILABLE });
    if (await selfCustody(userId)) return reply.status(409).send({ error: "You keep your own keys, so Amma does not store a backup." });
    const phrase = cleanPhrase((request.body as { phrase?: unknown } | undefined)?.phrase);
    if (!phrase) return reply.status(400).send({ error: "That is not a valid 12 or 24 word recovery phrase." });
    const sealed = await sealForEscrow(provider, phrase, { userId, kind: KIND });
    // Same lock as custody onboarding, so a save cannot slip in between its check and write.
    const kept = await db.transaction(async (tx) => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext('custody-onboard'), ${userId})`);
      if (await hasOriginColumn(tx)) {
        const rows = rowsOf(await tx.execute(sql`SELECT origin FROM wallet_key_escrow WHERE user_id = ${userId} AND kind = ${KIND}`)) as { origin: string }[];
        if (rows[0]?.origin === "custody") return true;
      }
      await tx.execute(sql`INSERT INTO wallet_key_escrow (user_id, kind, sealed, provider) VALUES (${userId}, ${KIND}, ${sealed}, ${provider.id})
        ON CONFLICT (user_id, kind) DO UPDATE SET sealed = EXCLUDED.sealed, provider = EXCLUDED.provider, updated_at = now()`);
      return false;
    });
    if (kept) return reply.status(409).send({ error: "Amma already keeps the recovery phrase for your wallets." });
    await auditLog("wallet_key_escrow_save", { userId, detail: { kind: KIND }, ip: request.ip, userAgent: request.headers["user-agent"] });
    reply.header("Cache-Control", "no-store");
    return { saved: true };
  });

  // Off unless KEY_ESCROW_OPEN_ENABLED=true. Guarded by the password, the second factor where the user has
  // one, and an email to the owner before release (audit 2026-11-18). Recovery (key-recovery.ts) remains the
  // way back for someone who no longer has the account password.
  if (openEnabled) app.post("/api/v1/key-escrow/phrase/open", {
    preHandler: authMiddleware,
    config: { rateLimit: { max: 5, timeWindow: "15 minutes" } },
  }, async (request, reply) => {
    if (!provider) return reply.status(503).send(off);
    const { userId } = (request as any).user as { userId: number };
    if (!custodyAllowedForUser(flags, userId)) return reply.status(403).send({ error: CUSTODY_NOT_AVAILABLE });
    const body = (request.body ?? {}) as { password?: unknown; twoFaToken?: unknown };
    const password = body.password;
    if (typeof password !== "string" || !password || password.length > 256) return reply.status(400).send({ error: "Enter your account password." });
    if (await selfCustody(userId)) return reply.status(409).send({ error: "You keep your own keys, so Amma holds no backup for you." });

    const audit = (action: Parameters<typeof auditLog>[0], detail: Record<string, unknown>) =>
      auditLog(action, { userId, detail: { kind: KIND, ...detail }, ip: request.ip, userAgent: request.headers["user-agent"] });
    const [user] = await db.select({ ...secondFactorColumns, passwordHash: schema.users.passwordHash }).from(schema.users).where(eq(schema.users.id, userId)).limit(1);
    if (!user || !(await verifyPassword(password, user.passwordHash))) {
      await audit("wallet_key_escrow_denied", { why: "password" });
      return reply.status(403).send({ error: "That password is not correct." });
    }
    // The owner must be told; an account with no email cannot be, so it cannot read the phrase back here.
    if (!user.email) return reply.status(400).send({ error: "Add an email address to your account before viewing your recovery phrase." });

    if (user.twoFaEnabled) {
      const method = secondFactorMethod(user);
      if (body.twoFaToken === undefined || body.twoFaToken === "") {
        if (method === "email") {
          try { await (await mail()).code(user.email, await issueEmailCode(userId, OPEN_CODE_PURPOSE)); }
          catch { return reply.status(502).send({ error: "The code could not be emailed. Try again." }); }
        }
        reply.header("Cache-Control", "no-store");
        return reply.status(200).send({ twoFaRequired: true, twoFaMethod: method });
      }
      if (!(await verifySecondFactor(user, body.twoFaToken, OPEN_CODE_PURPOSE))) {
        await audit("wallet_key_escrow_denied", { why: "second-factor" });
        return reply.status(403).send({ error: "That code is not correct." });
      }
    }

    const result = await db.execute(sql`SELECT sealed FROM wallet_key_escrow WHERE user_id = ${userId} AND kind = ${KIND}`);
    const row = (((result as any).rows ?? result) as { sealed: string }[])[0];
    if (!row) return reply.status(404).send({ error: "Amma has no backup of a recovery phrase for you." });

    // Tell the owner before anything is decrypted. If the email cannot be sent, nothing is released.
    try { await (await mail()).viewed(user.email, new Date()); }
    catch {
      await audit("wallet_key_escrow_denied", { why: "alert-not-sent" });
      return reply.status(502).send({ error: "We could not send the security email that goes with this, so the phrase was not shown. Try again later." });
    }

    let phrase: string;
    try {
      phrase = await openFromEscrow(provider, row.sealed, { userId, kind: KIND, reason: "owner-restore", ip: request.ip, userAgent: request.headers["user-agent"] });
    } catch {
      return reply.status(500).send({ error: "The backup could not be opened right now. Try again later." });
    }
    reply.header("Cache-Control", "no-store");
    return { phrase };
  });
}
