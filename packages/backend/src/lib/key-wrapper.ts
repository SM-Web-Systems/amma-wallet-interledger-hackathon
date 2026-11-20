import crypto from "crypto";
import { auditLogStrict } from "./audit";
import { mainnetCustodyOn } from "./custody-networks";
import { flagOn } from "./custody-flags";

/**
 * Server-readable escrow for recovery phrases and keys (custody plan, Design 1).
 *
 * Each secret is sealed with its own random data key (AES-256-GCM). The data key is wrapped by a
 * master key held by a MasterKeyProvider. The sealed text is bound (AAD) to the user and the kind of
 * secret, so a row copied to another user or kind cannot be opened. Every successful open is audited
 * first; if the audit row cannot be written the secret is not released. Nothing here logs plaintext.
 */
/** "import:<chain>:<address>" holds one device wallet moved into escrow; the kind is part of the sealed text's AAD. */
export type EscrowKind = "phrase" | "stellar-secret" | `import:${string}`;

export interface MasterKeyProvider {
  readonly id: string;
  wrapKey(dataKey: Buffer): Promise<string>;
  unwrapKey(wrapped: string): Promise<Buffer>;
}

const VERSION = "v1";
const OPEN_ERROR = "This backup cannot be opened.";

/** Master key from a 32-byte base64 value. Testnet and tests only: the key lives in the server's secrets. */
export class LocalMasterKeyProvider implements MasterKeyProvider {
  readonly id = "local";
  private readonly key: Buffer;

  constructor(masterKeyBase64: string) {
    const key = Buffer.from(masterKeyBase64, "base64");
    if (key.length !== 32) throw new Error("The master key must be 32 bytes (base64).");
    this.key = key;
  }

  async wrapKey(dataKey: Buffer): Promise<string> {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv("aes-256-gcm", this.key, iv);
    const body = Buffer.concat([cipher.update(dataKey), cipher.final()]);
    return Buffer.concat([iv, body, cipher.getAuthTag()]).toString("base64");
  }

  async unwrapKey(wrapped: string): Promise<Buffer> {
    const raw = Buffer.from(wrapped, "base64");
    if (raw.length < 12 + 16 + 1) throw new Error(OPEN_ERROR);
    const decipher = crypto.createDecipheriv("aes-256-gcm", this.key, raw.subarray(0, 12));
    decipher.setAuthTag(raw.subarray(raw.length - 16));
    return Buffer.concat([decipher.update(raw.subarray(12, raw.length - 16)), decipher.final()]);
  }
}

function aad(ctx: { userId: number; kind: EscrowKind }): string {
  return `amma-escrow:${VERSION}:${ctx.userId}:${ctx.kind}`;
}

/**
 * The sealing behind escrow, bound to any context string (AAD). Text sealed for one context cannot be opened for another.
 * Returns "v1.<provider>.<wrapped data key>.<iv>.<ciphertext+tag>" (all base64 parts).
 */
export async function sealBound(provider: MasterKeyProvider, plaintext: string, context: string): Promise<string> {
  const dataKey = crypto.randomBytes(32);
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", dataKey, iv);
  cipher.setAAD(Buffer.from(context, "utf8"));
  const body = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final(), cipher.getAuthTag()]);
  const wrapped = await provider.wrapKey(dataKey);
  dataKey.fill(0);
  return [VERSION, provider.id, wrapped, iv.toString("base64"), body.toString("base64")].join(".");
}

/**
 * Opens text from sealBound. It does not audit: a caller must write its audit row before it uses or returns the plaintext.
 * Every failure gives the same message, which never contains the sealed text or the context.
 */
export async function unsealBound(provider: MasterKeyProvider, sealed: string, context: string): Promise<string> {
  const parts = sealed.split(".");
  if (parts.length !== 5 || parts[0] !== VERSION || parts[1] !== provider.id) throw new Error(OPEN_ERROR);
  const iv = Buffer.from(parts[3], "base64");
  const body = Buffer.from(parts[4], "base64");
  if (iv.length !== 12 || body.length < 17) throw new Error(OPEN_ERROR);
  try {
    const dataKey = await provider.unwrapKey(parts[2]);
    const decipher = crypto.createDecipheriv("aes-256-gcm", dataKey, iv);
    decipher.setAAD(Buffer.from(context, "utf8"));
    decipher.setAuthTag(body.subarray(body.length - 16));
    const plaintext = Buffer.concat([decipher.update(body.subarray(0, body.length - 16)), decipher.final()]).toString("utf8");
    dataKey.fill(0);
    return plaintext;
  } catch {
    throw new Error(OPEN_ERROR);
  }
}

/** Returns "v1.<provider>.<wrapped data key>.<iv>.<ciphertext+tag>" (all base64 parts). */
export async function sealForEscrow(
  provider: MasterKeyProvider,
  plaintext: string,
  ctx: { userId: number; kind: EscrowKind },
): Promise<string> {
  return sealBound(provider, plaintext, aad(ctx));
}

export async function openFromEscrow(
  provider: MasterKeyProvider,
  sealed: string,
  ctx: { userId: number; kind: EscrowKind; reason: string; ip?: string; userAgent?: string },
): Promise<string> {
  const plaintext = await unsealBound(provider, sealed, aad(ctx));

  // Audit before release; a failed write stops the release.
  try {
    await auditLogStrict("wallet_key_escrow_open", {
      userId: ctx.userId,
      detail: { kind: ctx.kind, reason: ctx.reason, provider: provider.id },
      ip: ctx.ip,
      userAgent: ctx.userAgent,
    });
  } catch {
    throw new Error("The access could not be audited, so the backup was not released.");
  }
  return plaintext;
}

type Env = Record<string, string | undefined>;

/** Reads the provider from settings. Null (feature off) when KEY_WRAP_PROVIDER is not set. */
export function masterKeyProviderFromEnv(env: Env = process.env): MasterKeyProvider | null {
  const name = env.KEY_WRAP_PROVIDER;
  if (!name) return null;
  if (name === "local") {
    if ((env.STELLAR_NETWORK ?? "testnet") !== "testnet" && !mainnetCustodyOn(env)) throw new Error("The local master key provider is for testnet only and is refused on mainnet or any other network.");
    // Mainnet custody mode is the one case a local key is allowed on mainnet, and only together with server signing (the flag set the rest of the code expects).
    if (mainnetCustodyOn(env) && !flagOn(env.CUSTODY_SERVER_SIGNING)) throw new Error("The local master key provider is refused on mainnet unless CUSTODY_SERVER_SIGNING is on as well.");
    if (!env.KEY_WRAP_MASTER_KEY) throw new Error("KEY_WRAP_MASTER_KEY is required for the local provider.");
    return new LocalMasterKeyProvider(env.KEY_WRAP_MASTER_KEY);
  }
  if (name === "aws-kms") throw new Error("The aws-kms provider is not enabled yet.");
  throw new Error(`Unknown KEY_WRAP_PROVIDER "${name}".`);
}
