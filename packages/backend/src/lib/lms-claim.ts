import { StrKey } from "@stellar/stellar-sdk";

/** The exact first line the SM Web Systems LMS puts on every reward-claim challenge. Keep identical to the web app's lib/lmsClaim.ts. */
export const LMS_CLAIM_PREFIX = "SM Web Systems LMS reward claim";

/** The LMS issues 5-minute challenges; anything expiring more than a day ahead is refused. Keep identical on the server and in the web app. */
const MAX_CLAIM_AHEAD_MS = 24 * 60 * 60 * 1000;

/** Thrown only when the claim is otherwise well formed but its expiry has passed, so callers can say so. */
export class LmsClaimExpired extends Error {
  constructor() { super("This claim has expired. Start a new claim in the LMS."); this.name = "LmsClaimExpired"; }
}

export interface LmsClaim {
  claimId: string;
  destination: string;
  amountStroops: bigint;
  expiresAt: Date;
  nonce: string;
  /** Only when the text carries the optional 7th line `network:mainnet|testnet`; today's 6-line text leaves it undefined. Same rule as the web app. */
  network?: "mainnet" | "testnet";
}

/**
 * Port of the web app's parseLmsClaim. The server signs only text this accepts, so it can never be used to sign an arbitrary message.
 */
export function parseLmsClaim(message: string, now = Date.now()): LmsClaim {
  const lines = message.split("\n");
  const fields = ["claim", "destination", "amount_stroops", "expires", "nonce"];
  if ((lines.length !== 6 && lines.length !== 7) || lines[0] !== LMS_CLAIM_PREFIX) throw new Error("This is not an LMS reward claim.");
  const network = lines.length === 7 ? (/^network:(mainnet|testnet)$/.exec(lines[6])?.[1] as "mainnet" | "testnet" | undefined) : undefined;
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
  if (expiresAt.getTime() <= now) throw new LmsClaimExpired();
  if (expiresAt.getTime() > now + MAX_CLAIM_AHEAD_MS) throw new Error("This LMS claim is malformed.");
  return { claimId, destination, amountStroops: BigInt(amount), expiresAt, nonce, ...(network ? { network } : {}) };
}
