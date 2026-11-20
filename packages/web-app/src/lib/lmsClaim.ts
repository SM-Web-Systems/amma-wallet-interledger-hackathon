import { StrKey } from "@stellar/stellar-sdk";
import { networkLabel } from "./network-label";

/** The exact first line the SM Web Systems LMS puts on every reward-claim challenge. */
export const LMS_CLAIM_PREFIX = "SM Web Systems LMS reward claim";

/** The LMS issues 5-minute challenges; anything expiring more than a day ahead is refused. Keep identical on the server and in the web app. */
const MAX_CLAIM_AHEAD_MS = 24 * 60 * 60 * 1000;

/** The network an LMS claim names in an optional trailing `network:` line (not sent by the LMS yet). */
export type ClaimNetwork = "mainnet" | "testnet";

export interface LmsClaim {
  claimId: string;
  destination: string;
  amountStroops: bigint;
  expiresAt: Date;
  nonce: string;
  /** Present only when the signed text carries the optional 7th line `network:mainnet|testnet`; today's 6-line text leaves it undefined. */
  network?: ClaimNetwork;
}

/**
 * Parses an LMS reward-claim challenge. The Wallet signs exactly this text, so it is shown to the
 * person field by field and anything unexpected is refused rather than signed.
 */
export function parseLmsClaim(message: string, now = Date.now()): LmsClaim {
  const lines = message.split("\n");
  const fields = ["claim", "destination", "amount_stroops", "expires", "nonce"];
  // Today's challenge has exactly 6 lines. A future LMS may append one `network:` line; nothing else is accepted.
  if ((lines.length !== 6 && lines.length !== 7) || lines[0] !== LMS_CLAIM_PREFIX) throw new Error("This is not an LMS reward claim.");
  const network = lines.length === 7 ? /^network:(mainnet|testnet)$/.exec(lines[6])?.[1] as ClaimNetwork | undefined : undefined;
  if (lines.length === 7 && !network) throw new Error("This LMS claim is malformed.");
  const values = fields.map((name, i) => {
    const line = lines[i + 1];
    if (!line.startsWith(`${name}:`)) throw new Error("This LMS claim is malformed.");
    return line.slice(name.length + 1);
  });
  const [claimId, destination, amount, expires, nonce] = values;
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(claimId)) throw new Error("This LMS claim is malformed.");
  if (!StrKey.isValidEd25519PublicKey(destination)) throw new Error("This LMS claim names an invalid Stellar address.");
  if (!/^[1-9][0-9]{0,15}$/.test(amount)) throw new Error("This LMS claim has an invalid amount.");
  if (!/^[a-f0-9]{64}$/.test(nonce)) throw new Error("This LMS claim is malformed.");
  const expiresAt = new Date(expires);
  if (Number.isNaN(expiresAt.getTime()) || expiresAt.toISOString() !== expires) throw new Error("This LMS claim is malformed.");
  if (expiresAt.getTime() <= now) throw new Error("This claim has expired. Start a new claim in the LMS.");
  if (expiresAt.getTime() > now + MAX_CLAIM_AHEAD_MS) throw new Error("This LMS claim is malformed.");
  return { claimId, destination, amountStroops: BigInt(amount), expiresAt, nonce, ...(network ? { network } : {}) };
}

/**
 * What to show next to the amount: the app's configured Stellar network, and, once the LMS signs a `network:` line,
 * whether it disagrees (then `signedLabel` names what the claim asks for). The label never comes from the claim alone.
 */
export function claimNetworkCheck(configured: "testnet" | "public", signed?: ClaimNetwork): { label: "Mainnet" | "Testnet"; mismatch: boolean; signedLabel?: "Mainnet" | "Testnet" } {
  const label = networkLabel(configured);
  if (!signed) return { label, mismatch: false };
  const signedLabel = signed === "testnet" ? "Testnet" : "Mainnet";
  return signedLabel === label ? { label, mismatch: false } : { label, mismatch: true, signedLabel };
}

/** Formats stroops as XLM with seven decimals, trailing zeros removed. */
export function stroopsToXlm(stroops: bigint): string {
  const whole = stroops / 10_000_000n, frac = (stroops % 10_000_000n).toString().padStart(7, "0").replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : `${whole}`;
}

const DEFAULT_LMS_ORIGINS = ["https://lms.smwebsystems.com"];
/** The LMS mobile app's own claim return address (exact match; the app checks the claim id and keeps nothing secret). */
export const LMS_APP_RETURN = "lmsmobile://reward-claim";

/** Only the configured LMS origins, or the LMS mobile app's return address, may receive a signature. */
export function allowedReturn(url: string, origins: string[] = configuredOrigins()): URL {
  let parsed: URL;
  try { parsed = new URL(url); } catch { throw new Error("The LMS return address is invalid."); }
  if (url === LMS_APP_RETURN) return parsed;
  if (parsed.protocol !== "https:" || parsed.username || parsed.password || !origins.includes(parsed.origin)) {
    throw new Error("This LMS address is not allowed to receive signatures.");
  }
  return parsed;
}

function configuredOrigins(): string[] {
  const raw = (import.meta.env.VITE_LMS_CLAIM_ORIGINS as string | undefined)?.split(",").map((s) => s.trim()).filter(Boolean);
  return raw && raw.length ? raw : DEFAULT_LMS_ORIGINS;
}

/** Signs the exact challenge text with the wallet key for its destination. Returns standard base64. */
export async function signLmsClaim(
  message: string,
  accounts: { publicKey: string; encryptedSecret?: string; backupPending?: boolean }[],
  passphrase: string,
  decrypt: (encrypted: string, passphrase: string) => Promise<string>,
  keypairFromSecret: (secret: string) => { publicKey(): string; sign(data: Uint8Array): Uint8Array },
  /** Self-custody keys live in this device's keystore; the account record may not carry them. */
  loadSecret: (publicKey: string) => Promise<string | null> = async () => null,
): Promise<string> {
  const claim = parseLmsClaim(message);
  const account = accounts.find((a) => a.publicKey === claim.destination);
  if (!account) throw new Error("This claim is for a Stellar wallet that is not on this device.");
  if (account.backupPending) throw new Error("Save this wallet's secret key first, then approve the claim.");
  const encrypted = account.encryptedSecret || (await loadSecret(account.publicKey)) || "";
  if (!encrypted) throw new Error("Restore this Stellar wallet on this device before approving.");
  const keypair = keypairFromSecret(await decrypt(encrypted, passphrase));
  if (keypair.publicKey() !== claim.destination) throw new Error("Wallet key does not match.");
  const signature = keypair.sign(new TextEncoder().encode(message));
  let binary = "";
  for (const byte of signature) binary += String.fromCharCode(byte);
  return btoa(binary);
}
