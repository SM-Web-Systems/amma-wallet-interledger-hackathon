import { isValidClassicAddress } from "xrpl";

export type XrplErrorCode = "XRPL_DISABLED" | "INVALID_ADDRESS" | "INVALID_TAG" | "INVALID_HASH" | "XRPL_UNAVAILABLE" | "INVALID_LEDGER_RESPONSE" | "WRONG_NETWORK" | "STALE_LEDGER" | "UNSUPPORTED_ACCOUNT" | "HISTORY_UNAVAILABLE" | "LEDGER_RESET";

export class XrplReadError extends Error {
  constructor(public readonly code: XrplErrorCode, public readonly retryable = false) {
    super(code); this.name = "XrplReadError";
  }
}

export function classicAddress(value: unknown): string {
  if (typeof value !== "string" || value.length > 35 || !isValidClassicAddress(value)) throw new XrplReadError("INVALID_ADDRESS");
  return value;
}

export function destinationTag(value: unknown): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0 || value > 0xffffffff) throw new XrplReadError("INVALID_TAG");
  return value;
}

export function transactionHash(value: unknown): string {
  if (typeof value !== "string" || !/^[A-Fa-f0-9]{64}$/.test(value)) throw new XrplReadError("INVALID_HASH");
  return value.toUpperCase();
}

export function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new XrplReadError("INVALID_LEDGER_RESPONSE", true);
  return value as Record<string, unknown>;
}

export function uint(value: unknown, positive = false): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < (positive ? 1 : 0) || value > 0xffffffff) throw new XrplReadError("INVALID_LEDGER_RESPONSE", true);
  return value;
}

/** Native XRP monetary fields never pass through floating-point arithmetic. */
export function drops(value: unknown, positive = false): bigint {
  if (typeof value !== "string" || !/^(0|[1-9]\d{0,17})$/.test(value)) throw new XrplReadError("INVALID_LEDGER_RESPONSE", true);
  const result = BigInt(value);
  if (result > 100_000_000_000_000_000n || (positive && result === 0n)) throw new XrplReadError("INVALID_LEDGER_RESPONSE", true);
  return result;
}
