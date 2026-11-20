import type { FastifyInstance, FastifyRequest } from "fastify";
import { eq } from "drizzle-orm";
import * as StellarSdk from "@stellar/stellar-sdk";
import { db, schema } from "../db";
import { authMiddleware } from "../middleware/auth";
import { verifyAccessToken } from "../lib/auth";
import { appLog } from "../lib/app-log";
import { auditLogStrict } from "../lib/audit";
import { oneAtATime } from "../lib/custody-lock";
import { checkCustodyPasswordOnly } from "../lib/custody-sign";
import { custodyPreflight } from "../lib/custody-preflight";
import { CustodyRefused, withDelegatedKey } from "../lib/custody-signer";
import { CUSTODY_NOT_AVAILABLE, custodyAllowedForUser, custodyFlagsFromEnv, type CustodyFlags } from "../lib/custody-flags";
import { masterKeyProviderFromEnv, type MasterKeyProvider } from "../lib/key-wrapper";
import { LmsClaimExpired, parseLmsClaim } from "../lib/lms-claim";
import { networksFor } from "../lib/custody-networks";

/**
 * Approves an LMS reward claim for an Amma-held Stellar wallet (testnet, or mainnet in MAINNET_CUSTODY mode; behind CUSTODY_SERVER_SIGNING).
 * Signs only text that parseLmsClaim accepts, so this route can never be used to sign an arbitrary message.
 */
export interface CustodyLmsClaimOptions { provider?: MasterKeyProvider | null; flags?: CustodyFlags }

/** Rate-limit key: the verified user, so rotating addresses or headers cannot widen the limit. */
export const lmsClaimRateKey = (request: FastifyRequest): string => {
  try {
    const authorization = request.headers.authorization;
    if (authorization?.startsWith("Bearer ")) {
      const user = verifyAccessToken(authorization.slice(7));
      if (user.type === "user" && Number.isSafeInteger(user.userId) && user.userId > 0) return `custody-lms-claim:user:${user.userId}`;
    }
  } catch { /* fall back to the address */ }
  return request.ip;
};

const NOT_VALID = "This is not a valid LMS reward claim.";

export async function custodyLmsClaimRoutes(app: FastifyInstance, opts: CustodyLmsClaimOptions = {}) {
  const provider = opts.provider === undefined ? masterKeyProviderFromEnv() : opts.provider;
  const flags = opts.flags ?? custodyFlagsFromEnv();

  app.post("/api/v1/custody/lms-claim/sign", {
    preHandler: authMiddleware,
    bodyLimit: 4096,
    config: { rateLimit: { max: 10, timeWindow: "1 minute", keyGenerator: lmsClaimRateKey } },
  }, async (request, reply) => {
    reply.header("Cache-Control", "no-store");
    if (!provider || !flags.serverSigning) return reply.status(503).send({ error: "Approving with your Amma password is not switched on here yet." });
    const userId = request.user!.userId;
    if (!custodyAllowedForUser(flags, userId)) return reply.status(403).send({ error: CUSTODY_NOT_AVAILABLE });
    const ctx = { ip: request.ip, userAgent: request.headers["user-agent"] };

    const raw = request.body;
    const b = (raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {}) as Record<string, unknown>;
    if (Object.keys(b).some((k) => k !== "message" && k !== "password")) return reply.status(400).send({ error: "That request is not valid." });
    const { message, password } = b;
    if (typeof password !== "string" || password.length < 1 || password.length > 256) return reply.status(400).send({ error: "A password is required." });
    if (typeof message !== "string" || message.length > 1024) return reply.status(400).send({ error: NOT_VALID });
    let claim: ReturnType<typeof parseLmsClaim>;
    try { claim = parseLmsClaim(message); } catch (e) {
      // Checked before the password and any key use. Only a well-formed but expired claim gets the specific answer.
      if (e instanceof LmsClaimExpired) return reply.status(400).send({ error: e.message, code: "claim_expired" });
      return reply.status(400).send({ error: NOT_VALID });
    }
    // A claim that names a network must name this server's custody network (not STELLAR_NETWORK: custody stays on testnet unless mainnet custody is on); one that names none is accepted as before.
    if (claim.network && claim.network !== (networksFor(flags).stellar === "public" ? "mainnet" : "testnet")) return reply.status(400).send({ error: "This claim is for a different network than this server." });

    try {
      return await oneAtATime(userId, async () => {
        const [user] = await db.select({ signingMode: schema.users.signingMode }).from(schema.users).where(eq(schema.users.id, userId)).limit(1);
        if (user?.signingMode === "self") return reply.status(409).send({ error: "You keep your own keys, so Amma does not sign for you. Use your wallet passphrase." });
        const denied = await checkCustodyPasswordOnly({ provider, flags, userId, password, ...ctx }, "stellar");
        if (denied) return reply.status(denied.status).send({ error: denied.error });
        const notReady = await custodyPreflight({ userId, chain: "stellar", from: claim.destination, networks: networksFor(flags), flags });
        if (notReady) return reply.status(notReady.status).send({ error: notReady.error });

        const signature = await withDelegatedKey({ provider, flags, userId, chain: "stellar", expectedAddress: claim.destination, reason: "lms-claim-sign", ...ctx },
          async ({ stellarSecret }) => Buffer.from(StellarSdk.Keypair.fromSecret(stellarSecret!).sign(Buffer.from(message, "utf8"))).toString("base64"));
        await auditLogStrict("custody_lms_claim_signed", { userId, detail: { claimId: claim.claimId, destination: claim.destination, amountStroops: claim.amountStroops.toString(), expires: claim.expiresAt.toISOString() }, ...ctx });
        return reply.send({ signature });
      });
    } catch (e) {
      if (e instanceof CustodyRefused) {
        switch (e.code) {
          case "off": return reply.status(503).send({ error: "Approving with your Amma password is not switched on here yet." });
          case "self": return reply.status(409).send({ error: "You keep your own keys, so Amma does not sign for you. Use your wallet passphrase." });
          case "not-allowed": return reply.status(403).send({ error: CUSTODY_NOT_AVAILABLE });
          case "frozen": return reply.status(423).send({ error: "This account is frozen while a recovery request is waiting." });
          default: return reply.status(409).send({ error: "Amma can't sign for this wallet. Use your wallet passphrase." });
        }
      }
      appLog().error({ code: typeof (e as any)?.code === "string" ? (e as any).code : "unknown" }, "custody_lms_claim_failed");
      return reply.status(503).send({ error: "The claim could not be approved right now. Try again." });
    }
  });
}
