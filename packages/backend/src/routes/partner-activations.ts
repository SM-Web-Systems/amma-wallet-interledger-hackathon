import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { sql } from "drizzle-orm";
import { db as realDb } from "../db";
import { authMiddleware } from "../middleware/auth";
import { CUSTODY_NOT_AVAILABLE, custodyAllowedForUser, type CustodyFlags } from "../lib/custody-flags";
import { recoveryFreezeActive } from "../lib/key-recovery";
import { type ActivationFlags } from "../lib/activation-flags";
import { ActivationError, rowsOf, type ActivationDb } from "../modules/activation/errors";
import { assertAvailable, activationView, submitActivation, type IntakeDeps } from "../modules/activation/intake";
import { authenticatePartner } from "../modules/activation/partner-auth";
import { activationPaused } from "../modules/activation/pause";
import { sorobanNftHolding, type NftHolding } from "../modules/activation/requirement";

declare module "fastify" { interface FastifyRequest { rawBody?: Buffer } }

export interface PartnerActivationOptions {
  flags: ActivationFlags;
  custodyFlags: Pick<CustodyFlags, "mainnet" | "mainnetUserIds">;
  /** Test seams. */
  db?: ActivationDb;
  now?: () => Date;
  paused?: () => boolean;
  frozen?: (userId: number) => Promise<boolean>;
  nftHolding?: NftHolding;
}

const MESSAGES: Record<string, string> = {};
const pathOf = (request: FastifyRequest) => request.url.split("?")[0];

/**
 * Server-to-server partner API plus the user's own activation state.
 * Partner calls are never made from a browser: there is no CORS here, and the body is parsed from its exact bytes because
 * the Ed25519 signature covers them.
 */
export async function partnerActivationRoutes(app: FastifyInstance, opts: PartnerActivationOptions) {
  const db = opts.db ?? (realDb as unknown as ActivationDb);
  const { flags } = opts;
  const now = opts.now ?? (() => new Date());
  const paused = opts.paused ?? (() => activationPaused(flags.controlFile));
  const deps: IntakeDeps = {
    db, flags, now, paused,
    custodyAllowed: (userId) => custodyAllowedForUser(opts.custodyFlags, userId),
    frozen: opts.frozen ?? recoveryFreezeActive,
    nftHolding: opts.nftHolding ?? sorobanNftHolding(),
  };

  const fail = (request: FastifyRequest, reply: FastifyReply, error: ActivationError) => {
    if (error.retryAfter) reply.header("Retry-After", String(error.retryAfter));
    return reply.status(error.status).send({ error: { code: error.code, message: MESSAGES[error.code] ?? error.code.replaceAll("_", " ").toLowerCase(), retryable: error.retryable, requestId: request.id, ...(error.retryAfter ? { retryAfter: error.retryAfter } : {}) } });
  };
  app.setErrorHandler((cause, request, reply) => {
    if (cause instanceof ActivationError) return fail(request, reply, cause);
    const status = (cause as { statusCode?: number }).statusCode;
    if (status === 413) return fail(request, reply, new ActivationError("REQUEST_TOO_LARGE", 413));
    if (status && status >= 400 && status < 500) return fail(request, reply, new ActivationError("INVALID_REQUEST", 400));
    request.log.warn({ event: "activation_request_failed", requestId: request.id }, "activation request failed"); // no error object: it can carry SQL and values
    return fail(request, reply, new ActivationError("ACTIVATION_UNAVAILABLE", 503, true));
  });

  // The signature covers the bytes as received, so keep them next to the parsed value.
  app.addContentTypeParser("application/json", { parseAs: "buffer", bodyLimit: 65_536 }, (request, body, done) => {
    request.rawBody = body as Buffer;
    try { done(null, JSON.parse((body as Buffer).toString("utf8"))); } catch { done(new ActivationError("INVALID_REQUEST", 400) as any, undefined); }
  });

  const auth = (request: FastifyRequest, method: string, scope: "activation:write" | "activation:read") =>
    authenticatePartner(db, { headers: request.headers, method, path: pathOf(request), rawBody: request.rawBody ?? Buffer.alloc(0) }, scope, now());

  app.post("/api/v1/partner/activations", { bodyLimit: 65_536, config: { rateLimit: { max: 120, timeWindow: "1 minute" } } }, async (request, reply) => {
    reply.header("Cache-Control", "no-store");
    assertAvailable({ flags, paused }); // 1. switch and pause file, before anything else
    const partner = await auth(request, "POST", "activation:write"); // 2. key, scope, signature, timestamp
    const result = await submitActivation(deps, partner, request.body, { ip: request.ip, userAgent: request.headers["user-agent"] });
    return reply.status(result.status).send(result.body);
  });

  app.get("/api/v1/partner/activations/:activationId", { config: { rateLimit: { max: 120, timeWindow: "1 minute" } } }, async (request, reply) => {
    reply.header("Cache-Control", "no-store");
    if (!flags.enabled) throw new ActivationError("ACTIVATION_OFF", 503);
    const partner = await auth(request, "GET", "activation:read");
    const id = (request.params as { activationId: string }).activationId;
    const view = /^[1-9]\d{0,14}$/.test(id) ? await activationView(db, Number(id), partner.tenantId, flags) : null;
    if (!view) throw new ActivationError("ACTIVATION_NOT_FOUND", 404);
    return reply.send(view);
  });

  // The signed-in user's own state, for the wallet screen. Reads only; nothing the browser sends can start an activation.
  app.get("/api/v1/custody/activation", { preHandler: authMiddleware, config: { rateLimit: { max: 60, timeWindow: "1 minute" } } }, async (request, reply) => {
    reply.header("Cache-Control", "no-store");
    if (!flags.enabled) throw new ActivationError("ACTIVATION_OFF", 503);
    const { userId } = (request as any).user as { userId: number };
    if (!custodyAllowedForUser(opts.custodyFlags, userId)) return reply.status(403).send({ error: CUSTODY_NOT_AVAILABLE });
    const wallet = rowsOf<{ public_key: string }>(await db.execute(sql`SELECT public_key FROM user_wallets WHERE user_id = ${userId} AND chain = 'stellar' AND network = ${flags.network} AND derivation_index = 0 AND is_active = true`))[0];
    if (!wallet) return reply.send({ wallets: [] });
    const rows = rowsOf<{ state: string; tx_hash: string | null; confirmed_at: string | null; partner: string }>(await db.execute(sql`
      SELECT a.state, a.tx_hash, a.confirmed_at, t.name AS partner FROM wallet_activations a JOIN tenants t ON t.id = a.tenant_id
      WHERE a.user_id = ${userId} AND a.chain = 'stellar' AND a.network = ${flags.network} AND a.address = ${wallet.public_key} ORDER BY a.id DESC`));
    const confirmed = rows.find((r) => r.state === "confirmed");
    const has = (...s: string[]) => rows.some((r) => s.includes(r.state));
    const state = confirmed || has("skipped_already_active") ? "active" : has("reserved", "submitting", "submitted") ? "activating" : has("failed") ? "delayed"
      : has("refunded", "failed_final") ? "failed" : "not_activated";
    return reply.send({ wallets: [{ chain: "stellar", network: flags.network, address: wallet.public_key, state, ...(confirmed ? { activatedBy: confirmed.partner, activatedAt: confirmed.confirmed_at, txHash: confirmed.tx_hash } : {}) }] });
  });
}
