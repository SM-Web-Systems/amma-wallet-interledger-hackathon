import { getAddress, isAddress } from "viem";
import { fail } from "./errors";

/**
 * Accepts a 0x-prefixed 20-byte address. Mixed-case input must carry a valid
 * EIP-55 checksum (a typo in a checksummed address is rejected); all-lower or
 * all-upper input carries no checksum and is accepted. Returns the checksummed form.
 */
export function normalizeAddress(input: string): `0x${string}` {
  if (typeof input !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(input)) return fail("EVM_ADDRESS_INVALID");
  const body = input.slice(2);
  const mixed = body !== body.toLowerCase() && body !== body.toUpperCase();
  if (mixed && !isAddress(input, { strict: true })) return fail("EVM_ADDRESS_CHECKSUM");
  const address = getAddress(input.toLowerCase());
  if (address === "0x0000000000000000000000000000000000000000") return fail("EVM_ADDRESS_ZERO");
  return address;
}
