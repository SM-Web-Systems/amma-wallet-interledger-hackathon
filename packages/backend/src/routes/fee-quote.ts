import type { FastifyInstance } from "fastify";
import * as StellarSdk from "@stellar/stellar-sdk";
import { eq } from "drizzle-orm";
import { db, schema } from "../db";
import { config } from "../config";
import { authMiddleware } from "../middleware/auth";
import { appLog } from "../lib/app-log";
import { FOREIGN_SOURCE_ERROR, foreignSourceOp } from "../lib/custody-limits";
import { platformFeeStep, userPays } from "../lib/platform-fee";
import { findActiveStellarWallet } from "../services/stellar-wallet.service";

/**
 * Read-only fee quote for the delegated Send review step (PR #261). It runs the same fee step as sign-and-submit
 * (platformFeeStep, same per-envelope decision cache) on the client's unsigned XDR. Nothing is signed, submitted or written;
 * no PIN or password. Only for users in delegated signing mode (the only ones sign-and-submit serves).
 * innerHash is the transaction sign-and-submit will submit for the same XDR when the client sends it back as expectedHash.
 */
export async function feeQuoteRoutes(app: FastifyInstance): Promise<void> {
  app.post(
    "/api/v1/transactions/fee-quote",
    {
      preHandler: authMiddleware,
      config: { rateLimit: { max: 30, timeWindow: "15 minutes" } },
      schema: {
        tags: ["Signing"],
        summary: "Amma fee for a delegated send, before approval (read only)",
        security: [{ bearerAuth: [] }],
        body: { type: "object", properties: { xdr: { type: "string", maxLength: 20000 } }, required: ["xdr"] },
        response: {
          200: {
            type: "object",
            properties: {
              innerHash: { type: "string" },
              fee: {
                type: "object",
                nullable: true,
                properties: {
                  feePercent: { type: "number" },
                  minFeeXlm: { type: "number" },
                  feeOperations: { type: "array", items: { type: "object", additionalProperties: true } },
                  xlmFallback: { type: "array", items: { type: "string" } },
                },
              },
              pays: { type: "array", items: { type: "object", additionalProperties: true } },
              networkFeePaidByAmma: { type: "boolean" },
            },
          },
          400: { type: "object", properties: { error: { type: "string" } } },
          403: { type: "object", properties: { error: { type: "string" } } },
          500: { type: "object", properties: { error: { type: "string" } } },
        },
      },
    },
    async (request, reply) => {
      const userId = request.user!.userId;
      const { xdr } = request.body as { xdr: string };
      try {
        const [user] = await db.select({ signingMode: schema.users.signingMode }).from(schema.users).where(eq(schema.users.id, userId)).limit(1);
        if (!user || user.signingMode !== "delegated") return reply.status(403).send({ error: "Delegated signing is not enabled." });
        const wallet = await findActiveStellarWallet(userId);
        if (!wallet) return reply.status(400).send({ error: "No active wallet found" });
        const { stellarClient } = await import("../lib/stellar-client");
        const passphrase = stellarClient.networkPassphrase;
        let tx: StellarSdk.Transaction | StellarSdk.FeeBumpTransaction;
        try {
          tx = StellarSdk.TransactionBuilder.fromXDR(xdr, passphrase);
        } catch {
          return reply.status(400).send({ error: "That transaction could not be read." });
        }
        const inner = tx instanceof StellarSdk.FeeBumpTransaction ? tx.innerTransaction : tx;
        if (inner.source !== wallet.publicKey) return reply.status(403).send({ error: "Transaction source does not match your active wallet" });
        if (foreignSourceOp(inner.operations, wallet.publicKey)) return reply.status(403).send({ error: FOREIGN_SOURCE_ERROR });
        const { finalTx, feeDetails } = await platformFeeStep(tx, {
          feePercent: config.PLATFORM_FEE_PERCENT || 0,
          minFeeXlm: config.PLATFORM_FEE_MIN_XLM,
          platformWallet: config.PLATFORM_WALLET,
          platformSecret: config.PLATFORM_SECRET,
          source: wallet.publicKey,
          passphrase,
          horizon: stellarClient.horizon,
          warn: (ctx, msg) => appLog().warn({ userId, quote: true, ...ctx }, msg),
        });
        const finalInner = finalTx instanceof StellarSdk.FeeBumpTransaction ? finalTx.innerTransaction : finalTx;
        return {
          innerHash: finalTx.hash().toString("hex"),
          fee: feeDetails,
          pays: userPays(finalInner.operations),
          networkFeePaidByAmma: !!config.PLATFORM_SECRET,
        };
      } catch (error: any) {
        appLog().error({ userId, errorName: error?.name }, "fee-quote failed");
        return reply.status(500).send({ error: "Could not work out the Amma fee. Try again." });
      }
    },
  );
}
