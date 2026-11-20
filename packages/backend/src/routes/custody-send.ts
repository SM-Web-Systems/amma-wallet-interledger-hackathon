import { createHmac, hkdfSync } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { and, eq, sql } from "drizzle-orm";
import { hashes, isValidClassicAddress } from "xrpl";
import { config } from "../config";
import { db, schema } from "../db";
import { authMiddleware } from "../middleware/auth";
import { appLog } from "../lib/app-log";
import { auditLogStrict } from "../lib/audit";
import { oneAtATime } from "../lib/custody-lock";
import { checkCustodyPasswordOnly, type Refusal } from "../lib/custody-sign";
import { custodyPreflight } from "../lib/custody-preflight";
import { CustodyRefused, withDelegatedKey } from "../lib/custody-signer";
import { CUSTODY_NOT_AVAILABLE, custodyAllowedForUser, custodyFlagsFromEnv, type CustodyFlags } from "../lib/custody-flags";
import { checkXrpLimits, custodyLimitsFromEnv, type CustodyLimits } from "../lib/custody-limits";
import { networksFor, xrplCustodyAllowed } from "../lib/custody-networks";
import { masterKeyProviderFromEnv, type MasterKeyProvider } from "../lib/key-wrapper";
import { custodyXrplActivation } from "../lib/xrpl-activation";
import { PaymentError, strictObject, uuid } from "../modules/xrpl/payment";
import { XrplPaymentService, type PaymentNetwork } from "../modules/xrpl/payment-service";
import { XrplReconciliationAdapter } from "../modules/xrpl/reconciliation-adapter";
import { XrplReadError } from "../modules/xrpl/validation";
import { assertSubmissionAllowed, type SubmissionGate } from "../modules/xrpl/submission-control";
import type { XrplNetwork } from "../modules/xrpl/config";

/**
 * Server send from Amma-held wallets (testnet; on mainnet only with XRPL_MAINNET_CUSTODY=on, behind CUSTODY_SERVER_SIGNING).
 * XRP goes through the same intent -> prepare -> submit pipeline that browser signing uses; only the signature comes from here.
 */
export interface CustodySendOptions {
  provider?: MasterKeyProvider | null;
  flags?: CustodyFlags;
  limits?: () => CustodyLimits;
  network?: PaymentNetwork;
  submissionGate?: SubmissionGate;
  /** Secret for the payment reference. Default: CUSTODY_SEND_HMAC_KEY, else derived from KEY_WRAP_MASTER_KEY. */
  hmacKey?: Buffer | null;
}

const MAX_FEE_CEILING_DROPS = "200";
const SENT_STATES = sql`('signed','submitted','validated_success')`;
/** Everything that has used, or is about to use, part of the budget. */
const COUNTED_STATES = sql`('awaiting_approval','prepared','signed','submitted','validated_success')`;
const AMOUNT_PLUS_FEE = sql`((request->>'amountDrops')::numeric + COALESCE((preparation->>'feeDrops')::numeric, (request->>'maxFeeDrops')::numeric, 0))`;
const rowsOf = <T,>(r: any): T[] => (r?.rows ?? r) as T[];
const SIGNED_UNKNOWN = "The payment was signed but could not be confirmed as sent. Check its status before trying again.";

class Refused extends Error { constructor(public status: number, message: string, public awaitingIntents?: number) { super(message); } }

/** The server-side secret that makes payment references unguessable, so only this route can create intents it will sign. */
export function custodySendHmacKey(env: Record<string, string | undefined> = process.env): Buffer | null {
  if (env.CUSTODY_SEND_HMAC_KEY) {
    if (env.CUSTODY_SEND_HMAC_KEY.length < 32) throw new Error("CUSTODY_SEND_HMAC_KEY must be at least 32 characters.");
    return Buffer.from(env.CUSTODY_SEND_HMAC_KEY, "utf8");
  }
  if (env.KEY_WRAP_MASTER_KEY) return Buffer.from(hkdfSync("sha256", Buffer.from(env.KEY_WRAP_MASTER_KEY, "base64"), Buffer.alloc(0), "amma-custody-send-reference-v1", 32));
  return null;
}

/** A keyed reference for an idempotency key: a retry is recognised, and no one without the secret can pre-create a matching intent. */
const referenceFor = (key: Buffer, userId: number, idempotencyKey: string) => {
  const h = createHmac("sha256", key).update(`custody-send:xrpl:${userId}:${idempotencyKey}`).digest("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
};

function parseBody(raw: unknown) {
  let b: Record<string, unknown>;
  try { b = strictObject(raw, ["from", "to", "amountDrops", "password", "idempotencyKey"], ["destinationTag"]); }
  catch { throw new Refused(400, "That request is not valid."); }
  const { from, to, amountDrops, password, destinationTag } = b;
  if (typeof from !== "string" || !isValidClassicAddress(from)) throw new Refused(400, "The sending address is not valid.");
  if (typeof to !== "string" || !isValidClassicAddress(to)) throw new Refused(400, "The destination address is not valid.");
  if (typeof amountDrops !== "string" || !/^[1-9][0-9]{0,17}$/.test(amountDrops)) throw new Refused(400, "The amount must be a whole number of drops more than 0.");
  if (typeof password !== "string" || password.length < 1 || password.length > 256) throw new Refused(400, "A password is required.");
  if (destinationTag !== undefined && (!Number.isInteger(destinationTag) || (destinationTag as number) < 0 || (destinationTag as number) > 4294967295)) throw new Refused(400, "The destination tag is not valid.");
  let idempotencyKey: string;
  try { idempotencyKey = uuid(b.idempotencyKey); } catch { throw new Refused(400, "The idempotency key must be a UUID."); }
  return { from, to, amountDrops, password, destinationTag: destinationTag as number | undefined, idempotencyKey };
}

const PAYMENT_MESSAGES: Record<string, [number, string]> = {
  INSUFFICIENT_SPENDABLE_BALANCE: [400, "There is not enough XRP in this wallet to cover the amount, the network fee and the account reserve."],
  SOURCE_NOT_FUNDED: [400, "This wallet has not been funded on the XRP test network yet."],
  DESTINATION_RESERVE_REQUIRED: [400, "The destination account does not exist yet, so the first payment must be at least the account reserve (1 XRP)."],
  TAG_REQUIRED: [400, "The destination requires a destination tag."],
  UNSUPPORTED_DESTINATION: [400, "The destination does not accept this kind of payment."],
  SELF_PAYMENT_NOT_ALLOWED: [400, "You can't send to the same wallet."],
  FEE_LIMIT_EXCEEDED: [503, "The network fee is unusually high right now. Try again later."],
  IDEMPOTENCY_CONFLICT: [409, "That idempotency key was already used for a different payment."],
  PAYMENT_UNRESOLVED: [409, "Another payment from this wallet is still being processed. Wait for it to finish, then try again."],
  RECOVERY_IN_PROGRESS: [409, "This payment is being checked by the system. Check its status shortly."],
  WALLET_NOT_FOUND: [403, "That is not one of your XRP wallets."],
  PAYMENT_REVIEW_REQUIRED: [409, "This payment needs a manual review before anything else can happen."],
  PAYMENT_INTEGRITY_REVIEW_REQUIRED: [409, "This payment needs a manual review before anything else can happen."],
};

/** Drops as XRP for messages: "1", "1.2", "0.000012". */
export const showXrp = (drops: string): string => {
  const v = BigInt(drops), whole = v / 1_000_000n, frac = (v % 1_000_000n).toString().padStart(6, "0").replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : `${whole}`;
};
export const NOT_ACTIVATED = "This wallet is not activated yet. It is activated when you complete an eligible task.";

/** Network-specific wording, with the ledger's own reserve amounts when the pipeline reports them. */
function paymentMessage(cause: PaymentError, mainnet: boolean): [number, string] | undefined {
  const d = cause.detail;
  if (cause.code === "INSUFFICIENT_SPENDABLE_BALANCE" && d?.reserveDrops) {
    // The live ledger values: base reserve, and the owner reserve for the objects this wallet owns.
    const items = Number(d.ownerCount ?? "0"), base = d.baseReserveDrops;
    const why = base === undefined ? "the account reserve"
      : items > 0 ? `the ${showXrp(base)} XRP base reserve plus ${showXrp((BigInt(d.reserveDrops) - BigInt(base)).toString())} XRP for the ${items} item${items === 1 ? "" : "s"} it owns`
      : `the ${showXrp(base)} XRP base reserve`;
    const left = BigInt(d.spendableDrops ?? "0") - BigInt(d.feeDrops ?? "0");
    return [400, `There is not enough XRP in this wallet for that: the XRP Ledger keeps ${showXrp(d.reserveDrops)} XRP locked in it (${why}). You can send up to ${showXrp(left > 0n ? left.toString() : "0")} XRP after the network fee.`];
  }
  if (cause.code === "DESTINATION_RESERVE_REQUIRED" && d?.reserveDrops) {
    return [400, `The destination account is not activated on the XRP Ledger yet, so this payment must be at least ${showXrp(d.reserveDrops)} XRP (the base reserve). A smaller payment would fail (tecNO_DST_INSUF_XRP).`];
  }
  if (cause.code === "SOURCE_NOT_FUNDED" && mainnet) return [400, NOT_ACTIVATED];
  return PAYMENT_MESSAGES[cause.code];
}

const plainError = (cause: unknown, mainnet = false): { status: number; error: string } => {
  const ledger = mainnet ? "The XRP Ledger" : "The XRP test network";
  if (cause instanceof Refused) return { status: cause.status, error: cause.message };
  if (cause instanceof PaymentError) {
    const known = paymentMessage(cause, mainnet);
    if (known) return { status: known[0], error: known[1] };
    return { status: cause.status >= 500 ? 503 : cause.status, error: cause.status >= 500 ? `${ledger} could not complete this right now. Try again shortly.` : "That payment can't be sent." };
  }
  if (cause instanceof XrplReadError) return { status: 503, error: `${ledger} is not reachable right now. Try again shortly.` };
  if (cause instanceof CustodyRefused) {
    switch (cause.code) {
      case "off": return { status: 503, error: "Sending from Amma-held wallets is not switched on here." };
      case "self": return { status: 403, error: "Delegated signing is not enabled." };
      case "frozen": return { status: 423, error: "This account is frozen while a recovery request is waiting." };
      case "not-allowed": return { status: 403, error: CUSTODY_NOT_AVAILABLE };
      default: return { status: 409, error: "Amma can't sign for this wallet. Use your wallet passphrase." };
    }
  }
  appLog().error({ code: typeof (cause as any)?.code === "string" ? (cause as any).code : "unknown" }, "custody_send_xrpl_failed");
  return { status: 503, error: "The payment could not be completed right now. Nothing was lost; try again." };
};

export async function custodySendRoutes(app: FastifyInstance, opts: CustodySendOptions = {}) {
  const provider = opts.provider === undefined ? masterKeyProviderFromEnv() : opts.provider;
  const flags = opts.flags ?? custodyFlagsFromEnv();
  const parsedLimits = opts.limits ? null : custodyLimitsFromEnv();
  const limits = opts.limits ?? (() => parsedLimits!);
  const hmacKey = opts.hmacKey === undefined ? custodySendHmacKey() : opts.hmacKey;
  const networks = networksFor(flags);
  // XRP custody runs on testnet, or on mainnet only with XRPL_MAINNET_CUSTODY=on. Otherwise every XRP request below is refused before any read.
  const xrplOn = xrplCustodyAllowed(flags);
  const net = networks.xrpl as XrplNetwork;
  const ledger: PaymentNetwork = opts.network ?? new XrplReconciliationAdapter();
  // The service refuses to start if the ledger connection is on another network than the custody rows.
  const service = new XrplPaymentService(ledger, opts.submissionGate ?? assertSubmissionAllowed, xrplOn ? net : undefined);

  /** One budget per user across all of the user's XRP wallets: payments sent or in flight in the last 24 hours, with fees. Pass `exceptId` to leave one intent out (the one being checked); every other counted row is included, so a race across instances fails safe. */
  async function usage(q: { execute: (s: any) => Promise<any> }, userId: number, to: string, o: { exceptKey?: string; exceptId?: string }) {
    const scope = o.exceptId ? sql`AND id <> ${o.exceptId}` : sql`AND idempotency_key <> ${o.exceptKey ?? ""}`;
    const [{ sent }] = rowsOf<{ sent: string }>(await q.execute(sql`SELECT COALESCE(SUM(${AMOUNT_PLUS_FEE}), 0)::text AS sent FROM xrpl_payments
      WHERE user_id = ${userId} AND chain = 'xrpl' AND network = ${net} AND state IN ${COUNTED_STATES} AND created_at > now() - interval '24 hours' ${scope}`));
    const [{ paid }] = rowsOf<{ paid: boolean }>(await q.execute(sql`SELECT EXISTS (SELECT 1 FROM xrpl_payments
      WHERE user_id = ${userId} AND chain = 'xrpl' AND network = ${net} AND request->>'destination' = ${to} AND state IN ${SENT_STATES}) AS paid`));
    return { sent: BigInt(sent), newRecipient: !paid };
  }

  /** Unfinished intents (created but not yet approved or signed) that are using part of this user's budget. */
  const awaitingCount = async (userId: number, exceptKey: string) =>
    Number(rowsOf<{ n: number }>(await db.execute(sql`SELECT count(*)::int AS n FROM xrpl_payments WHERE user_id = ${userId} AND chain = 'xrpl' AND network = ${net}
      AND state = 'awaiting_approval' AND created_at > now() - interval '24 hours' AND idempotency_key <> ${exceptKey}`))[0]?.n ?? 0);

  app.post("/api/v1/custody/xrpl/send", {
    preHandler: authMiddleware,
    bodyLimit: 4096,
    config: { rateLimit: { max: 10, timeWindow: "1 minute" } },
  }, async (request, reply) => {
    reply.header("Cache-Control", "no-store");
    const userId = request.user!.userId;
    const ctx = { ip: request.ip, userAgent: request.headers["user-agent"] };
    // Set once this request has an intent: if it was signed and something then failed, the outcome is unknown, not "nothing was lost".
    let paymentId: string | undefined;
    try {
      if (!flags.serverSigning || !provider) throw new CustodyRefused("off", "off");
      if (!custodyAllowedForUser(flags, userId)) throw new CustodyRefused("not-allowed", CUSTODY_NOT_AVAILABLE);
      // On mainnet the XRP payment pipeline is used for Amma-held wallets only, and only with XRPL_MAINNET_CUSTODY=on.
      if (!xrplOn) throw new Refused(503, "XRP sending from Amma-held wallets isn't available on mainnet yet.");
      if (!config.XRPL.enabled || !config.XRPL_PAYMENTS_ENABLED) throw new Refused(503, "XRP payments are not switched on here yet.");
      if ((config.XRPL.network ?? "testnet") !== net) throw new Refused(503, "XRP payments are not set up for this network here.");
      if (!hmacKey) throw new Refused(503, "Sending from Amma-held wallets is not set up here yet.");
      const body = parseBody(request.body);
      const amount = BigInt(body.amountDrops), feeCeiling = BigInt(MAX_FEE_CEILING_DROPS);
      const reference = referenceFor(hmacKey, userId, body.idempotencyKey);
      const refuse = async (limit: NonNullable<ReturnType<typeof checkXrpLimits>>) => {
        await auditLogStrict("custody_limit_refused", { userId, ip: ctx.ip, userAgent: ctx.userAgent, detail: { chain: "xrpl", limit: limit.limit, amountDrops: body.amountDrops, from: body.from } });
        const n = await awaitingCount(userId, body.idempotencyKey);
        return new Refused(limit.status, n > 0 ? `${limit.error} ${n} payment${n === 1 ? "" : "s"} waiting for approval ${n === 1 ? "is" : "are"} using part of your daily limit.` : limit.error, n > 0 ? n : undefined);
      };
      return await oneAtATime(userId, async () => {
        const denied: Refusal | null = await checkCustodyPasswordOnly({ provider, flags, userId, password: body.password, ...ctx }, "xrpl");
        if (denied) throw new Refused(denied.status, denied.error);
        const notReady = await custodyPreflight({ userId, chain: "xrpl", from: body.from, networks, flags });
        if (notReady) throw new Refused(notReady.status, notReady.error);

        const [wallet] = await db.select({ id: schema.userWallets.id }).from(schema.userWallets).where(and(
          eq(schema.userWallets.userId, userId), eq(schema.userWallets.chain, "xrpl"), eq(schema.userWallets.network, net), eq(schema.userWallets.publicKey, body.from))).limit(1);
        if (!wallet) throw new Refused(403, "That is not one of your XRP wallets.");

        // Only intents this route created are ever signed here: the reference is keyed with a server secret.
        const existing = rowsOf<{ id: string; state: string; reference: string; request: Record<string, unknown> }>(await db.execute(sql`SELECT id, state, reference, request FROM xrpl_payments
          WHERE user_id = ${userId} AND chain = 'xrpl' AND network = ${net} AND application_tenant_id IS NULL AND idempotency_key = ${body.idempotencyKey}`))[0];
        if (existing && existing.reference !== reference) throw new Refused(409, "That idempotency key was already used for a different payment.");
        // The same key for a different payment is refused as it is: the original intent is left alone.
        if (existing) {
          const q = existing.request;
          if (q.amountDrops !== body.amountDrops || q.destination !== body.to || q.destinationTag !== body.destinationTag || q.walletId !== String(wallet.id)) throw new Refused(409, "That idempotency key was already used for a different payment.");
        }
        const sentAlready = existing && !["awaiting_approval", "prepared"].includes(existing.state);

        // Limits are checked on every call, including a retry of an intent that has not been sent. Only a payment already signed or sent is returned as it is.
        if (!sentAlready) {
          const u = await usage(db, userId, body.to, { exceptKey: body.idempotencyKey });
          const limit = checkXrpLimits(limits(), { amount, sentToday: u.sent + feeCeiling, newRecipient: u.newRecipient });
          if (limit) {
            if (existing?.state === "awaiting_approval") await service.cancel(userId, existing.id).catch(() => undefined);
            throw await refuse(limit);
          }
        }

        const intent = await service.create(userId, {
          schemaVersion: 1, walletId: String(wallet.id), chain: "xrpl", network: net, destination: body.to,
          ...(body.destinationTag === undefined ? {} : { destinationTag: body.destinationTag }),
          amountDrops: body.amountDrops, maxFeeDrops: MAX_FEE_CEILING_DROPS, reference,
        }, body.idempotencyKey);

        paymentId = intent.id;
        let payment: Awaited<ReturnType<typeof service.status>> = intent;
        if (intent.state === "awaiting_approval" || intent.state === "prepared") {
          // Reserve the budget: under a per-user database lock, count every other counted intent. Two racing sends may both be refused, but never both let through.
          const over = await db.transaction(async (tx) => {
            await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext('custody-send'), ${userId})`);
            const u = await usage(tx, userId, body.to, { exceptId: intent.id });
            return checkXrpLimits(limits(), { amount, sentToday: u.sent + feeCeiling, newRecipient: u.newRecipient });
          });
          if (over) {
            if (intent.state === "awaiting_approval") await service.cancel(userId, intent.id).catch(() => undefined);
            throw await refuse(over);
          }

          const prepared = intent.state === "prepared" ? intent : await service.prepare(userId, intent.id);
          const preparation = prepared.preparation!;
          const blob = await withDelegatedKey({ provider, flags, userId, chain: "xrpl", expectedAddress: body.from, reason: "custody-send:xrpl", ...ctx },
            async ({ xrplWallet }) => xrplWallet!.sign(preparation.unsignedTransaction).tx_blob);
          // Recorded before anything is broadcast; if it cannot be written, nothing is sent.
          await auditLogStrict("custody_send", { userId, ip: ctx.ip, userAgent: ctx.userAgent, detail: { chain: "xrpl", from: body.from, to: body.to, amountDrops: body.amountDrops, paymentId: intent.id, hash: hashes.hashSignedTx(blob) } });
          payment = await service.submit(userId, intent.id, preparation.preparationId, blob);
        } else {
          payment = await service.status(userId, intent.id);
        }
        const { preparation: _p, receipt: _r, ...out } = payment;
        return reply.status(["validated_success", "validated_failure", "expired"].includes(payment.state) ? 200 : 202).send({ ...out, hash: payment.transactionHash });
      });
    } catch (cause) {
      // A refusal or a 4xx payment error is a definite answer; anything else after the payment was signed is "outcome unknown".
      const definite = cause instanceof Refused || cause instanceof CustodyRefused || (cause instanceof PaymentError && cause.status < 500);
      if (paymentId && !definite) {
        const [stored] = rowsOf<{ id: string; state: string; transaction_hash: string }>(await db.execute(sql`SELECT id, state, transaction_hash FROM xrpl_payments WHERE id = ${paymentId} AND user_id = ${userId} AND transaction_hash IS NOT NULL`).catch(() => []));
        if (stored) {
          appLog().warn({ reason: typeof (cause as any)?.code === "string" ? (cause as any).code : "unknown", paymentId }, "custody_send_xrpl_outcome_unknown");
          return reply.status(202).send({ id: stored.id, state: stored.state, hash: stored.transaction_hash, transactionHash: stored.transaction_hash, status: "unknown", error: SIGNED_UNKNOWN });
        }
      }
      const { status, error } = plainError(cause, networks.mainnet);
      let awaitingIntents = cause instanceof Refused ? cause.awaitingIntents : undefined;
      if (cause instanceof PaymentError && cause.code === "PAYMENT_UNRESOLVED") {
        const key = (request.body as { idempotencyKey?: unknown } | null)?.idempotencyKey;
        try { awaitingIntents = (await awaitingCount(userId, typeof key === "string" ? key : "")) || undefined; } catch { /* the refusal itself still goes out */ }
      }
      return reply.status(status).send(awaitingIntents ? { error, awaitingIntents } : { error });
    }
  });

  /** Balance and activation state of one of the user's own Amma-held XRP wallets (the web shows "Not activated yet" from it). Read-only. */
  app.get("/api/v1/custody/xrpl/account", {
    preHandler: authMiddleware,
    config: { rateLimit: { max: 30, timeWindow: "1 minute" } },
  }, async (request, reply) => {
    reply.header("Cache-Control", "no-store");
    const userId = request.user!.userId;
    const address = (request.query as { address?: unknown } | null)?.address;
    try {
      if (!flags.serverSigning) throw new CustodyRefused("off", "off");
      if (!custodyAllowedForUser(flags, userId)) throw new CustodyRefused("not-allowed", CUSTODY_NOT_AVAILABLE);
      if (!xrplOn) throw new Refused(503, "XRP for Amma-held wallets isn't available on mainnet yet.");
      if (!config.XRPL.enabled || (config.XRPL.network ?? "testnet") !== net) throw new Refused(503, "XRP is not switched on here yet.");
      if (typeof address !== "string" || !isValidClassicAddress(address)) throw new Refused(400, "The address is not valid.");
      const result = await custodyXrplActivation({ userId, address, flags, reader: ledger });
      if (!result.ok) return reply.status(result.status).send({ error: result.error });
      const a = result.activation;
      return { address: a.address, network: a.network, activated: a.activated, balanceDrops: a.balanceDrops, reserveDrops: a.reserveDrops, spendableDrops: a.spendableDrops, baseReserveDrops: a.baseReserveDrops };
    } catch (cause) {
      const { status, error } = plainError(cause, networks.mainnet);
      return reply.status(status).send({ error });
    }
  });

  /** Status of one of the user's own XRP payments on the custody network (mainnet builds use this; the browser-signing routes stay testnet-only). */
  app.get("/api/v1/custody/xrpl/payments/:id", {
    preHandler: authMiddleware,
    config: { rateLimit: { max: 30, timeWindow: "1 minute" } },
  }, async (request, reply) => {
    reply.header("Cache-Control", "no-store");
    const userId = request.user!.userId;
    try {
      if (!flags.serverSigning) throw new CustodyRefused("off", "off");
      if (!custodyAllowedForUser(flags, userId)) throw new CustodyRefused("not-allowed", CUSTODY_NOT_AVAILABLE);
      if (!xrplOn) throw new Refused(503, "XRP for Amma-held wallets isn't available on mainnet yet.");
      if (!config.XRPL.enabled || !config.XRPL_PAYMENTS_ENABLED || (config.XRPL.network ?? "testnet") !== net) throw new Refused(503, "XRP payments are not switched on here yet.");
      let id: string;
      try { id = uuid((request.params as { id?: unknown }).id); } catch { throw new Refused(400, "That payment id is not valid."); }
      const payment = await service.status(userId, id);
      const { preparation: _p, receipt: _r, ...out } = payment;
      return { ...out, hash: payment.transactionHash };
    } catch (cause) {
      if (cause instanceof PaymentError && cause.code === "PAYMENT_NOT_FOUND") return reply.status(404).send({ error: "That payment was not found." });
      const { status, error } = plainError(cause, networks.mainnet);
      return reply.status(status).send({ error });
    }
  });
}
