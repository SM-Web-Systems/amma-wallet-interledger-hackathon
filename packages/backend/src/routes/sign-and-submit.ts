import type { FastifyReply, FastifyRequest } from "fastify";
import * as StellarSdk from "@stellar/stellar-sdk";
import { eq } from "drizzle-orm";
import { db, schema } from "../db";
import { config } from "../config";
import { appLog } from "../lib/app-log";
import { auditLog } from "../lib/audit";
import { checkCustodyPassword, releaseCustodyDay, signWithCustody } from "../lib/custody-sign";
import { FOREIGN_SOURCE_ERROR, foreignSourceOp } from "../lib/custody-limits";
import type { CustodyFlags } from "../lib/custody-flags";
import type { MasterKeyProvider } from "../lib/key-wrapper";
import { decryptSecret } from "../lib/decrypt-secret";
import { WRONG_PIN_MESSAGE } from "../lib/signing-errors";
import { isLegacyPin, pinRetired } from "../lib/pin-retired";
import { feeBumpFor, feeForSubmit, feePaymentFailure } from "../lib/platform-fee";
import { submitStellarTx } from "../lib/stellar-submit";
import { isDefiniteStellarRejection, replyToStellarSubmitError, replyToUnknownOutcome } from "../lib/stellar-submit-reply";
import { findActiveStellarWallet } from "../services/stellar-wallet.service";

/**
 * POST /api/v1/transactions/sign-and-submit (delegated mode): the handler, moved out of server.ts so it can be tested with
 * app.inject. The route itself (auth, rate limit, schema) is still declared in server.ts.
 */
export function signAndSubmitHandler({ provider: custodyProvider, flags: custodyFlags }: { provider: MasterKeyProvider | null; flags: CustodyFlags }) {
  return async (request: FastifyRequest, reply: FastifyReply) => {
  const userId = request.user!.userId;
  const {
    xdr,
    pin,
    password,
    expectedHash,
  } = request.body as {
    xdr: string;
    pin?: string;
    password?: string;
    expectedHash?: string;
  };
  // Known once the fee step has run: the inner transaction that is (or would be) submitted.
  let innerHash: string | undefined;
  // Password step-up: only when no pin is sent. A PIN always takes the existing path.
  const custodyPath = !pin && typeof password === "string" && password.length > 0 && password.length <= 256 && custodyFlags.serverSigning;

  if (!xdr) {
    return reply.status(400).send({ error: "xdr is required" });
  }

  try {
    const [user] = await db
      .select({ signingMode: schema.users.signingMode })
      .from(schema.users)
      .where(eq(schema.users.id, userId))
      .limit(1);

    if (!user || user.signingMode !== "delegated") {
      return reply
        .status(403)
        .send({ error: "Delegated signing is not enabled." });
    }

    const wallet = await findActiveStellarWallet(userId);

    if (!wallet || (!wallet.encryptedSecret && !custodyPath)) {
      return reply
        .status(400)
        .send({ error: "No secret key stored on server" });
    }

    const { stellarClient } = await import("../lib/stellar-client");
    const passphrase = stellarClient.networkPassphrase;

    const tx = StellarSdk.TransactionBuilder.fromXDR(xdr, passphrase);

    const txSource =
      tx instanceof StellarSdk.FeeBumpTransaction
        ? tx.innerTransaction.source
        : tx.source;
    if (txSource !== wallet.publicKey) {
      return reply.status(403).send({
        error: "Transaction source does not match your active wallet",
      });
    }

    // An operation with another account as its source would be authorised by whichever key co-signs (the platform key, in sign-and-submit).
    if (foreignSourceOp((tx instanceof StellarSdk.FeeBumpTransaction ? tx.innerTransaction : tx).operations, wallet.publicKey)) {
      return reply.status(403).send({ error: FOREIGN_SOURCE_ERROR });
    }

    if (custodyPath) {
      // Wrong passwords stop here, before any Horizon call. The signing itself happens below, after the fee step.
      const refused = await checkCustodyPassword({ provider: custodyProvider, flags: custodyFlags, userId, password: password!, walletAddress: wallet.publicKey, tx, ip: request.ip, userAgent: request.headers["user-agent"] });
      if (refused) return reply.status(refused.status).send({ error: refused.error });
    }

    // PIN path: the cheap checks (PIN present, PIN unlocks the key) run before the fee step reads Horizon.
    let pinKeypair: StellarSdk.Keypair | null = null;
    if (!custodyPath) {
      if (!pin) {
        return reply.status(400).send({ error: "pin is required for delegated signing" });
      }

      // Sign with user's key — PIN required, no raw fallback
      let secretKey: string;
      try {
        secretKey = await decryptSecret(wallet.encryptedSecret!, pin);
      } catch (decryptErr: any) {
        appLog().warn({ userId, errorName: decryptErr?.name }, "sign-and-submit unlock failed");
        return reply.status(403).send({
          error: WRONG_PIN_MESSAGE,
        });
      }
      // A correct legacy PIN no longer signs: the wallet must move into custody first (lib/pin-retired.ts).
      if (isLegacyPin(pin)) return reply.status(403).send(pinRetired(custodyFlags, userId));
      pinKeypair = StellarSdk.Keypair.fromSecret(secretKey);
    }

    // ── Platform Fee Injection ──
    const feePercent = config.PLATFORM_FEE_PERCENT || 0;
    const platformWallet = config.PLATFORM_WALLET;
    const platformSecret = config.PLATFORM_SECRET;
    // Every send pays (direct sends on top, swaps within the approved amount); client's sequence/memo/time bounds kept: see lib/platform-fee.ts.
    // The same step as POST /api/v1/transactions/fee-quote, so the quoted fee is the one charged. Charged ONLY when the client
    // sent the quote's innerHash (expectedHash); an old client without it gets its own transaction, unchanged (see feeForSubmit).
    const charged = await feeForSubmit(tx, expectedHash, {
      feePercent,
      minFeeXlm: config.PLATFORM_FEE_MIN_XLM,
      platformWallet,
      platformSecret,
      source: wallet.publicKey,
      passphrase,
      horizon: stellarClient.horizon,
      warn: (ctx, msg) => appLog().warn({ userId, ...ctx }, msg),
    });
    // The client showed a quote for exactly this transaction: never sign or submit a different one (the fee changed, or the
    // quote's cached decision is gone). Nothing is signed or reserved yet, so the client can quote again and retry.
    if (charged.refused) return reply.status(charged.refused.status).send({ error: charged.refused.error, code: charged.refused.code });
    const { finalTx, feeDetails } = charged;
    innerHash = charged.innerHash;

    if (custodyPath) {
      const refused = await signWithCustody({ provider: custodyProvider, flags: custodyFlags, userId, walletAddress: wallet.publicKey, tx: finalTx, ip: request.ip, userAgent: request.headers["user-agent"] });
      if (refused) return reply.status(refused.status).send({ error: refused.error });
    } else {
      finalTx.sign(pinKeypair!);
    }

    // The fee payments come from the user's own account, so the user's signature covers them.
    // The platform key must not sign the inner transaction: an unused signature makes Stellar reject it (tx_bad_auth_extra).

    // Wrap in FeeBumpTransaction — platform pays the Stellar network fee
    let txToSubmit: any = finalTx;
    if (platformSecret) {
      try {
        txToSubmit = feeBumpFor(finalTx, platformSecret, passphrase);
      } catch (fbErr: any) {
        appLog().warn({ userId, errorName: fbErr?.name }, "fee bump failed, submitting as-is");
        // Fall back to user-paid fee if fee bump fails
      }
    }

    // Only this call is mapped to a Horizon message; other failures above stay generic.
    let result;
    try {
      result = await submitStellarTx(stellarClient.horizon, txToSubmit);
    } catch (submitErr) {
      // A result code means the transaction did not apply: give the daily-cap reservation back.
      // A timeout or unknown outcome keeps it (the payment may still land).
      if (custodyPath && isDefiniteStellarRejection(submitErr)) {
        await releaseCustodyDay({ flags: custodyFlags, userId, tx: finalTx, ip: request.ip, userAgent: request.headers["user-agent"] });
      }
      // Unknown outcome: the payment may still land. Give the caller the hashes to look it up; never invite a blind retry.
      const unknown = replyToUnknownOutcome(reply, submitErr, txToSubmit, finalTx, userId);
      if (unknown) return unknown;
      // The Amma fee payment itself failed on the ledger (e.g. op_no_trust: the platform trustline went away after it was
      // cached). The envelope used its sequence number, so it can't be resent without the fee; the cached answer is dropped,
      // and the op_ code tells the client to build a new envelope (its new quote then pays in XLM if needed).
      const feeFail = feeDetails && isDefiniteStellarRejection(submitErr) ? feePaymentFailure(finalTx, (tx instanceof StellarSdk.FeeBumpTransaction ? tx.innerTransaction : tx).operations.length, submitErr) : null;
      // Too little for the amount plus the fee (op_underfunded on the fee payment): say so plainly, no retry hint.
      if (feeFail?.kind === "funds") {
        appLog().warn({ userId, reason: "funds", asset: feeFail.asset }, "platform_fee_payment_failed");
        const reserve = feeFail.asset === "XLM" ? " Your account must keep its minimum XLM reserve." : "";
        return reply.status(400).send({ error: `Not enough ${feeFail.asset} for the amount plus the Amma fee.${reserve}`, code: feeFail.code });
      }
      if (feeFail) {
        appLog().warn({ userId, asset: feeFail.asset, code: feeFail.code }, "platform_fee_payment_failed");
        return reply.status(400).send({ error: `Amma couldn't take its fee in ${feeFail.asset}, so nothing was sent. Try again: the fee will be worked out again.`, code: feeFail.code });
      }
      const sent = replyToStellarSubmitError(reply, submitErr, userId, { feeBumped: txToSubmit !== finalTx, operations: finalTx.operations });
      if (sent) return sent;
      throw submitErr;
    }

    await auditLog("transaction_sign", {
      userId: request.user?.userId,
      ip: request.ip,
      userAgent: request.headers["user-agent"],
    });

    return {
      success: true,
      result,
      hash: txToSubmit.hash().toString("hex"),
      innerHash: finalTx.hash().toString("hex"),
      fee: feeDetails,
      feeBumped: txToSubmit !== finalTx,
    };
  } catch (error: any) {
    // Log the class only, never the message or stack (may carry secrets).
    appLog().error({ userId, errorName: error?.name }, "sign-and-submit failed");
    // Once the fee step ran, the caller gets the inner hash so it can look the payment up (it may have been submitted).
    return reply.status(500).send({
      error: "Failed to sign and submit",
      ...(innerHash ? { innerHash } : {}),
    });
  }
  };
}
