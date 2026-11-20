import { Asset, BASE_FEE, Keypair, Operation, TransactionBuilder, type Account } from "@stellar/stellar-sdk";
import { stroopsToXlm } from "./errors";

/**
 * The only code that holds the treasury key. Everything it returns is plain data; it never throws a message that
 * contains the key, the request or the response body (callers log a short code only).
 */
export type Submission = { accepted: true } | { accepted: false; code: string };
export interface StellarRail {
  readonly treasuryAddress: string;
  treasuryStroops(): Promise<bigint>;
  /** exists=false for an account Horizon has never seen. Throws when Horizon cannot answer. */
  account(address: string): Promise<{ exists: boolean; stroops: bigint }>;
  /** Builds and signs one createAccount. The hash is known before anything is sent. */
  build(destination: string, stroops: bigint, nowSeconds: number): Promise<{ hash: string; envelope: string; maxTime: number }>;
  /**
   * Builds and signs one XLM payment to an existing account, or a createAccount when `create` is set (fee sweeps).
   * Optional: only rails that pay fees out implement it.
   */
  buildPayment?(destination: string, stroops: bigint, nowSeconds: number, create: boolean): Promise<{ hash: string; envelope: string; maxTime: number }>;
  /** A definitive Horizon verdict is returned. An unknown outcome (timeout, 5xx, no response) throws. */
  submit(envelope: string): Promise<Submission>;
  lookup(hash: string): Promise<"missing" | "success" | "failed">;
  /** Unix seconds at which the newest ledger Horizon has ingested closed. Horizon lag shows up as a stale value. */
  ledgerClosedAt(): Promise<number>;
}

export interface HorizonLike {
  loadAccount(id: string): Promise<Account & { balances?: { asset_type: string; balance: string }[] }>;
  submitTransaction(tx: any): Promise<unknown>;
  transactions(): { transaction(hash: string): { call(): Promise<{ successful: boolean }> } };
  ledgers(): { order(direction: "asc" | "desc"): { limit(n: number): { call(): Promise<{ records: { closed_at: string }[] }> } } };
}

export const TX_VALID_SECONDS = 120;
const toStroops = (decimal: string): bigint => { const [w, f = ""] = decimal.split("."); return BigInt(w) * 10_000_000n + BigInt(f.padEnd(7, "0").slice(0, 7)); };
const statusOf = (e: any): number | undefined => e?.response?.status ?? (typeof e?.status === "number" ? e.status : undefined);
const notFound = (e: any) => statusOf(e) === 404 || e?.name === "NotFoundError";

// Horizon result codes that mean "this transaction was not and will not be included".
const DEFINITIVE: Record<string, string> = {
  tx_bad_seq: "bad-seq", tx_too_late: "too-late", tx_too_early: "too-early", tx_insufficient_fee: "fee", tx_insufficient_balance: "treasury-underfunded",
  op_already_exists: "already-exists", op_underfunded: "treasury-underfunded", op_low_reserve: "low-reserve", tx_failed: "rejected", tx_bad_auth: "rejected",
};

export function horizonRail(server: HorizonLike, secret: string, networkPassphrase: string): StellarRail {
  const keypair = Keypair.fromSecret(secret);
  const treasuryAddress = keypair.publicKey();
  const native = (a: { balances?: { asset_type: string; balance: string }[] }) => toStroops(a.balances?.find((b) => b.asset_type === "native")?.balance ?? "0");
  return {
    treasuryAddress,
    async treasuryStroops() { return native(await server.loadAccount(treasuryAddress)); },
    async account(address) {
      try { return { exists: true, stroops: native(await server.loadAccount(address)) }; }
      catch (e) { if (notFound(e)) return { exists: false, stroops: 0n }; throw e; }
    },
    async build(destination, stroops, nowSeconds) {
      const source = await server.loadAccount(treasuryAddress);
      const maxTime = nowSeconds + TX_VALID_SECONDS;
      const tx = new TransactionBuilder(source, { fee: BASE_FEE, networkPassphrase })
        .addOperation(Operation.createAccount({ destination, startingBalance: stroopsToXlm(stroops) }))
        .setTimebounds(0, maxTime).build();
      tx.sign(keypair);
      return { hash: tx.hash().toString("hex"), envelope: tx.toXDR(), maxTime };
    },
    async buildPayment(destination, stroops, nowSeconds, create) {
      const source = await server.loadAccount(treasuryAddress);
      const maxTime = nowSeconds + TX_VALID_SECONDS;
      const amount = stroopsToXlm(stroops);
      const op = create
        ? Operation.createAccount({ destination, startingBalance: amount })
        : Operation.payment({ destination, asset: Asset.native(), amount });
      const tx = new TransactionBuilder(source, { fee: BASE_FEE, networkPassphrase }).addOperation(op).setTimebounds(0, maxTime).build();
      tx.sign(keypair);
      return { hash: tx.hash().toString("hex"), envelope: tx.toXDR(), maxTime };
    },
    async submit(envelope) {
      try { await server.submitTransaction(TransactionBuilder.fromXDR(envelope, networkPassphrase)); return { accepted: true }; }
      catch (e: any) {
        const codes = e?.response?.data?.extras?.result_codes;
        const status = statusOf(e);
        // 400 with result codes is Horizon refusing the transaction. Anything else (no response, 504, 5xx) leaves the outcome unknown.
        if (status === 400 && codes) {
          const wanted = [...(Array.isArray(codes.operations) ? codes.operations : []), codes.transaction].filter((c: unknown): c is string => typeof c === "string");
          const hit = wanted.map((c) => DEFINITIVE[c]).find(Boolean);
          return { accepted: false, code: hit ?? "rejected" };
        }
        throw e;
      }
    },
    async ledgerClosedAt() {
      const latest = (await server.ledgers().order("desc").limit(1).call()).records[0];
      const closed = latest ? Date.parse(latest.closed_at) / 1000 : NaN;
      if (!Number.isFinite(closed)) throw new Error("no ledger");
      return Math.floor(closed);
    },
    async lookup(hash) {
      try { return (await server.transactions().transaction(hash).call()).successful ? "success" : "failed"; }
      catch (e) { if (notFound(e)) return "missing"; throw e; }
    },
  };
}

/**
 * Start-up check, fail closed: the configured Horizon must serve the network activation is configured for. A mainnet treasury
 * must never be pointed at a testnet Horizon (or the reverse). Nothing about the response is put in the error.
 */
export async function assertHorizonNetwork(horizonUrl: string, networkPassphrase: string, fetchFn: typeof fetch = fetch): Promise<void> {
  let served: unknown;
  try {
    const res = await fetchFn(`${horizonUrl.replace(/\/+$/, "")}/`, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(10_000) });
    if (!res.ok) throw new Error("status");
    served = ((await res.json()) as { network_passphrase?: unknown }).network_passphrase;
  } catch { throw new Error("Task activation could not confirm which Stellar network HORIZON_URL serves; refusing to start."); }
  if (served !== networkPassphrase) throw new Error("HORIZON_URL serves a different Stellar network than task activation is configured for; refusing to start.");
}
