import { appLog } from "./app-log";
import { mapStellarSubmitError, stellarResultCodes, isSubmitUncertain, isNeverSent, type SubmitContext } from "./stellar-submit-errors";

/**
 * If `error` is a Horizon rejection or an unknown outcome, logs only the result codes, sends the plain
 * message and returns the reply. Otherwise returns null and the caller sends its own error.
 */
export function replyToStellarSubmitError(
  reply: { status(code: number): { send(body: unknown): unknown } },
  error: unknown,
  userId?: number | string,
  ctx: SubmitContext = {},
): unknown | null {
  const mapped = mapStellarSubmitError(error, ctx);
  if (!mapped) return null;
  const resultCodes = stellarResultCodes(error) ?? { transaction: mapped.code };
  if (mapped.platform) appLog().error({ resultCodes, userId }, "platform fee account could not pay the network fee");
  else if (isSubmitUncertain(error)) appLog().warn({ userId }, "stellar submit outcome unknown");
  else if (isNeverSent(error)) appLog().warn({ userId, code: mapped.code }, "stellar submit not sent");
  else appLog().warn({ resultCodes, userId }, "stellar submit rejected");
  return reply.status(mapped.status).send({ error: mapped.error, code: mapped.code });
}

/**
 * True only when the transaction certainly did not apply: Horizon answered with result codes (after the ledger was
 * checked, if an earlier attempt was unknown), or it was never sent. A timeout or unknown outcome is never definite.
 */
export function isDefiniteStellarRejection(error: unknown): boolean {
  if (isSubmitUncertain(error)) return false;
  return stellarResultCodes(error) !== null || isNeverSent(error);
}

export const UNKNOWN_OUTCOME_MESSAGE = "The Stellar network didn't confirm in time. We're checking whether the payment went through; don't send it again yet.";

/**
 * For an unknown outcome only: answers 202 with the hash of the envelope that was submitted and of the inner
 * transaction, so the caller can look it up on Horizon instead of paying again. Returns null for anything else.
 */
export function replyToUnknownOutcome(
  reply: { status(code: number): { send(body: unknown): unknown } },
  error: unknown,
  submitted: { hash(): Buffer },
  inner: { hash(): Buffer },
  userId?: number | string,
): unknown | null {
  if (!isSubmitUncertain(error)) return null;
  const hash = submitted.hash().toString("hex");
  appLog().warn({ userId, hash }, "stellar submit outcome unknown");
  return reply.status(202).send({ status: "unknown", hash, innerHash: inner.hash().toString("hex"), error: UNKNOWN_OUTCOME_MESSAGE });
}
