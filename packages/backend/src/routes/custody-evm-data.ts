import type { FastifyInstance } from "fastify";
import { and, eq, sql } from "drizzle-orm";
import { isAddress } from "viem";
import { db, schema } from "../db";
import { authMiddleware } from "../middleware/auth";
import { appLog } from "../lib/app-log";
import { recoveryFreezeActive } from "../lib/key-recovery";
import { CUSTODY_NOT_AVAILABLE, custodyAllowedForUser, custodyFlagsFromEnv, type CustodyFlags } from "../lib/custody-flags";
import { networksFor } from "../lib/custody-networks";
import { AlchemyError, alchemyCall, alchemyUrlFromEnv, ethDataFlagsFromEnv, exactAmount, hexToBigInt, NATIVE_ETH_LOG_ADDRESS, type EthDataFlags, type FetchLike } from "../lib/alchemy";
import { INSUFFICIENT_FUNDS, INSUFFICIENT_FUNDS_MESSAGE, simulateEthSend, unexpectedChanges } from "../lib/eth-simulate";

/**
 * Server-side Ethereum data for a signed-in user's OWN Amma-held wallets, behind ETH_SERVER_DATA=on: balances (ETH and tokens), history, a send preview,
 * and the unread incoming-payment alerts. The Alchemy URL (it holds the API key) never leaves this server and is never logged.
 */
export interface CustodyEvmDataOptions {
  flags?: CustodyFlags;
  eth?: EthDataFlags;
  /** The Alchemy RPC URL, or null when not configured. */
  rpcUrl?: () => string | null;
  fetch?: FetchLike;
  now?: () => number;
}

const CACHE_MS = 30_000;
const META_MS = 60 * 60_000;
const META_FAIL_MS = 10 * 60_000;
const META_MAX = 2000;
const META_PARALLEL = 5;
const MAX_TOKENS = 50;
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const NOT_FOUND = "Not found.";
const rowsOf = <T,>(r: any): T[] => (r?.rows ?? r) as T[];

class Refused extends Error { constructor(public status: number, message: string) { super(message); } }

const addr = (v: unknown, what: string): string => {
  if (typeof v !== "string" || !ADDRESS.test(v) || !isAddress(v)) throw new Refused(400, `The ${what} address is not valid.`);
  return v.toLowerCase();
};

/** A plain-words answer; the cause (never the URL) goes to the log as a short code. */
function plain(cause: unknown, event: string): { status: number; error: string } {
  if (cause instanceof Refused) return { status: cause.status, error: cause.message };
  appLog().warn({ reason: cause instanceof AlchemyError ? cause.code : "unknown" }, event);
  return { status: 503, error: "Ethereum data is not available right now. Try again in a moment." };
}

const safeText = (v: unknown, n: number): string | null => (typeof v === "string" && v.trim() ? v.replace(/[\u0000-\u001f<>]/g, "").slice(0, n) : null);
const safeLogo = (v: unknown): string | null => (typeof v === "string" && v.length <= 300 && /^https:\/\/[^\s"'<>]+$/.test(v) ? v : null);
const safeAddr = (v: unknown): string | null => (typeof v === "string" && ADDRESS.test(v) ? v.toLowerCase() : null);

export async function custodyEvmDataRoutes(app: FastifyInstance, opts: CustodyEvmDataOptions = {}) {
  const flags = opts.flags ?? custodyFlagsFromEnv();
  const eth = opts.eth ?? ethDataFlagsFromEnv();
  const networks = networksFor(flags);
  const rpcUrl = opts.rpcUrl ?? (() => alchemyUrlFromEnv());
  const now = opts.now ?? (() => Date.now());
  const balanceCache = new Map<string, { at: number; value: unknown }>();
  const metaCache = new Map<string, { at: number; ttl: number; value: { symbol: string | null; name: string | null; decimals: number | null; logo: string | null } }>();

  const call = <T,>(url: string, method: string, params: unknown[]) => alchemyCall<T>(url, method, params, opts.fetch);

  /** Common gate: the feature is on, the account may use Amma custody here, and the address is one of its own evm wallets on this network. */
  async function guard(userId: number, raw: unknown, what = "wallet"): Promise<{ address: string; url: string }> {
    if (!eth.serverData) throw new Refused(404, NOT_FOUND);
    if (!custodyAllowedForUser(flags, userId)) throw new Refused(403, CUSTODY_NOT_AVAILABLE);
    const address = addr(raw, what);
    const [wallet] = await db.select({ id: schema.userWallets.id }).from(schema.userWallets).where(and(
      eq(schema.userWallets.userId, userId), eq(schema.userWallets.chain, "evm"), eq(schema.userWallets.network, networks.evm), sql`lower(${schema.userWallets.publicKey}) = ${address}`)).limit(1);
    if (!wallet) throw new Refused(403, "That is not one of your Ethereum wallets.");
    if (await recoveryFreezeActive(userId)) throw new Refused(423, "This account is frozen while a recovery request is waiting.");
    const url = rpcUrl();
    if (!url) throw new Refused(503, "Ethereum data is not set up here yet.");
    return { address, url };
  }

  app.get("/api/v1/custody/evm/config", { preHandler: authMiddleware, config: { rateLimit: { max: 60, timeWindow: "1 minute" } } }, async (request, reply) => {
    reply.header("Cache-Control", "no-store");
    const allowed = custodyAllowedForUser(flags, request.user!.userId);
    return { serverData: eth.serverData && allowed, simulate: eth.sendSimulate, alerts: eth.alerts && allowed, network: networks.evm };
  });

  app.get("/api/v1/custody/evm/balances", { preHandler: authMiddleware, config: { rateLimit: { max: 30, timeWindow: "1 minute" } } }, async (request, reply) => {
    reply.header("Cache-Control", "no-store");
    try {
      const { address, url } = await guard(request.user!.userId, (request.query as { address?: unknown } | undefined)?.address);
      const key = `${networks.evm}:${address}`;
      const hit = balanceCache.get(key);
      if (hit && now() - hit.at < CACHE_MS) return hit.value;

      const [bal, tokens] = await Promise.all([
        call<string>(url, "eth_getBalance", [address, "latest"]),
        call<{ tokenBalances?: { contractAddress?: string; tokenBalance?: string | null; error?: unknown }[] }>(url, "alchemy_getTokenBalances", [address, "erc20"]).catch((e) => { appLog().warn({ reason: e instanceof AlchemyError ? e.code : "unknown" }, "eth_token_balances_failed"); return null; }),
      ]);
      const wei = hexToBigInt(bal).toString();
      const held = (tokens?.tokenBalances ?? []).flatMap((t) => {
        const contract = safeAddr(t.contractAddress);
        if (!contract || t.error || typeof t.tokenBalance !== "string" || !/^0x[0-9a-fA-F]+$/.test(t.tokenBalance)) return [];
        const balance = hexToBigInt(t.tokenBalance);
        return balance > 0n ? [{ contract, balance: balance.toString() }] : [];
      }).slice(0, MAX_TOKENS);
      const lookup = async (t: { contract: string; balance: string }) => {
        let meta = metaCache.get(t.contract);
        if (!meta || now() - meta.at >= meta.ttl) {
          try {
            const m = await call<{ symbol?: unknown; name?: unknown; decimals?: unknown; logo?: unknown }>(url, "alchemy_getTokenMetadata", [t.contract]);
            meta = { at: now(), ttl: META_MS, value: { symbol: safeText(m?.symbol, 20), name: safeText(m?.name, 60), decimals: Number.isInteger(m?.decimals) && (m.decimals as number) >= 0 && (m.decimals as number) <= 36 ? (m.decimals as number) : null, logo: safeLogo(m?.logo) } };
          } catch { meta = { at: now(), ttl: META_FAIL_MS, value: { symbol: null, name: null, decimals: null, logo: null } }; }
          if (metaCache.size >= META_MAX) metaCache.delete(metaCache.keys().next().value as string);
          metaCache.set(t.contract, meta);
        }
        return { contract: t.contract, ...meta.value, balance: t.balance };
      };
      // At most META_PARALLEL metadata calls at a time.
      const list: Awaited<ReturnType<typeof lookup>>[] = new Array(held.length);
      let nextIndex = 0;
      await Promise.all(Array.from({ length: Math.min(META_PARALLEL, held.length) }, async () => {
        while (nextIndex < held.length) { const i = nextIndex++; list[i] = await lookup(held[i]); }
      }));
      const value = { address, network: networks.evm, wei, tokens: list, tokensUnavailable: tokens === null };
      if (tokens !== null) {
        if (balanceCache.size > 500) balanceCache.clear();
        balanceCache.set(key, { at: now(), value });
      }
      return value;
    } catch (cause) {
      const { status, error } = plain(cause, "eth_balances_failed");
      return reply.status(status).send({ error });
    }
  });

  type Transfer = { hash?: string; from?: string; to?: string; value?: number | string | null; rawContract?: { value?: unknown; decimal?: unknown; address?: unknown } | null; asset?: string | null; category?: string; blockNum?: string; uniqueId?: string; metadata?: { blockTimestamp?: string } };
  const PAGE_PART = /^[A-Za-z0-9_.:=+/-]{1,300}$/;
  const decodePage = (raw: unknown): { o?: string; i?: string } => {
    if (raw === undefined || raw === "") return {};
    if (typeof raw !== "string" || raw.length > 700 || !/^[A-Za-z0-9_-]+$/.test(raw)) throw new Refused(400, "That page key is not valid.");
    try {
      const p = JSON.parse(Buffer.from(raw, "base64url").toString("utf8")) as { o?: unknown; i?: unknown };
      const out: { o?: string; i?: string } = {};
      for (const k of ["o", "i"] as const) if (p[k] !== undefined) { if (typeof p[k] !== "string" || !PAGE_PART.test(p[k] as string)) throw new Error("bad"); out[k] = p[k] as string; }
      return out;
    } catch { throw new Refused(400, "That page key is not valid."); }
  };

  app.get("/api/v1/custody/evm/history", { preHandler: authMiddleware, config: { rateLimit: { max: 30, timeWindow: "1 minute" } } }, async (request, reply) => {
    reply.header("Cache-Control", "no-store");
    try {
      const q = (request.query ?? {}) as { address?: unknown; pageKey?: unknown };
      const { address, url } = await guard(request.user!.userId, q.address);
      const page = decodePage(q.pageKey);
      const paged = page.o !== undefined || page.i !== undefined;
      const fetchSide = async (side: "fromAddress" | "toAddress", pageKey?: string) => {
        // On a later page, a direction that has no more pages is not asked again.
        if (paged && pageKey === undefined) return { transfers: [] as Transfer[], pageKey: undefined as string | undefined };
        const r = await call<{ transfers?: Transfer[]; pageKey?: string }>(url, "alchemy_getAssetTransfers", [{
          fromBlock: "0x0", toBlock: "latest", [side]: address, category: ["external", "erc20"], withMetadata: true, excludeZeroValue: true, order: "desc", maxCount: "0x19", ...(pageKey ? { pageKey } : {}),
        }]);
        return { transfers: Array.isArray(r?.transfers) ? r.transfers : [], pageKey: typeof r?.pageKey === "string" && PAGE_PART.test(r.pageKey) ? r.pageKey : undefined };
      };
      const [out, inn] = await Promise.all([fetchSide("fromAddress", page.o), fetchSide("toAddress", page.i)]);
      const seen = new Set<string>();
      const items = [...out.transfers, ...inn.transfers].flatMap((t) => {
        const hash = typeof t.hash === "string" && /^0x[0-9a-fA-F]{64}$/.test(t.hash) ? t.hash.toLowerCase() : null;
        const from = safeAddr(t.from), to = safeAddr(t.to);
        if (!hash || (!from && !to)) return [];
        if (t.category !== "external" && t.category !== "internal") {
          const contract = safeAddr(t.rawContract?.address);
          if (contract === NATIVE_ETH_LOG_ADDRESS || (!contract && !safeText(t.asset, 20))) return [];
        }
        const id = `${hash}:${t.uniqueId ?? ""}`;
        if (seen.has(id)) return [];
        seen.add(id);
        const direction = from === address ? "out" : "in";
        let block = 0n; try { block = hexToBigInt(t.blockNum); } catch { /* unknown block sorts last */ }
        return [{ block, id, hash, direction, asset: t.category === "external" || t.category === "internal" ? "ETH" : safeText(t.asset, 20) ?? "token", value: exactAmount(t.rawContract, typeof t.value === "number" ? t.value : typeof t.value === "string" && /^[0-9]{1,30}(\.[0-9]{1,30})?$/.test(t.value) ? Number(t.value) : null), counterparty: direction === "out" ? to : from, timestamp: typeof t.metadata?.blockTimestamp === "string" && !Number.isNaN(Date.parse(t.metadata.blockTimestamp)) ? new Date(t.metadata.blockTimestamp).toISOString() : null }];
      }).sort((a, b) => (a.block === b.block ? (a.id < b.id ? 1 : -1) : a.block < b.block ? 1 : -1));
      const nextPageKey = out.pageKey || inn.pageKey ? Buffer.from(JSON.stringify({ ...(out.pageKey ? { o: out.pageKey } : {}), ...(inn.pageKey ? { i: inn.pageKey } : {}) })).toString("base64url") : null;
      return { address, transfers: items.map(({ hash, direction, asset, value, counterparty, timestamp }) => ({ hash, direction, asset, value, counterparty, timestamp })), pageKey: nextPageKey };
    } catch (cause) {
      const { status, error } = plain(cause, "eth_history_failed");
      return reply.status(status).send({ error });
    }
  });

  app.post("/api/v1/custody/evm/preview", { preHandler: authMiddleware, bodyLimit: 2048, config: { rateLimit: { max: 30, timeWindow: "1 minute" } } }, async (request, reply) => {
    reply.header("Cache-Control", "no-store");
    const userId = request.user!.userId;
    try {
      const b = request.body as Record<string, unknown> | null;
      if (!eth.serverData) throw new Refused(404, NOT_FOUND);
      if (!b || typeof b !== "object" || Array.isArray(b) || Object.keys(b).some((k) => !["from", "to", "amountWei"].includes(k)) || !["from", "to", "amountWei"].every((k) => k in b)) throw new Refused(400, "That request is not valid.");
      const to = addr(b.to, "destination");
      if (typeof b.amountWei !== "string" || !/^[1-9][0-9]{0,40}$/.test(b.amountWei)) throw new Refused(400, "The amount must be a whole number of wei more than 0.");
      const { address: from, url } = await guard(userId, b.from, "sending");
      if (to === "0x0000000000000000000000000000000000000000") throw new Refused(400, "That destination address can't receive payments.");
      if (to === from) throw new Refused(400, "You can't send to the same wallet.");
      const value = BigInt(b.amountWei);
      let sim;
      try {
        // A bounded gas limit for the simulated call: without one Alchemy assumes a huge default and reports "insufficient funds" for ordinary wallets.
        const gas = await call<string>(url, "eth_estimateGas", [{ from, to, value: "0x" + value.toString(16) }]).then(hexToBigInt).then((g) => (g > 0n && g <= 1_000_000n ? g : 21000n)).catch(() => 21000n);
        const [s, gasPrice] = await Promise.all([simulateEthSend(url, { from, to, value, gas }, opts.fetch), call<string>(url, "eth_gasPrice", []).then(hexToBigInt).catch(() => null)]);
        sim = { s, gasPrice };
      } catch (e) {
        appLog().warn({ reason: e instanceof AlchemyError ? e.code : "unknown" }, "eth_preview_failed");
        if (e instanceof AlchemyError && e.code === INSUFFICIENT_FUNDS) return { changes: [], gasEstimateWei: null, warnings: [INSUFFICIENT_FUNDS_MESSAGE] };
        return { changes: [], gasEstimateWei: null, warnings: ["We couldn't check this payment right now. You can still send it, but it was not simulated."] };
      }
      const warnings: string[] = [];
      if (sim.s.error) warnings.push(`The simulation reported a problem: ${sim.s.error}`);
      const { other } = unexpectedChanges(sim.s, { to, value });
      for (const c of other) warnings.push(c.kind === "approval" ? `This would also let someone spend your ${c.asset}.` : c.direction === "in" ? `This would also bring ${c.amount} ${c.asset} into your wallet.` : c.direction === "out" ? `This would also move ${c.amount} ${c.asset} out of your wallet.` : `This would also change ${c.asset} for another account.`);
      if (!sim.s.error && other.length === sim.s.changes.length) warnings.push("The simulation did not show the ETH you are sending.");
      return {
        changes: sim.s.changes.map((c) => ({ asset: c.asset, direction: c.direction, amount: c.amount })),
        gasEstimateWei: sim.s.gasUsed !== null && sim.gasPrice !== null ? (sim.s.gasUsed * sim.gasPrice).toString() : null,
        warnings,
      };
    } catch (cause) {
      const { status, error } = plain(cause, "eth_preview_failed");
      return reply.status(status).send({ error });
    }
  });

  /** Unread incoming-payment alerts for this user (written by the Alchemy webhook). Reading does not mark them seen: the client confirms with POST /alerts/seen once it has stored them. */
  app.get("/api/v1/custody/evm/alerts", { preHandler: authMiddleware, config: { rateLimit: { max: 60, timeWindow: "1 minute" } } }, async (request, reply) => {
    reply.header("Cache-Control", "no-store");
    const userId = request.user!.userId;
    try {
      if (!eth.alerts) throw new Refused(404, NOT_FOUND);
      if (!custodyAllowedForUser(flags, userId)) throw new Refused(403, CUSTODY_NOT_AVAILABLE);
      const rows = rowsOf<{ id: string | number; tx_hash: string; to_address: string; from_address: string | null; asset: string; value: string; created_at: Date | string }>(await db.execute(sql`
        SELECT id, tx_hash, to_address, from_address, asset, value, created_at FROM eth_incoming_alerts
        WHERE user_id = ${userId} AND network = ${networks.evm} AND seen_at IS NULL ORDER BY id LIMIT 20`));
      rows.sort((a, b) => Number(a.id) - Number(b.id));
      return { alerts: rows.map((r) => ({ id: String(r.id), hash: r.tx_hash, to: r.to_address, from: r.from_address, asset: r.asset, value: r.value, createdAt: new Date(r.created_at).toISOString() })) };
    } catch (cause) {
      const { status, error } = plain(cause, "eth_alerts_failed");
      return reply.status(status).send({ error });
    }
  });

  app.post("/api/v1/custody/evm/alerts/seen", { preHandler: authMiddleware, bodyLimit: 4096, config: { rateLimit: { max: 60, timeWindow: "1 minute" } } }, async (request, reply) => {
    reply.header("Cache-Control", "no-store");
    const userId = request.user!.userId;
    try {
      if (!eth.alerts) throw new Refused(404, NOT_FOUND);
      if (!custodyAllowedForUser(flags, userId)) throw new Refused(403, CUSTODY_NOT_AVAILABLE);
      const b = request.body as { ids?: unknown } | null;
      if (!b || typeof b !== "object" || !Array.isArray(b.ids) || b.ids.length < 1 || b.ids.length > 50 || !b.ids.every((i) => typeof i === "string" && /^[0-9]{1,15}$/.test(i))) throw new Refused(400, "That request is not valid.");
      const ids = (b.ids as string[]).map(Number);
      const res = rowsOf<{ id: string | number }>(await db.execute(sql`UPDATE eth_incoming_alerts SET seen_at = now()
        WHERE user_id = ${userId} AND network = ${networks.evm} AND seen_at IS NULL AND id IN (${sql.join(ids.map((i) => sql`${i}`), sql`, `)}) RETURNING id`));
      return { marked: res.length };
    } catch (cause) {
      const { status, error } = plain(cause, "eth_alerts_seen_failed");
      return reply.status(status).send({ error });
    }
  });
}
