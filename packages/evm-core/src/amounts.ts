import { ensure } from "./errors";

/**
 * Exact decimal <-> base-unit conversion. No floating point, no exponents,
 * no implicit rounding: more fractional digits than the asset has is an error.
 */
const DECIMAL = /^(0|[1-9][0-9]*)(\.[0-9]+)?$/;
const MAX_UINT256 = (1n << 256n) - 1n;

export function parseUnits(input: string, decimals: number): bigint {
  ensure(Number.isInteger(decimals) && decimals >= 0 && decimals <= 36, "EVM_DECIMALS_INVALID");
  ensure(typeof input === "string" && input.length <= 100 && DECIMAL.test(input), "EVM_AMOUNT_INVALID");
  const [whole, fraction = ""] = input.split(".") as [string, string?];
  const digits = fraction;
  ensure(digits.length <= decimals, "EVM_AMOUNT_TOO_PRECISE");
  const value = BigInt(whole) * 10n ** BigInt(decimals) + BigInt((digits || "0").padEnd(decimals, "0") || "0");
  ensure(value <= MAX_UINT256, "EVM_AMOUNT_TOO_LARGE");
  return value;
}

export function parsePositiveUnits(input: string, decimals: number): bigint {
  const value = parseUnits(input, decimals);
  ensure(value > 0n, "EVM_AMOUNT_NOT_POSITIVE");
  return value;
}

/** Formats base units without trailing zeros: 1500000000000000000n, 18 -> "1.5". */
export function formatUnits(value: bigint, decimals: number): string {
  ensure(value >= 0n, "EVM_AMOUNT_NEGATIVE");
  const scale = 10n ** BigInt(decimals);
  const whole = value / scale;
  const fraction = (value % scale).toString().padStart(decimals, "0").replace(/0+$/, "");
  return fraction ? `${whole}.${fraction}` : whole.toString();
}
