import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { and, eq, sql } from "drizzle-orm";
import { db, schema } from "../db";
import { config } from "../config";
import { authMiddleware } from "../middleware/auth";
import { classicAddress, XrplReadError } from "../modules/xrpl/validation";
import { XrplReadAdapter } from "../modules/xrpl/read-adapter";

function error(reply: FastifyReply, status: number, code: string, message: string) {
  return reply.status(status).send({ error: { code, message, retryable: status >= 500 } });
}
function owned(userId: number) {
  return and(eq(schema.userWallets.userId, userId), eq(schema.userWallets.chain, "xrpl"), eq(schema.userWallets.network, "testnet"));
}
const fields = { id: schema.userWallets.id, userId: schema.userWallets.userId, name: schema.userWallets.name,
  publicKey: schema.userWallets.publicKey, isActive: schema.userWallets.isActive };
function publicWallet(wallet: { id: number; userId: number; name: string; publicKey: string; isActive: boolean | null }) {
  return { id: String(wallet.id), ownerId: String(wallet.userId), name: wallet.name, address: wallet.publicKey,
    chain: "xrpl" as const, network: "testnet" as const, custody: "self" as const, isActive: wallet.isActive === true };
}
const params = { type: "object", required: ["id"], properties: { id: { type: "string", pattern: "^[1-9][0-9]{0,14}$" } } };

export async function xrplWalletRoutes(app: FastifyInstance, options: { reader?: Pick<XrplReadAdapter, "getAccount"> } = {}) {
  const guard = async (request: FastifyRequest, reply: FastifyReply) => {
    if (!config.XRPL.enabled) return error(reply, 503, "XRPL_DISABLED", "XRP is not enabled on this deployment.");
    // Self-custody XRP wallets are testnet-only; on mainnet only Amma-held wallets exist (routes/custody, custody-send).
    if ((config.XRPL.network ?? "testnet") !== "testnet") return error(reply, 503, "XRPL_TESTNET_ONLY", "Your own XRP wallets are only available on the test network.");
    await authMiddleware(request, reply);
    if (reply.sent) return;
    if (request.user?.type !== "user" || !Number.isSafeInteger(request.user.userId) || request.user.userId <= 0) {
      return error(reply, 401, "USER_SESSION_REQUIRED", "Sign in to manage your XRP wallets.");
    }
    // Application/API-key access is not introduced by wallet onboarding.
    if (request.headers["x-api-key"] !== undefined) return error(reply, 403, "USER_SESSION_REQUIRED", "Use your personal wallet session.");
  };
  const safe = (handler: (request: FastifyRequest, reply: FastifyReply) => Promise<unknown>) => async (request: FastifyRequest, reply: FastifyReply) => {
    try { return await handler(request, reply); }
    catch (cause) {
      if (cause instanceof XrplReadError) {
        if (cause.code === "INVALID_ADDRESS") return error(reply, 400, cause.code, "Enter a valid classic XRP address.");
        return error(reply, cause.code === "UNSUPPORTED_ACCOUNT" ? 422 : 503, cause.code, "Unable to read this XRP account safely. Try again later.");
      }
      request.log.warn({ event: "xrpl_wallet_storage_failure" }, "XRP wallet metadata operation failed");
      return error(reply, 503, "STORAGE_UNAVAILABLE", "Wallet metadata is temporarily unavailable.");
    }
  };
  const common = { onRequest: guard, config: { rateLimit: { max: 20, timeWindow: "1 minute" } } };
  const ownerId = (request: FastifyRequest) => request.user!.userId;

  app.get("/api/v1/xrpl/wallets", common, safe(async (request) => {
    const wallets = await db.select(fields).from(schema.userWallets).where(owned(ownerId(request))).orderBy(schema.userWallets.id);
    return wallets.map(publicWallet);
  }));

  app.post("/api/v1/xrpl/wallets", {
    ...common, bodyLimit: 2048,
    // Fastify normally removes unknown schema fields. Reject them before that
    // happens, so encryptedSecret/seed/private-key fields are never accepted.
    preValidation: async (request, reply) => {
      const body = request.body;
      if (!body || typeof body !== "object" || Array.isArray(body) || Object.keys(body).some((key) => key !== "name" && key !== "address")) {
        return error(reply, 400, "PUBLIC_METADATA_ONLY", "Only a wallet name and public address are accepted.");
      }
    },
    schema: { body: { type: "object", additionalProperties: false, required: ["name", "address"], properties: {
      name: { type: "string", minLength: 1, maxLength: 64 }, address: { type: "string", minLength: 25, maxLength: 35 },
    } } },
  }, safe(async (request, reply) => {
    const body = request.body as { name: string; address: string };
    const name = body.name.trim();
    if (!name) return error(reply, 400, "INVALID_NAME", "Choose a wallet name.");
    const address = classicAddress(body.address);
    const userId = ownerId(request);
    const wallet = await db.transaction(async (tx) => {
      await tx.execute(sql`SELECT id FROM users WHERE id = ${userId} FOR NO KEY UPDATE`);
      const [existing] = await tx.select(fields).from(schema.userWallets).where(and(owned(userId), eq(schema.userWallets.publicKey, address))).limit(1);
      await tx.update(schema.userWallets).set({ isActive: false }).where(owned(userId));
      if (existing) {
        await tx.update(schema.userWallets).set({ isActive: true }).where(and(owned(userId), eq(schema.userWallets.id, existing.id)));
        return { ...existing, isActive: true };
      }
      const [created] = await tx.insert(schema.userWallets).values({ userId, name, publicKey: address,
        chain: "xrpl", network: "testnet", encryptedSecret: null, isActive: true }).returning(fields);
      return created;
    });
    // Registration is public metadata, not a proof of seed ownership or a
    // spending authorization. Local recovery and later signatures prove control.
    return publicWallet(wallet);
  }));

  app.patch("/api/v1/xrpl/wallets/:id/activate", { ...common, schema: { params } }, safe(async (request, reply) => {
    const userId = ownerId(request);
    const id = Number((request.params as { id: string }).id);
    const wallet = await db.transaction(async (tx) => {
      await tx.execute(sql`SELECT id FROM users WHERE id = ${userId} FOR NO KEY UPDATE`);
      const [target] = await tx.select(fields).from(schema.userWallets).where(and(owned(userId), eq(schema.userWallets.id, id))).limit(1);
      if (!target) return undefined;
      await tx.update(schema.userWallets).set({ isActive: false }).where(owned(userId));
      await tx.update(schema.userWallets).set({ isActive: true }).where(and(owned(userId), eq(schema.userWallets.id, id)));
      return { ...target, isActive: true };
    });
    return wallet ? publicWallet(wallet) : error(reply, 404, "WALLET_NOT_FOUND", "Wallet not found.");
  }));

  app.get("/api/v1/xrpl/wallets/:id/account", { ...common, schema: { params } }, safe(async (request, reply) => {
    const id = Number((request.params as { id: string }).id);
    const [wallet] = await db.select(fields).from(schema.userWallets).where(and(owned(ownerId(request)), eq(schema.userWallets.id, id))).limit(1);
    if (!wallet) return error(reply, 404, "WALLET_NOT_FOUND", "Wallet not found.");
    return (options.reader ?? new XrplReadAdapter()).getAccount(wallet.publicKey);
  }));
}
