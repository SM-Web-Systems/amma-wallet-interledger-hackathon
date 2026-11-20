import { FastifyInstance } from "fastify";
import { eq, sql } from "drizzle-orm";
import { db, schema } from "../db";
import { authMiddleware } from "../middleware/auth";
import { appLog } from "../lib/app-log";
import { CUSTODY_NOT_AVAILABLE, custodyAllowedForUser, custodyFlagsFromEnv, type CustodyFlags } from "../lib/custody-flags";
import { deriveAllChains, generatePhrase } from "../lib/one-phrase";
import { masterKeyProviderFromEnv, openFromEscrow, sealForEscrow, type MasterKeyProvider } from "../lib/key-wrapper";
import { checkCustodyPasswordOnly } from "../lib/custody-sign";
import { cleanSecret, importKind, keyFromImported, proveCanSign, sameAddress, validAddress } from "../lib/custody-import";
import { CustodyRefused, withDelegatedKey, type CustodyChain } from "../lib/custody-signer";
import { getAddress } from "viem";
import type { FastifyRequest } from "fastify";
import { verifyAccessToken } from "../lib/auth";
import { recoveryFreezeActive } from "../lib/key-recovery";
import { networkOf, networksFor, xrplCustodyAllowed, type CustodyNetworks } from "../lib/custody-networks";
const XRP_TESTNET_ONLY = "XRP wallets are only available on the test network for now.";

/** Rate-limit key for the import route: the verified user, so rotating addresses or headers cannot widen the limit. */
export const importRateKey = (request: FastifyRequest): string => {
  try {
    const authorization = request.headers.authorization;
    if (authorization?.startsWith("Bearer ")) {
      const user = verifyAccessToken(authorization.slice(7));
      if (user.type === "user" && Number.isSafeInteger(user.userId) && user.userId > 0) return `custody-import:user:${user.userId}`;
    }
  } catch { /* fall back to the address */ }
  return request.ip;
};
const IMPORT_CAP = 10;

/**
 * Zero-setup custody (stage 0; testnet, or mainnet in MAINNET_CUSTODY mode): one sealed phrase per user, Stellar + XRP + Ethereum (Sepolia or mainnet) accounts from it.
 * - Onboard: creates the sealed phrase and the three wallet rows once; the phrase is never returned, logged or audited.
 * - Activity: the user's own key-use events, with only whitelisted detail fields.
 * - Welcome funding: the user's own funding rows.
 */
export interface CustodyOptions {
  provider?: MasterKeyProvider | null;
  flags?: CustodyFlags;
  /** Welcome-funding runner (Task 5). Called once after a successful first onboarding when the flag is on. */
  queueFunding?: (userId: number, wallets: { stellar: string; xrpl: string; evm: string }) => Promise<void>;
  /** Status-call retry: only processes rows that already exist. */
  retryFunding?: (userId: number) => Promise<void>;
}

const KIND = "phrase" as const;
const ACTIONS = [
  "wallet_key_escrow_open", "wallet_key_escrow_save", "wallet_custody_sign", "wallet_custody_sign_denied",
  "custody_onboard", "custody_wallet_added", "custody_wallet_imported", "custody_wallet_updated", "key_recovery_requested", "key_recovery_completed", "key_recovery_cancelled", "key_recovery_denied",
];
/** The three onboarding slots, on the networks custody currently runs on. */
const slotsFor = (n: CustodyNetworks, xrplOn: boolean) => [
  { key: "stellar", chain: "stellar", network: n.stellar, name: "Amma Stellar" },
  { key: "xrpl", chain: "xrpl", network: n.xrpl, name: "Amma XRP" },
  { key: "evm", chain: "evm", network: n.evm, name: "Amma Ethereum" },
].filter((s) => xrplOn || s.chain !== "xrpl") as readonly { key: "stellar" | "xrpl" | "evm"; chain: string; network: string; name: string }[]; // No XRP slot on mainnet unless XRPL_MAINNET_CUSTODY=on

/** Chains a user can add wallets on (the one network each lives on comes from custodyNetworks). */
type MultiChain = "xrpl" | "evm";
const MAX_INDEX = 9;
const NAME_MAX = 40;
const FULL = "You can have up to 10 wallets on this network.";

type WalletRow = { chain: string; network: string; public_key: string; name: string; derivation_index: number | null; is_active: boolean | null };
/** A wallet moved in from a device has no derivation index. */
const walletOut = (r: WalletRow) => r.derivation_index === null || r.derivation_index === undefined
  ? { chain: r.chain, network: r.network, address: r.public_key, name: r.name, index: null, active: r.is_active === true, imported: true }
  : { chain: r.chain, network: r.network, address: r.public_key, name: r.name, index: Number(r.derivation_index), active: r.is_active === true };
/** A trimmed name of 1..40 characters, or null when it is not acceptable. */
const cleanName = (v: unknown): string | null => {
  if (typeof v !== "string") return null;
  const t = v.trim();
  if (/[\p{Cc}\u202A-\u202E\u2066-\u2069]/u.test(t)) return null;
  return t.length >= 1 && t.length <= NAME_MAX ? t : null;
};

const NOT_ON = "Amma wallet setup is not switched on here yet.";
const rowsOf = <T,>(result: any): T[] => (result?.rows ?? result) as T[];

async function selfCustody(userId: number): Promise<boolean> {
  const [user] = await db.select({ signingMode: schema.users.signingMode }).from(schema.users).where(eq(schema.users.id, userId)).limit(1);
  return user?.signingMode === "self";
}

/** The user's active wallet per chain, from user_wallets. */
async function activeWallets(userId: number, WALLET_SLOTS: ReturnType<typeof slotsFor>): Promise<Record<string, string | null>> {
  const rows = rowsOf<{ chain: string; network: string; public_key: string }>(await db.execute(
    sql`SELECT chain, network, public_key FROM user_wallets WHERE user_id = ${userId} AND is_active = true`));
  const out: Record<string, string | null> = {};
  for (const slot of WALLET_SLOTS) out[slot.key] = rows.find((r) => r.chain === slot.chain && r.network === slot.network)?.public_key ?? null;
  return out;
}

const hasEscrow = async (userId: number) =>
  rowsOf(await db.execute(sql`SELECT 1 FROM wallet_key_escrow WHERE user_id = ${userId} AND kind = ${KIND}`)).length > 0;

export async function custodyRoutes(app: FastifyInstance, opts: CustodyOptions = {}) {
  const provider = opts.provider === undefined ? masterKeyProviderFromEnv() : opts.provider;
  const flags = opts.flags ?? custodyFlagsFromEnv();
  const networks = networksFor(flags);
  const xrplOn = xrplCustodyAllowed(flags);
  const WALLET_SLOTS = slotsFor(networks, xrplOn);

  app.post("/api/v1/custody/onboard", {
    preHandler: authMiddleware,
    config: { rateLimit: { max: 5, timeWindow: "15 minutes" } },
  }, async (request, reply) => {
    reply.header("Cache-Control", "no-store");
    if (!provider) return reply.status(503).send({ error: "Key backup is not switched on yet." });
    const { userId } = (request as any).user as { userId: number };
    if (!flags.serverSigning) return reply.status(503).send({ error: NOT_ON });
    if (!custodyAllowedForUser(flags, userId)) return reply.status(403).send({ error: CUSTODY_NOT_AVAILABLE });
    if (await selfCustody(userId)) return reply.status(409).send({ error: "You keep your own keys, so Amma does not set up wallets for you." });
    if (await hasEscrow(userId)) return { created: false, wallets: await activeWallets(userId, WALLET_SLOTS) };

    const created = await db.transaction(async (tx) => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext('custody-onboard'), ${userId})`);
      // A parallel call may have finished while we waited for the lock.
      if (rowsOf(await tx.execute(sql`SELECT 1 FROM wallet_key_escrow WHERE user_id = ${userId} AND kind = ${KIND}`)).length) return null;
      const phrase = generatePhrase();
      const derived = deriveAllChains(phrase);
      const sealed = await sealForEscrow(provider, phrase, { userId, kind: KIND });
      await tx.execute(sql`INSERT INTO wallet_key_escrow (user_id, kind, sealed, provider, origin) VALUES (${userId}, ${KIND}, ${sealed}, ${provider.id}, 'custody')`);
      const all = { stellar: derived.stellar.publicKey, xrpl: derived.xrpl.address, evm: derived.evm.address };
      const addresses = Object.fromEntries(WALLET_SLOTS.map((slot) => [slot.key, all[slot.key]])) as typeof all;
      for (const slot of WALLET_SLOTS) {
        const address = addresses[slot.key];
        await tx.execute(sql`INSERT INTO user_wallets (user_id, chain, network, public_key, name, is_active, encrypted_secret, derivation_index)
          SELECT ${userId}, ${slot.chain}, ${slot.network}, ${address}, ${slot.name},
            NOT EXISTS (SELECT 1 FROM user_wallets WHERE user_id = ${userId} AND chain = ${slot.chain} AND network = ${slot.network} AND is_active = true), NULL, 0
          ON CONFLICT (user_id, chain, network, public_key) DO NOTHING`);
      }
      await tx.insert(schema.auditLogs).values({
        userId, action: "custody_onboard", detail: { chains: WALLET_SLOTS.map((s) => s.key) },
        ipAddress: request.ip, userAgent: request.headers["user-agent"] ?? null,
      });
      return addresses;
    });
    if (!created) return { created: false, wallets: await activeWallets(userId, WALLET_SLOTS) };

    if (flags.welcomeFunding && opts.queueFunding) {
      try { await opts.queueFunding(userId, created); } catch { appLog().error({ code: "queue_failed" }, "custody_welcome_funding_not_queued"); }
    }
    return { created: true, wallets: created, funding: flags.welcomeFunding ? "queued" : "off" };
  });

  /** Shared gate for the wallet routes: flag and provider on, a custody user, and a phrase Amma created. Null when it replied. */
  async function walletGate(request: any, reply: any, o: { orImported?: boolean } = {}): Promise<number | null> {
    reply.header("Cache-Control", "no-store");
    if (!provider || !flags.serverSigning) { reply.status(503).send({ error: NOT_ON }); return null; }
    const { userId } = request.user as { userId: number };
    if (!custodyAllowedForUser(flags, userId)) { reply.status(403).send({ error: CUSTODY_NOT_AVAILABLE }); return null; }
    if (await selfCustody(userId)) { reply.status(409).send({ error: "You keep your own keys, so Amma does not manage wallets for you." }); return null; }
    const held = rowsOf(await db.execute(sql`SELECT 1 FROM wallet_key_escrow WHERE user_id = ${userId} AND kind = ${KIND} AND origin = 'custody'`)).length > 0
      || (o.orImported === true && rowsOf(await db.execute(sql`SELECT 1 FROM wallet_key_escrow WHERE user_id = ${userId} AND origin = 'import' LIMIT 1`)).length > 0);
    if (!held) {
      reply.status(409).send({ error: "Amma does not hold a recovery phrase for this account." }); return null;
    }
    return userId;
  }
  const nextIndex = async (q: { execute: (query: any) => Promise<unknown> }, userId: number, chain: MultiChain): Promise<number> => {
    const [r] = rowsOf<{ n: number | null }>(await q.execute(sql`SELECT max(derivation_index) AS n FROM user_wallets
      WHERE user_id = ${userId} AND chain = ${chain} AND network = ${networks[chain]} AND derivation_index IS NOT NULL`));
    return r?.n === null || r?.n === undefined ? 0 : Number(r.n) + 1;
  };

  app.get("/api/v1/custody/wallets", { preHandler: authMiddleware, config: { rateLimit: { max: 60, timeWindow: "15 minutes" } } }, async (request, reply) => {
    const userId = await walletGate(request, reply, { orImported: true });
    if (userId === null) return;
    // Derived wallets, plus device wallets moved in (no index, with their own escrow row).
    const rows = rowsOf<WalletRow>(await db.execute(sql`SELECT w.chain, w.network, w.public_key, w.name, w.derivation_index, w.is_active FROM user_wallets w
      WHERE w.user_id = ${userId} AND w.network IN (${networks.stellar}, ${networks.xrpl}, ${networks.evm}) AND ((w.derivation_index IS NOT NULL AND EXISTS (
        SELECT 1 FROM wallet_key_escrow p WHERE p.user_id = w.user_id AND p.kind = ${KIND} AND p.origin = 'custody')) OR EXISTS (
        SELECT 1 FROM wallet_key_escrow e WHERE e.user_id = w.user_id AND e.origin = 'import'
          AND e.kind = 'import:' || w.chain || ':' || CASE WHEN w.chain = 'evm' THEN lower(w.public_key) ELSE w.public_key END))
      ORDER BY w.chain, w.derivation_index NULLS LAST, w.id`));
    return { wallets: rows.map(walletOut) };
  });

  app.post("/api/v1/custody/wallets", { preHandler: authMiddleware, config: { rateLimit: { max: 10, timeWindow: "15 minutes" } } }, async (request, reply) => {
    const userId = await walletGate(request, reply);
    if (userId === null) return;
    const body = (request.body ?? {}) as { chain?: unknown; name?: unknown };
    if (body.chain !== "xrpl" && body.chain !== "evm") return reply.status(400).send({ error: "Choose XRP or Ethereum." });
    // Before any escrow open or key use.
    if (body.chain === "xrpl" && !xrplOn) return reply.status(400).send({ error: XRP_TESTNET_ONLY });
    const chain: MultiChain = body.chain;
    const hasName = body.name !== undefined && body.name !== null;
    const given = hasName ? cleanName(body.name) : null;
    if (hasName && given === null) return reply.status(400).send({ error: `Give the wallet a name of 1 to ${NAME_MAX} characters.` });
    const network = networks[chain];

    // The escrow open audits through its own connection, so it cannot run inside the transaction. We open for the
    // index we expect, then confirm under the lock that it is still the next one; if another add won, open again.
    for (let attempt = 0; attempt < 12; attempt++) {
      const n = await nextIndex(db, userId, chain);
      if (n > MAX_INDEX) return reply.status(409).send({ error: FULL });
      const [escrow] = rowsOf<{ sealed: string }>(await db.execute(sql`SELECT sealed FROM wallet_key_escrow WHERE user_id = ${userId} AND kind = ${KIND} AND origin = 'custody'`));
      if (!escrow) return reply.status(409).send({ error: "Amma does not hold a recovery phrase for this account." });
      let phrase: string | null;
      try {
        phrase = await openFromEscrow(provider!, escrow.sealed, { userId, kind: KIND, reason: `custody-add-wallet:${chain}:${n}`, ip: request.ip, userAgent: request.headers["user-agent"] });
      } catch {
        return reply.status(500).send({ error: "The wallet could not be added. Nothing was changed." });
      }
      const d = deriveAllChains(phrase, n);
      phrase = null;
      const address = chain === "evm" ? d.evm.address : d.xrpl.address;
      const name = given ?? `Wallet ${n + 1}`;
      let outcome: "full" | "retry" | "added";
      try { outcome = await db.transaction(async (tx) => {
        await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext('custody-wallets'), ${userId})`);
        const again = await nextIndex(tx, userId, chain);
        if (again > MAX_INDEX) return "full" as const;
        if (again !== n) return "retry" as const;
        await tx.execute(sql`INSERT INTO user_wallets (user_id, chain, network, public_key, name, is_active, encrypted_secret, derivation_index)
          VALUES (${userId}, ${chain}, ${network}, ${address}, ${name}, false, NULL, ${n})`);
        await tx.insert(schema.auditLogs).values({
          userId, action: "custody_wallet_added", detail: { chain, index: n },
          ipAddress: request.ip, userAgent: request.headers["user-agent"] ?? null,
        });
        return "added" as const;
      }); } catch (e: any) {
        if ((e?.code ?? e?.cause?.code) === "23505") return reply.status(409).send({ error: "That wallet already exists on your account." });
        throw e;
      }
      if (outcome === "full") return reply.status(409).send({ error: FULL });
      if (outcome === "retry") continue;
      return { wallet: { chain, network, address, name, index: n, active: false } };
    }
    return reply.status(409).send({ error: "Wallets are being added right now. Try again in a moment." });
  });

  /** Moves a device-only wallet into Amma's escrow. The secret must derive the claimed address; it is sealed, never echoed, logged or audited. */
  app.post("/api/v1/custody/import", {
    preHandler: authMiddleware,
    bodyLimit: 4096,
    config: { rateLimit: { max: 10, timeWindow: "1 hour", keyGenerator: importRateKey } },
  }, async (request, reply) => {
    reply.header("Cache-Control", "no-store");
    if (!provider || !flags.serverSigning) return reply.status(503).send({ error: NOT_ON });
    const { userId } = request.user as { userId: number };
    if (!custodyAllowedForUser(flags, userId)) return reply.status(403).send({ error: CUSTODY_NOT_AVAILABLE });
    const ctx = { ip: request.ip, userAgent: request.headers["user-agent"] };
    try {
      const raw = request.body;
      const b = (raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {}) as Record<string, unknown>;
      const allowed = new Set(["chain", "address", "secret", "password", "name", "retirePin"]);
      if (Object.keys(b).some((k) => !allowed.has(k))) return reply.status(400).send({ error: "That request is not valid." });
      if (b.retirePin !== undefined && b.retirePin !== true) return reply.status(400).send({ error: "That request is not valid." });
      // Self-custody accounts are refused, except to retire a legacy PIN wallet (owner decision 2026-11-19): that move
      // switches the account to Amma-managed signing once the stored key is verified (lib/pin-retired.ts).
      const self = await selfCustody(userId);
      if (self && b.retirePin !== true) return reply.status(409).send({ error: "You keep your own keys, so Amma does not manage wallets for you." });
      if (await recoveryFreezeActive(userId)) return reply.status(423).send({ error: "This account is frozen while a recovery request is waiting." });
      if (b.chain !== "stellar" && b.chain !== "xrpl" && b.chain !== "evm") return reply.status(400).send({ error: "Choose Stellar, XRP or Ethereum." });
      const chain: CustodyChain = b.chain;
      if (chain === "xrpl" && !xrplOn) return reply.status(400).send({ error: XRP_TESTNET_ONLY });
      if (typeof b.address !== "string" || !validAddress(chain, b.address)) return reply.status(400).send({ error: "That wallet address is not valid." });
      if (typeof b.secret !== "string" || !b.secret.trim() || b.secret.length > 400) return reply.status(400).send({ error: "Enter the recovery phrase or key for this wallet." });
      if (typeof b.password !== "string" || !b.password || b.password.length > 256) return reply.status(400).send({ error: "Enter your Amma password." });
      const hasName = b.name !== undefined && b.name !== null;
      const given = hasName ? cleanName(b.name) : null;
      if (hasName && given === null) return reply.status(400).send({ error: `Give the wallet a name of 1 to ${NAME_MAX} characters.` });

      const denied = await checkCustodyPasswordOnly({ provider, flags, userId, password: b.password, ...ctx }, chain);
      if (denied) return reply.status(denied.status).send({ error: denied.error });

      let secret: string | null = cleanSecret(b.secret);
      const derived = keyFromImported(chain, secret);
      if (!derived) return reply.status(400).send({ error: "That is not a recovery phrase or key this wallet can use." });
      if (!sameAddress(chain, derived.address, b.address)) return reply.status(400).send({ error: "That phrase doesn't match this wallet." });

      const address = chain === "evm" ? getAddress(b.address) : b.address;
      const network = networkOf(networks, chain);
      const kind = importKind(chain, address);
      const sealed = await sealForEscrow(provider, secret, { userId, kind });
      secret = null;
      const same = chain === "evm" ? sql`lower(public_key) = lower(${address})` : sql`public_key = ${address}`;
      const name = given ?? `Imported ${chain === "evm" ? "Ethereum" : chain === "xrpl" ? "XRP" : "Stellar"}`;

      const outcome = await db.transaction(async (tx) => {
        await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext('custody-import'), hashtext(${kind}))`);
        // Another account's wallet on any network, another account's import of it, or this account's own row on the other network: all refused (a testnet wallet is never mixed with a mainnet one).
        const elsewhere = rowsOf(await tx.execute(sql`SELECT 1 FROM user_wallets WHERE chain = ${chain} AND ${same} AND (user_id <> ${userId} OR network <> ${network}) LIMIT 1`)).length
          || rowsOf(await tx.execute(sql`SELECT 1 FROM wallet_key_escrow WHERE user_id <> ${userId} AND kind = ${kind} AND origin = 'import' LIMIT 1`)).length;
        if (elsewhere) return "taken" as const;
        const [row] = rowsOf<WalletRow & { id: number }>(await tx.execute(sql`SELECT id, derivation_index FROM user_wallets WHERE user_id = ${userId} AND chain = ${chain} AND network = ${network} AND ${same} ORDER BY id LIMIT 1`));
        // Already one of the account's own derived wallets: Amma holds it already.
        if (row && row.derivation_index !== null && row.derivation_index !== undefined) return "derived" as const;
        const have = rowsOf(await tx.execute(sql`SELECT 1 FROM wallet_key_escrow WHERE user_id = ${userId} AND kind = ${kind} AND origin = 'import'`)).length > 0;
        if (!have) {
          const [{ n }] = rowsOf<{ n: number }>(await tx.execute(sql`SELECT count(*)::int AS n FROM wallet_key_escrow WHERE user_id = ${userId} AND origin = 'import' AND kind LIKE ${`import:${chain}:%`}`));
          if (n >= IMPORT_CAP) return "full" as const;
        }
        if (!have) await tx.execute(sql`INSERT INTO wallet_key_escrow (user_id, kind, sealed, provider, origin) VALUES (${userId}, ${kind}, ${sealed}, ${provider.id}, 'import')`);
        if (!row) await tx.execute(sql`INSERT INTO user_wallets (user_id, chain, network, public_key, name, is_active, encrypted_secret, derivation_index) VALUES (${userId}, ${chain}, ${network}, ${address}, ${name}, false, NULL, NULL)`);
        if (!have) await tx.insert(schema.auditLogs).values({ userId, action: "custody_wallet_imported", detail: { chain, address }, ipAddress: ctx.ip, userAgent: ctx.userAgent ?? null });
        return have ? "again" as const : "imported" as const;
      });
      if (outcome === "full") return reply.status(409).send({ error: "You can move up to 10 wallets per network." });
      if (outcome === "taken") return reply.status(409).send({ error: "That wallet is already on another account." });
      const [out] = rowsOf<WalletRow>(await db.execute(sql`SELECT chain, network, public_key, name, derivation_index, is_active FROM user_wallets WHERE user_id = ${userId} AND chain = ${chain} AND network = ${network} AND ${same} ORDER BY id LIMIT 1`));
      // Retiring a self-custody PIN wallet: the account becomes Amma-managed so the real signer path will use the key. Undone below if verification fails.
      const managed = self ? rowsOf(await db.execute(sql`UPDATE users SET signing_mode = 'delegated', updated_at = now() WHERE id = ${userId} AND signing_mode = 'self' RETURNING id`)).length > 0 : false;
      // The device copy may only be removed once the stored secret has been used by the real signer path. The escrow row is kept either way.
      try {
        await withDelegatedKey({ provider, flags, userId, chain, expectedAddress: address, reason: "custody-import-verify", ...ctx },
          async (key) => proveCanSign(chain, address, key));
      } catch (e: any) {
        if (managed) await db.execute(sql`UPDATE users SET signing_mode = 'self', updated_at = now() WHERE id = ${userId} AND signing_mode = 'delegated'`);
        appLog().error({ code: e instanceof CustodyRefused ? `refused_${e.code}` : typeof e?.code === "string" ? e.code : "unknown" }, "custody_import_verify_failed");
        return reply.status(500).send({ error: "Amma stored the wallet but couldn't verify it yet. Keep the copy on your device.", verified: false });
      }
      // Verified: the server's PIN-encrypted copy (legacy delegated wallets) is no longer needed and is a weak offline target, so it goes.
      // From here the wallet is opened with the account login only (lib/pin-retired.ts).
      const dropped = rowsOf(await db.execute(sql`UPDATE user_wallets SET encrypted_secret = NULL WHERE user_id = ${userId} AND chain = ${chain} AND network = ${network} AND ${same} AND encrypted_secret IS NOT NULL RETURNING id`)).length;
      if (dropped || managed) await db.insert(schema.auditLogs).values({ userId, action: "custody_pin_copy_removed", detail: { chain, address, ...(managed ? { signingModeChanged: "self->delegated" } : {}) }, ipAddress: ctx.ip, userAgent: ctx.userAgent ?? null });
      return { imported: outcome === "imported", alreadyHeld: outcome !== "imported", verified: true, pinCopyRemoved: dropped > 0, wallet: walletOut(out) };
    } catch (e: any) {
      if ((e?.code ?? e?.cause?.code) === "23505") {
        const where = String(e?.constraint_name ?? e?.constraint ?? e?.cause?.constraint ?? "");
        return reply.status(409).send({ error: where.includes("escrow") ? "That wallet is already held for another account." : "That wallet already exists on your account." });
      }
      appLog().error({ code: typeof e?.code === "string" ? e.code : "unknown" }, "custody_import_failed");
      return reply.status(500).send({ error: "The wallet could not be moved. Nothing was changed." });
    }
  });

  app.patch("/api/v1/custody/wallets", { preHandler: authMiddleware, config: { rateLimit: { max: 30, timeWindow: "15 minutes" } } }, async (request, reply) => {
    const userId = await walletGate(request, reply, { orImported: true });
    if (userId === null) return;
    const body = (request.body ?? {}) as { chain?: unknown; address?: unknown; name?: unknown; active?: unknown };
    if (body.chain !== "xrpl" && body.chain !== "evm" && body.chain !== "stellar") return reply.status(400).send({ error: "Choose Stellar, XRP or Ethereum." });
    if (typeof body.address !== "string" || !body.address || body.address.length > 100) return reply.status(400).send({ error: "Choose a wallet." });
    const hasName = body.name !== undefined && body.name !== null;
    const name = hasName ? cleanName(body.name) : null;
    if (hasName && name === null) return reply.status(400).send({ error: `Give the wallet a name of 1 to ${NAME_MAX} characters.` });
    const hasActive = body.active !== undefined && body.active !== null;
    if (hasActive && body.active !== true) return reply.status(400).send({ error: "Choose a wallet to make main; one always stays main." });
    if (!hasName && !hasActive) return reply.status(400).send({ error: "Nothing to change." });
    const chain: CustodyChain = body.chain;
    const network = networkOf(networks, chain);
    const address = body.address;

    const updated = await db.transaction(async (tx) => {
      await tx.execute(sql`SELECT id FROM users WHERE id = ${userId} FOR NO KEY UPDATE`);
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext('custody-wallets'), ${userId})`);
      // Derived wallets (index recorded), or wallets moved in from a device that have their own import escrow row.
      const [row] = rowsOf<{ id: number }>(await tx.execute(sql`SELECT w.id FROM user_wallets w WHERE w.user_id = ${userId} AND w.chain = ${chain} AND w.network = ${network}
        AND ${chain === "evm" ? sql`lower(w.public_key) = lower(${address})` : sql`w.public_key = ${address}`}
        AND ((w.derivation_index IS NOT NULL AND EXISTS (
        SELECT 1 FROM wallet_key_escrow p WHERE p.user_id = w.user_id AND p.kind = ${KIND} AND p.origin = 'custody')) OR EXISTS (SELECT 1 FROM wallet_key_escrow e WHERE e.user_id = w.user_id AND e.origin = 'import'
          AND e.kind = 'import:' || w.chain || ':' || CASE WHEN w.chain = 'evm' THEN lower(w.public_key) ELSE w.public_key END)) LIMIT 1`));
      if (!row) return null;
      if (hasActive) {
        await tx.execute(sql`UPDATE user_wallets SET is_active = false WHERE user_id = ${userId} AND chain = ${chain} AND network = ${network} AND is_active = true AND id <> ${row.id}`);
        await tx.execute(sql`UPDATE user_wallets SET is_active = true WHERE id = ${row.id}`);
      }
      if (name !== null) await tx.execute(sql`UPDATE user_wallets SET name = ${name} WHERE id = ${row.id}`);
      const [out] = rowsOf<WalletRow>(await tx.execute(sql`SELECT chain, network, public_key, name, derivation_index, is_active FROM user_wallets WHERE id = ${row.id}`));
      await tx.insert(schema.auditLogs).values({
        userId, action: "custody_wallet_updated", detail: { chain, index: out.derivation_index === null ? null : Number(out.derivation_index), renamed: name !== null, active: hasActive },
        ipAddress: request.ip, userAgent: request.headers["user-agent"] ?? null,
      });
      return out;
    });
    if (!updated) return reply.status(404).send({ error: "That wallet is not one of yours." });
    return { wallet: walletOut(updated) };
  });

  app.get("/api/v1/custody/activity", { preHandler: authMiddleware }, async (request, reply) => {
    reply.header("Cache-Control", "no-store");
    if (!flags.serverSigning && !flags.welcomeFunding) return reply.status(503).send({ error: NOT_ON });
    const { userId } = (request as any).user as { userId: number };
    if (!custodyAllowedForUser(flags, userId)) return reply.status(403).send({ error: CUSTODY_NOT_AVAILABLE });
    const rows = rowsOf<{ action: string; detail: any; created_at: string | Date }>(await db.execute(
      sql`SELECT action, detail, created_at FROM audit_logs
        WHERE user_id = ${userId} AND action IN (${sql.join(ACTIONS.map((a) => sql`${a}`), sql`, `)})
        ORDER BY created_at DESC, id DESC LIMIT 50`));
    const events = rows.map((r) => {
      const d = r.detail && typeof r.detail === "object" ? r.detail : {};
      const event: { at: string | Date; action: string; chain?: string; reason?: string } = { at: r.created_at, action: r.action };
      if (typeof d.chain === "string") event.chain = d.chain.slice(0, 40);
      if (typeof d.reason === "string") event.reason = d.reason.slice(0, 80);
      return event;
    });
    return { events };
  });

  app.get("/api/v1/custody/welcome-funding", { preHandler: authMiddleware, config: { rateLimit: { max: 30, timeWindow: "15 minutes" } } }, async (request, reply) => {
    reply.header("Cache-Control", "no-store");
    if (!flags.serverSigning && !flags.welcomeFunding) return reply.status(503).send({ error: NOT_ON });
    const { userId } = (request as any).user as { userId: number };
    if (!custodyAllowedForUser(flags, userId)) return reply.status(403).send({ error: CUSTODY_NOT_AVAILABLE });
    // Retry on the next status call, without making the caller wait on a faucet.
    if (flags.welcomeFunding && opts.retryFunding) Promise.resolve().then(() => opts.retryFunding!(userId)).catch(() => appLog().error({ code: "queue_failed" }, "custody_welcome_funding_not_queued"));
    const rows = rowsOf<{ chain: string; address: string; state: string; amount: string | null; reference: string | null; error: string | null }>(await db.execute(
      sql`SELECT chain, address, state, amount, reference, error FROM welcome_funding WHERE user_id = ${userId} ORDER BY id`));
    return { funding: rows.map((r) => ({ chain: r.chain, address: r.address, state: r.state, amount: r.amount, reference: r.reference, error: r.error })) };
  });
}
