import type { FastifyInstance } from "fastify";
import { and, eq, sql } from "drizzle-orm";
import { createPublicClient, getAddress, http, isAddress, keccak256, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { mainnet, sepolia } from "viem/chains";
import { db, schema } from "../db";
import { authMiddleware } from "../middleware/auth";
import { appLog } from "../lib/app-log";
import { auditLogStrict } from "../lib/audit";
import { oneAtATime } from "../lib/custody-lock";
import { checkCustodyPasswordOnly, type Refusal } from "../lib/custody-sign";
import { custodyPreflight } from "../lib/custody-preflight";
import { CustodyRefused, withDelegatedKey } from "../lib/custody-signer";
import { CUSTODY_NOT_AVAILABLE, custodyAllowedForUser, custodyFlagsFromEnv, type CustodyFlags } from "../lib/custody-flags";
import { checkEvmLimits, custodyLimitsFromEnv, type CustodyLimits } from "../lib/custody-limits";
import { custodyNetworks, networksFor } from "../lib/custody-networks";
import { masterKeyProviderFromEnv, type MasterKeyProvider } from "../lib/key-wrapper";
import { alchemyUrlFromEnv, ethDataFlagsFromEnv, type FetchLike } from "../lib/alchemy";
import { INSUFFICIENT_FUNDS, SEND_MOVES_MORE, simulateEthSend, type SimTx, simulationConfigProblem, simulationUnsupported, unexpectedChanges, type SimResult } from "../lib/eth-simulate";
import { AlchemyError } from "../lib/alchemy";

/**
 * Server send of Sepolia ETH (or Ethereum mainnet ETH in MAINNET_CUSTODY mode) from Amma-held wallets, behind CUSTODY_SERVER_SIGNING.
 * The transaction is signed offline with the wallet's derived key, stored, then broadcast.
 */
export interface EvmClient {
  getChainId(): Promise<number>;
  getBalance(address: string): Promise<bigint>;
  getTransactionCount(address: string): Promise<number>;
  estimateGas(a: { account: string; to: string; value: bigint }): Promise<bigint>;
  estimateFeesPerGas(): Promise<{ maxFeePerGas: bigint; maxPriorityFeePerGas: bigint }>;
  sendRawTransaction(raw: Hex): Promise<string>;
  getTransactionReceipt(hash: string): Promise<{ status: "success" | "reverted"; blockNumber: bigint } | null>;
  getBlockNumber(): Promise<bigint>;
}

export interface CustodyEvmSendOptions {
  provider?: MasterKeyProvider | null;
  flags?: CustodyFlags;
  limits?: () => CustodyLimits;
  /** The RPC client, or null when no RPC is configured. Default: viem against CUSTODY_SEPOLIA_RPC_URL, else WELCOME_SEPOLIA_RPC_URL; on mainnet only CUSTODY_ETH_RPC_URL. */
  client?: () => EvmClient | null;
  /** Optional pre-send simulation (ETH_SEND_SIMULATE=on). Return null to skip. Default: eth_simulateV1 (traceTransfers) at the server RPC. */
  simulate?: ((tx: { from: string; to: string; value: bigint; gas?: bigint; maxFeePerGas?: bigint; maxPriorityFeePerGas?: bigint }) => Promise<SimResult>) | null;
  fetch?: FetchLike;
}

const CONFIRMATIONS = 2n;
const ZERO = "0x0000000000000000000000000000000000000000";
const SENT = sql`('signed','broadcast','confirmed')`;
const SIGNED_UNKNOWN = "The payment was signed but could not be confirmed as sent. Check the transfer list before trying again.";
const rowsOf = <T,>(r: any): T[] => (r?.rows ?? r) as T[];

class Refused extends Error { constructor(public status: number, message: string) { super(message); } }

export function evmClientFromEnv(env: Record<string, string | undefined> = process.env): EvmClient | null {
  // Mainnet custody mode needs its own RPC: the Sepolia settings are never used for it.
  const onMainnet = custodyNetworks(env).mainnet;
  const url = onMainnet ? env.CUSTODY_ETH_RPC_URL : env.CUSTODY_SEPOLIA_RPC_URL || env.WELCOME_SEPOLIA_RPC_URL;
  if (!url) return null;
  const pub = createPublicClient({ chain: onMainnet ? mainnet : sepolia, transport: http(url) });
  return {
    getChainId: () => pub.getChainId(),
    getBalance: (address) => pub.getBalance({ address: address as Hex }),
    getTransactionCount: (address) => pub.getTransactionCount({ address: address as Hex, blockTag: "pending" }),
    estimateGas: (a) => pub.estimateGas({ account: a.account as Hex, to: a.to as Hex, value: a.value }),
    estimateFeesPerGas: () => pub.estimateFeesPerGas(),
    sendRawTransaction: (serializedTransaction) => pub.sendRawTransaction({ serializedTransaction }),
    getTransactionReceipt: async (hash) => {
      try { const r = await pub.getTransactionReceipt({ hash: hash as Hex }); return { status: r.status, blockNumber: r.blockNumber }; }
      catch (e) { if ((e as Error)?.name === "TransactionReceiptNotFoundError") return null; throw e; }
    },
    getBlockNumber: () => pub.getBlockNumber(),
  };
}

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const addr = (v: unknown, what: string): string => {
  if (typeof v !== "string" || !ADDRESS.test(v) || !isAddress(v)) throw new Refused(400, `The ${what} address is not valid.`);
  return v;
};

function parseBody(raw: unknown) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Refused(400, "That request is not valid.");
  const b = raw as Record<string, unknown>;
  const allowed = new Set(["from", "to", "amountWei", "password", "idempotencyKey"]);
  if (Object.keys(b).some((k) => !allowed.has(k)) || [...allowed].some((k) => !(k in b))) throw new Refused(400, "That request is not valid.");
  const from = addr(b.from, "sending"), to = addr(b.to, "destination");
  if (typeof b.amountWei !== "string" || !/^[1-9][0-9]{0,40}$/.test(b.amountWei)) throw new Refused(400, "The amount must be a whole number of wei more than 0.");
  if (typeof b.password !== "string" || b.password.length < 1 || b.password.length > 256) throw new Refused(400, "A password is required.");
  if (typeof b.idempotencyKey !== "string" || !/^[A-Za-z0-9_-]{8,100}$/.test(b.idempotencyKey)) throw new Refused(400, "The idempotency key must be 8 to 100 letters, digits, dashes or underscores.");
  if (to.toLowerCase() === ZERO) throw new Refused(400, "That destination address can't receive payments.");
  if (to.toLowerCase() === from.toLowerCase()) throw new Refused(400, "You can't send to the same wallet.");
  return { from, to, amountWei: BigInt(b.amountWei), password: b.password, idempotencyKey: b.idempotencyKey };
}

const plainError = (cause: unknown): { status: number; error: string } => {
  if (cause instanceof Refused) return { status: cause.status, error: cause.message };
  if (cause instanceof CustodyRefused) {
    switch (cause.code) {
      case "off": return { status: 503, error: "Sending from Amma-held wallets is not switched on here." };
      case "self": return { status: 403, error: "Delegated signing is not enabled." };
      case "frozen": return { status: 423, error: "This account is frozen while a recovery request is waiting." };
      case "not-allowed": return { status: 403, error: CUSTODY_NOT_AVAILABLE };
      default: return { status: 409, error: "Amma can't sign for this wallet. Use your wallet passphrase." };
    }
  }
  appLog().error({ reason: typeof (cause as any)?.code === "string" ? (cause as any).code : "unknown" }, "custody_send_evm_failed");
  return { status: 503, error: "The payment could not be completed right now. Nothing was lost; try again." };
};

type Transfer = { id: string | number; from_address: string; to_address: string; value_wei: string; nonce: number; hash: string; state: string; created_at: Date | string; updated_at: Date | string };
const out = (r: Transfer) => ({ id: String(r.id), from: r.from_address, to: r.to_address, amountWei: r.value_wei, nonce: r.nonce, hash: r.hash, state: r.state,
  createdAt: new Date(r.created_at).toISOString(), updatedAt: new Date(r.updated_at).toISOString() });

/** A transfer that was signed but whose sending is not confirmed: the caller keeps its idempotency key and checks the list. */
const unknownOut = (r: Transfer) => ({ ...out(r), status: "unknown" as const, error: SIGNED_UNKNOWN });

export async function custodyEvmSendRoutes(app: FastifyInstance, opts: CustodyEvmSendOptions = {}) {
  const provider = opts.provider === undefined ? masterKeyProviderFromEnv() : opts.provider;
  const flags = opts.flags ?? custodyFlagsFromEnv();
  const networks = networksFor(flags);
  const parsedLimits = opts.limits ? null : custodyLimitsFromEnv();
  const limits = opts.limits ?? (() => parsedLimits!);
  const clientOf = opts.client ?? (() => evmClientFromEnv());
  const simulate = opts.simulate !== undefined ? opts.simulate : ethDataFlagsFromEnv().sendSimulate ? (tx: SimTx) => {
    const url = alchemyUrlFromEnv();
    const problem = simulationConfigProblem(process.env, url);
    if (problem || !url) throw new AlchemyError(problem ?? "no_rpc");
    return simulateEthSend(url, tx, opts.fetch);
  } : null;
  // The guard fails open (a broken check must not stop every send), so a misconfiguration is announced once, loudly, at start-up.
  if (opts.simulate === undefined && ethDataFlagsFromEnv().sendSimulate) {
    const problem = simulationConfigProblem(process.env, alchemyUrlFromEnv());
    if (problem) appLog().warn({ reason: problem }, "ETH_SEND_SIMULATE is on but the simulation cannot run (needs an https Alchemy RPC URL in CUSTODY_ETH_RPC_URL / CUSTODY_SEPOLIA_RPC_URL); sends will go ahead WITHOUT the simulation guard");
    else {
      const url = alchemyUrlFromEnv();
      if (url) void simulationUnsupported(url, opts.fetch).then((no) => { if (no) appLog().warn({ reason: "rpc_unsupported" }, "ETH_SEND_SIMULATE is on but simulation not available on this RPC plan; sends will go ahead WITHOUT the simulation guard"); });
    }
  }

  /** What this user has already used in the last 24 hours across every Amma wallet on this chain (value plus the fee ceiling), and whether `to` is a known recipient. */
  async function usage(userId: number, to: string, exceptKey: string) {
    const [{ sent }] = rowsOf<{ sent: string }>(await db.execute(sql`SELECT COALESCE(SUM(value_wei::numeric + max_fee_wei::numeric), 0)::text AS sent FROM custody_evm_transfers
      WHERE user_id = ${userId} AND state IN ${SENT} AND created_at > now() - interval '24 hours' AND idempotency_key <> ${exceptKey}`));
    const [{ paid }] = rowsOf<{ paid: boolean }>(await db.execute(sql`SELECT EXISTS (SELECT 1 FROM custody_evm_transfers
      WHERE user_id = ${userId} AND to_address = ${to.toLowerCase()} AND state IN ${SENT}) AS paid`));
    return { sent: BigInt(sent), newRecipient: !paid };
  }

  app.post("/api/v1/custody/evm/send", {
    preHandler: authMiddleware,
    bodyLimit: 4096,
    config: { rateLimit: { max: 10, timeWindow: "1 minute" } },
  }, async (request, reply) => {
    reply.header("Cache-Control", "no-store");
    const userId = request.user!.userId;
    const ctx = { ip: request.ip, userAgent: request.headers["user-agent"] };
    // Set once the transfer is signed, stored and recorded: any later failure is "outcome unknown", never "nothing was lost".
    let signedRow: Transfer | undefined;
    try {
      if (!flags.serverSigning || !provider) throw new CustodyRefused("off", "off");
      if (!custodyAllowedForUser(flags, userId)) throw new CustodyRefused("not-allowed", CUSTODY_NOT_AVAILABLE);
      const client = clientOf();
      if (!client) throw new Refused(503, "Ethereum sending is not set up here yet.");
      const body = parseBody(request.body);
      const from = body.from.toLowerCase(), to = body.to.toLowerCase();
      return await oneAtATime(userId, async () => {
        const denied: Refusal | null = await checkCustodyPasswordOnly({ provider, flags, userId, password: body.password, ...ctx }, "evm");
        if (denied) throw new Refused(denied.status, denied.error);
        const notReady = await custodyPreflight({ userId, chain: "evm", from, networks, flags });
        if (notReady) throw new Refused(notReady.status, notReady.error);

        // A retry of a send this user already made returns that transfer; nothing is signed twice.
        const [existing] = rowsOf<Transfer>(await db.execute(sql`SELECT * FROM custody_evm_transfers WHERE user_id = ${userId} AND idempotency_key = ${body.idempotencyKey}`));
        if (existing) {
          if (existing.from_address !== from || existing.to_address !== to || existing.value_wei !== body.amountWei.toString()) throw new Refused(409, "That idempotency key was already used for a different payment.");
          return existing.state === "signed" ? reply.status(202).send(unknownOut(existing)) : reply.status(200).send(out(existing));
        }

        // The chain check comes before anything is signed.
        if ((await client.getChainId()) !== networks.evmChainId) throw new Refused(503, networks.mainnet ? "The Ethereum connection is not on Ethereum mainnet, so nothing was sent." : "The Ethereum connection is not on Sepolia, so nothing was sent.");
        const [nonce, gas, fees, balance] = await Promise.all([
          client.getTransactionCount(from), client.estimateGas({ account: from, to, value: body.amountWei }), client.estimateFeesPerGas(), client.getBalance(from)]);
        if (fees.maxFeePerGas > limits().evmMaxFeeWei || fees.maxPriorityFeePerGas > limits().evmMaxFeeWei) throw new Refused(503, "Ethereum network fees are unusually high right now, so nothing was sent. Try again later.");
        const feeCeiling = gas * fees.maxFeePerGas;
        if (balance < body.amountWei + feeCeiling) throw new Refused(400, "Not enough ETH in this wallet to cover the amount and the network fee.");

        // Optional guard: the simulation must show only the ETH going to the recipient. If the check itself cannot run, the send is not blocked by it.
        if (simulate) {
          let sim: SimResult | null = null;
          try { sim = await simulate({ from, to, value: body.amountWei, gas, maxFeePerGas: fees.maxFeePerGas, maxPriorityFeePerGas: fees.maxPriorityFeePerGas }); }
          catch (e) {
            if ((e as any)?.code === INSUFFICIENT_FUNDS) { appLog().warn({ reason: INSUFFICIENT_FUNDS }, "custody_send_evm_simulation_refused"); throw new Refused(400, "Not enough ETH in this wallet to cover the amount and the network fee."); }
            appLog().warn({ reason: typeof (e as any)?.code === "string" ? (e as any).code : "unknown" }, "custody_send_evm_simulation_unavailable"); }
          if (sim?.error) throw new Refused(400, "This transaction would not go through. It was not sent.");
          if (sim && unexpectedChanges(sim, { to, value: body.amountWei }).outgoing.length) throw new Refused(400, SEND_MOVES_MORE);
        }

        const refuseIfOver = async (q: { sent: bigint; newRecipient: boolean }) => {
          const limit = checkEvmLimits(limits(), { amount: body.amountWei + feeCeiling, sentToday: q.sent, newRecipient: q.newRecipient });
          if (!limit) return;
          await auditLogStrict("custody_limit_refused", { userId, ip: ctx.ip, userAgent: ctx.userAgent, detail: { chain: "evm", limit: limit.limit, amountWei: body.amountWei.toString(), from } });
          throw new Refused(limit.status, limit.error);
        };
        await refuseIfOver(await usage(userId, to, body.idempotencyKey));

        const raw = await withDelegatedKey({ provider, flags, userId, chain: "evm", expectedAddress: from, reason: "custody-send:evm", ...ctx }, async ({ evmPrivateKey }) => {
          const account = privateKeyToAccount(evmPrivateKey!);
          return account.signTransaction({ type: "eip1559", chainId: networks.evmChainId, to: getAddress(to), value: body.amountWei, nonce, gas,
            maxFeePerGas: fees.maxFeePerGas, maxPriorityFeePerGas: fees.maxPriorityFeePerGas });
        });
        const hash = keccak256(raw);

        // Reserve the budget and store the transfer under a per-user database lock: the check and the insert cannot interleave with another send.
        const stored = await db.transaction(async (tx) => {
          await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext('custody-send'), ${userId})`);
          const u = rowsOf<{ sent: string; paid: boolean }>(await tx.execute(sql`SELECT
            (SELECT COALESCE(SUM(value_wei::numeric + max_fee_wei::numeric), 0)::text FROM custody_evm_transfers WHERE user_id = ${userId} AND state IN ${SENT} AND created_at > now() - interval '24 hours') AS sent,
            EXISTS (SELECT 1 FROM custody_evm_transfers WHERE user_id = ${userId} AND to_address = ${to} AND state IN ${SENT}) AS paid`))[0];
          const limit = checkEvmLimits(limits(), { amount: body.amountWei + feeCeiling, sentToday: BigInt(u.sent), newRecipient: !u.paid });
          if (limit) return { limit };
          const [row] = rowsOf<Transfer>(await tx.execute(sql`INSERT INTO custody_evm_transfers (user_id, from_address, to_address, value_wei, max_fee_wei, nonce, hash, state, idempotency_key)
            VALUES (${userId}, ${from}, ${to}, ${body.amountWei.toString()}, ${feeCeiling.toString()}, ${nonce}, ${hash}, 'signed', ${body.idempotencyKey}) RETURNING *`));
          return { row };
        });
        if ("limit" in stored && stored.limit) {
          await auditLogStrict("custody_limit_refused", { userId, ip: ctx.ip, userAgent: ctx.userAgent, detail: { chain: "evm", limit: stored.limit.limit, amountWei: body.amountWei.toString(), from } });
          throw new Refused(stored.limit.status, stored.limit.error);
        }
        const row = stored.row!;

        // Recorded before it leaves this server; if the record cannot be written, nothing is broadcast.
        try {
          await auditLogStrict("custody_send", { userId, ip: ctx.ip, userAgent: ctx.userAgent, detail: { chain: "evm", from, to, amountWei: body.amountWei.toString(), hash } });
        } catch (e) {
          await db.execute(sql`UPDATE custody_evm_transfers SET state = 'failed', updated_at = now() WHERE id = ${row.id}`);
          throw e;
        }
        signedRow = row;
        try { await client.sendRawTransaction(raw); }
        catch (e) {
          appLog().warn({ reason: typeof (e as any)?.code === "string" ? (e as any).code : "unknown", hash }, "custody_send_evm_broadcast_unconfirmed");
          return reply.status(202).send(unknownOut(row));
        }
        const [sent] = rowsOf<Transfer>(await db.execute(sql`UPDATE custody_evm_transfers SET state = 'broadcast', updated_at = now() WHERE id = ${row.id} RETURNING *`));
        return reply.status(200).send(out(sent));
      });
    } catch (cause) {
      if (signedRow) {
        appLog().warn({ reason: typeof (cause as any)?.code === "string" ? (cause as any).code : "unknown", hash: signedRow.hash }, "custody_send_evm_outcome_unknown");
        return reply.status(202).send(unknownOut(signedRow));
      }
      const { status, error } = plainError(cause);
      return reply.status(status).send({ error });
    }
  });

  app.get("/api/v1/custody/evm/transfers", { preHandler: authMiddleware, config: { rateLimit: { max: 60, timeWindow: "1 minute" } } }, async (request, reply) => {
    reply.header("Cache-Control", "no-store");
    const userId = request.user!.userId;
    try {
      if (!custodyAllowedForUser(flags, userId)) throw new Refused(403, CUSTODY_NOT_AVAILABLE);
      const fromRaw = (request.query as { from?: unknown } | undefined)?.from;
      const from = addr(fromRaw, "wallet").toLowerCase();
      const [wallet] = await db.select({ id: schema.userWallets.id }).from(schema.userWallets).where(and(
        eq(schema.userWallets.userId, userId), eq(schema.userWallets.chain, "evm"), eq(schema.userWallets.network, networks.evm), sql`lower(${schema.userWallets.publicKey}) = ${from}`)).limit(1);
      if (!wallet) throw new Refused(403, "That is not one of your Ethereum wallets.");
      const client = clientOf();
      const open = rowsOf<Transfer>(await db.execute(sql`SELECT * FROM custody_evm_transfers WHERE user_id = ${userId} AND from_address = ${from} AND state IN ('signed','broadcast') ORDER BY id LIMIT 20`));
      if (client && open.length) {
        try {
          const latest = await client.getBlockNumber();
          for (const t of open) {
            try {
              const receipt = await client.getTransactionReceipt(t.hash);
              if (!receipt) continue;
              const next = receipt.status === "reverted" ? "failed" : latest - receipt.blockNumber + 1n >= CONFIRMATIONS ? "confirmed" : null;
              if (next) await db.execute(sql`UPDATE custody_evm_transfers SET state = ${next}, updated_at = now() WHERE id = ${t.id} AND state IN ('signed','broadcast')`);
            } catch (e) { appLog().warn({ reason: typeof (e as any)?.code === "string" ? (e as any).code : "unknown" }, "custody_evm_receipt_failed"); }
          }
        } catch (e) { appLog().warn({ reason: typeof (e as any)?.code === "string" ? (e as any).code : "unknown" }, "custody_evm_refresh_failed"); }
      }
      // A confirmed transfer used its nonce: other transfers with that nonce from this wallet can never be mined, so they stop counting.
      await db.execute(sql`UPDATE custody_evm_transfers t SET state = 'failed', updated_at = now() WHERE t.user_id = ${userId} AND t.from_address = ${from} AND t.state IN ('signed','broadcast')
        AND EXISTS (SELECT 1 FROM custody_evm_transfers c WHERE c.from_address = t.from_address AND c.nonce = t.nonce AND c.state = 'confirmed' AND c.id <> t.id)`);
      const rows = rowsOf<Transfer>(await db.execute(sql`SELECT * FROM custody_evm_transfers WHERE user_id = ${userId} AND from_address = ${from} ORDER BY id DESC LIMIT 50`));
      return { transfers: rows.map(out) };
    } catch (cause) {
      const { status, error } = plainError(cause);
      return reply.status(status).send({ error });
    }
  });
}
