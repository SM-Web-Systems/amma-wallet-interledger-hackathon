import { createHash, createPublicKey, sign, verify, type KeyObject } from "node:crypto";

/**
 * Partner request signature. The partner signs with an Ed25519 private key it alone holds; Amma stores only the public key.
 * Canonical string: "amma-partner-v1\n" + METHOD + "\n" + path + "\n" + timestamp + "\n" + hex(sha256(rawBody))
 * Header: X-Amma-Signature: ed25519=<base64 of the 64-byte signature>
 */
export const SIGNATURE_PREFIX = "amma-partner-v1";
export const TIMESTAMP_WINDOW_SECONDS = 300;

export const canonicalString = (p: { method: string; path: string; timestamp: string; rawBody: Buffer | string }): string =>
  [SIGNATURE_PREFIX, p.method.toUpperCase(), p.path, p.timestamp, createHash("sha256").update(p.rawBody).digest("hex")].join("\n");

// A raw 32-byte Ed25519 public key becomes an SPKI document by prefixing this fixed header.
const SPKI_ED25519 = Buffer.from("302a300506032b6570032100", "hex");
const publicKeyOf = (rawBase64: string): KeyObject | null => {
  const raw = Buffer.from(rawBase64, "base64");
  if (raw.length !== 32) return null;
  try { return createPublicKey({ key: Buffer.concat([SPKI_ED25519, raw]), format: "der", type: "spki" }); } catch { return null; }
};

const HEADER = /^ed25519=([A-Za-z0-9+/]{86}==)$/;

/** True only for a well-formed header carrying a valid signature of `canonical` under the stored public key. */
export function verifyPartnerSignature(publicKeyBase64: string, header: string, canonical: string): boolean {
  const match = HEADER.exec(header);
  const key = publicKeyOf(publicKeyBase64);
  if (!match || !key) return false;
  try { return verify(null, Buffer.from(canonical), key, Buffer.from(match[1], "base64")); } catch { return false; }
}

/** Reference signer, used by tests and by the partner-side example in the contract. */
export const signPartnerRequest = (privateKey: KeyObject, canonical: string): string => `ed25519=${sign(null, Buffer.from(canonical), privateKey).toString("base64")}`;
