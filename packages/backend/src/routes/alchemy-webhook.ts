import type { FastifyInstance } from "fastify";
import { createHmac, timingSafeEqual } from "node:crypto";
import { sql } from "drizzle-orm";
import { db } from "../db";
import { appLog } from "../lib/app-log";
import { custodyFlagsFromEnv, type CustodyFlags } from "../lib/custody-flags";
import { networksFor } from "../lib/custody-networks";
import { NATIVE_ETH_LOG_ADDRESS, exactAmount, ethDataFlagsFromEnv, type EthDataFlags } from "../lib/alchemy";

/**
 * Incoming-payment alerts: Alchemy "Address Activity" webhook. Public, so the only credential is the HMAC-SHA256 signature of the RAW body
 * (X-Alchemy-Signature) made with ALCHEMY_WEBHOOK_SIGNING_KEY. Without that key, or without ETH_ALERTS=on, the route does not exist (404).
 */
export interface AlchemyWebhookOptions { flags?: CustodyFlags; eth?: EthDataFlags; signingKey?: string | undefined; /** Lowercase token contracts that may raise an alert. Default: ETH_ALERT_TOKENS, else the built-in list for the network. */ alertTokens?: ReadonlySet<string> }

/** Address poisoning: anyone can send a worthless token or a zero-value transfer to any address. Only native ETH and these contracts ever raise an alert. */
export const DEFAULT_ALERT_TOKENS: Record<"ethereum" | "sepolia", readonly string[]> = {
  ethereum: ["0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48" /* USDC */, "0xdac17f958d2ee523a2206206994597c13d831ec7" /* USDT */],
  sepolia: [],
};
export function alertTokensFromEnv(env: Record<string, string | undefined>, network: "ethereum" | "sepolia"): ReadonlySet<string> {
  const raw = env.ETH_ALERT_TOKENS;
  const list = raw === undefined ? DEFAULT_ALERT_TOKENS[network] : raw.split(",").map((s) => s.trim().toLowerCase()).filter((s) => /^0x[0-9a-f]{40}$/.test(s));
  return new Set(list);
}

export const WEBHOOK_MAX_BYTES = 256 * 1024;
const MAX_ACTIVITIES = 100;
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const HASH = /^0x[0-9a-fA-F]{64}$/;

export function signatureValid(raw: Buffer, header: unknown, key: string): boolean {
  if (typeof header !== "string" || !/^[0-9a-fA-F]{64}$/.test(header)) return false;
  const expected = createHmac("sha256", key).update(raw).digest();
  return timingSafeEqual(expected, Buffer.from(header, "hex"));
}

interface Activity { fromAddress?: unknown; toAddress?: unknown; hash?: unknown; value?: unknown; asset?: unknown; category?: unknown; log?: { logIndex?: unknown } | null; rawContract?: { rawValue?: unknown; decimals?: unknown; address?: unknown } | null }

const clean = (v: unknown, n: number): string | null => (typeof v === "string" && v.trim() ? v.replace(/[^\w .$-]/g, "").slice(0, n) : null);

export async function alchemyWebhookRoutes(app: FastifyInstance, opts: AlchemyWebhookOptions = {}) {
  const flags = opts.flags ?? custodyFlagsFromEnv();
  const eth = opts.eth ?? ethDataFlagsFromEnv();
  const key = "signingKey" in opts ? opts.signingKey : process.env.ALCHEMY_WEBHOOK_SIGNING_KEY;
  const networks = networksFor(flags);
  const alchemyNetwork = networks.mainnet ? "ETH_MAINNET" : "ETH_SEPOLIA";
  const alertTokens = opts.alertTokens ?? alertTokensFromEnv(process.env, networks.evm);

  // This plugin sees the body as raw bytes only: the signature covers exactly what Alchemy sent.
  app.removeAllContentTypeParsers();
  app.addContentTypeParser("*", { parseAs: "buffer", bodyLimit: WEBHOOK_MAX_BYTES }, (_req, body, done) => done(null, body));

  app.post("/api/v1/webhooks/alchemy", { bodyLimit: WEBHOOK_MAX_BYTES, config: { rateLimit: { max: 300, timeWindow: "1 minute" } } }, async (request, reply) => {
    if (!key || !eth.alerts) return reply.status(404).send({ error: "Not found." });
    const raw = request.body;
    if (!Buffer.isBuffer(raw) || raw.length === 0 || raw.length > WEBHOOK_MAX_BYTES) return reply.status(401).send({ error: "Unauthorized." });
    if (!signatureValid(raw, request.headers["x-alchemy-signature"], key)) return reply.status(401).send({ error: "Unauthorized." });

    let payload: { type?: unknown; event?: { network?: unknown; activity?: unknown } };
    try { payload = JSON.parse(raw.toString("utf8")); } catch { return reply.status(400).send({ error: "Bad request." }); }
    if (payload?.type !== "ADDRESS_ACTIVITY" || payload.event?.network !== alchemyNetwork || !Array.isArray(payload.event.activity)) return { ok: true, stored: 0 };

    const wanted = new Map<string, Activity[]>();
    for (const a of (payload.event.activity as Activity[]).slice(0, MAX_ACTIVITIES)) {
      if (!a || typeof a.toAddress !== "string" || !ADDRESS.test(a.toAddress) || typeof a.hash !== "string" || !HASH.test(a.hash)) continue;
      const to = a.toAddress.toLowerCase();
      wanted.set(to, [...(wanted.get(to) ?? []), a]);
    }
    let stored = 0;
    try {
      for (const [to, activities] of wanted) {
        const res = await db.execute(sql`SELECT user_id FROM user_wallets WHERE chain = 'evm' AND network = ${networks.evm} AND lower(public_key) = ${to}`);
        const owners = (((res as any).rows ?? res) as { user_id: number }[]);
        for (const owner of owners) for (const a of activities) {
          const approx = typeof a.value === "number" && Number.isFinite(a.value) ? a.value : typeof a.value === "string" && /^[0-9.]{1,40}$/.test(a.value) ? Number(a.value) : null;
          // The exact amount comes from the hex rawValue and decimals; the (float) value is only the fallback.
          const shown = exactAmount(a.rawContract, approx);
          const value = shown === null ? null : Number(shown);
          if (shown === null || value === null || !(value > 0 || /[1-9]/.test(shown))) continue;
          const category = clean(a.category, 20) ?? "unknown";
          // Native ETH only, or a token on the allow-list. Everything else (unknown tokens, NFTs, dust) is ignored.
          const native = category === "external" || category === "internal";
          const contract = typeof a.rawContract?.address === "string" ? a.rawContract.address.toLowerCase() : "";
          if (contract === NATIVE_ETH_LOG_ADDRESS) continue; // the pseudo-log twin of a native transfer
          if (!native && !(category === "token" && alertTokens.has(contract))) continue;
          const logIndex = typeof a.log?.logIndex === "string" && /^0x[0-9a-fA-F]{1,16}$/.test(a.log.logIndex) ? a.log.logIndex.toLowerCase() : null;
          const from = typeof a.fromAddress === "string" && ADDRESS.test(a.fromAddress) ? a.fromAddress.toLowerCase() : null;
          const eventKey = logIndex ? `${category}:${logIndex}` : `${category}:${from ?? "?"}:${String(a.rawContract?.rawValue ?? shown).slice(0, 80)}`;
          const asset = clean(a.asset, 40) ?? (category === "external" || category === "internal" ? "ETH" : "token");
          const ins = await db.execute(sql`INSERT INTO eth_incoming_alerts (user_id, network, to_address, from_address, tx_hash, event_key, asset, value)
            VALUES (${owner.user_id}, ${networks.evm}, ${to}, ${from}, ${(a.hash as string).toLowerCase()}, ${eventKey}, ${asset}, ${shown})
            ON CONFLICT (network, tx_hash, event_key, to_address) DO NOTHING RETURNING id`);
          if ((((ins as any).rows ?? ins) as unknown[]).length) stored++;
        }
      }
    } catch (e) {
      // Not acknowledged, so Alchemy retries; the dedupe key makes a retry safe.
      appLog().error({ reason: typeof (e as any)?.code === "string" ? (e as any).code : "unknown" }, "alchemy_webhook_store_failed");
      return reply.status(500).send({ error: "Could not store that." });
    }
    return { ok: true, stored };
  });
}
