import { ensure, EvmError } from "./errors";
import { assertRpcChain, type EvmNetwork } from "./networks";

/**
 * Read-only JSON-RPC client for one network, with ordered fallback providers.
 * Every provider's eth_chainId is verified before anything it says is used, a
 * provider is only trusted for this network, and responses are parsed strictly
 * (hex quantities only). Transport is injected so each platform uses its own
 * fetch and the tests need no network.
 */
export type Transport = (url: string, body: string, signal: AbortSignal) => Promise<{ ok: boolean; status: number; text(): Promise<string> }>;

export interface AccountSnapshot {
  readonly networkId: string;
  readonly address: `0x${string}`;
  readonly balanceWei: bigint;
  /** Nonce including the sender's own pending transactions. */
  readonly pendingNonce: number;
  /** Nonce counting only mined transactions. */
  readonly minedNonce: number;
  readonly blockNumber: bigint;
  readonly provider: string;
}

const QUANTITY = /^0x(0|[1-9a-f][0-9a-f]*)$/;
const HASH = /^0x[0-9a-f]{64}$/;

function quantity(value: unknown): bigint {
  ensure(typeof value === "string" && QUANTITY.test(value), "EVM_RPC_MALFORMED");
  return BigInt(value);
}
const safeNumber = (value: unknown) => { const n = quantity(value); ensure(n <= BigInt(Number.MAX_SAFE_INTEGER), "EVM_RPC_MALFORMED"); return Number(n); };

export class EvmRpcReader {
  private verified = new Set<string>();
  private id = 0;
  private readonly network: EvmNetwork;
  private readonly urls: readonly string[];
  private readonly transport: Transport;
  private readonly timeoutMs: number;
  constructor(network: EvmNetwork, urls: readonly string[], transport: Transport, timeoutMs = 8000) {
    this.network = network; this.urls = urls; this.transport = transport; this.timeoutMs = timeoutMs;
    ensure(urls.length >= 1 && urls.length <= 3 && new Set(urls).size === urls.length, "EVM_RPC_CONFIG");
    for (const raw of urls) {
      let url: URL;
      try { url = new URL(raw); } catch { throw new EvmError("EVM_RPC_CONFIG"); }
      ensure(url.protocol === "https:" && !url.username && !url.password && !url.hash, "EVM_RPC_CONFIG");
    }
  }

  private async call(url: string, method: string, params: unknown[]): Promise<unknown> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.transport(url, JSON.stringify({ jsonrpc: "2.0", id: ++this.id, method, params }), controller.signal);
      ensure(response.ok, "EVM_RPC_UNAVAILABLE");
      const text = await response.text();
      ensure(text.length <= 1_000_000, "EVM_RPC_MALFORMED");
      let body: { result?: unknown; error?: unknown };
      try { body = JSON.parse(text); } catch { throw new EvmError("EVM_RPC_MALFORMED", true); }
      ensure(body && typeof body === "object" && !("error" in body && body.error), "EVM_RPC_ERROR");
      return body.result;
    } catch (error) {
      if (error instanceof EvmError) throw error;
      throw new EvmError("EVM_RPC_UNAVAILABLE", true);
    } finally { clearTimeout(timer); }
  }

  /** Runs `work` on the first provider that is reachable and on the right chain. */
  private async withProvider<T>(work: (url: string) => Promise<T>): Promise<T> {
    let wrongChain = false;
    for (const url of this.urls) {
      try {
        if (!this.verified.has(url)) {
          assertRpcChain(this.network, quantity(await this.call(url, "eth_chainId", [])));
          this.verified.add(url);
        }
        return await work(url);
      } catch (error) {
        // A provider on the wrong chain is never retried for this reader.
        if (error instanceof EvmError && error.code === "EVM_RPC_WRONG_CHAIN") wrongChain = true;
        if (error instanceof EvmError && !error.retryable && error.code !== "EVM_RPC_UNAVAILABLE" && error.code !== "EVM_RPC_WRONG_CHAIN") throw error;
      }
    }
    throw new EvmError(wrongChain ? "EVM_RPC_WRONG_CHAIN" : "EVM_RPC_UNAVAILABLE", !wrongChain);
  }

  async account(address: `0x${string}`): Promise<AccountSnapshot> {
    return this.withProvider(async (url) => {
      // Pin every read to one block so balance and nonces are consistent.
      const blockNumber = quantity(await this.call(url, "eth_blockNumber", []));
      const tag = `0x${blockNumber.toString(16)}`;
      const [balance, mined, pending] = await Promise.all([
        this.call(url, "eth_getBalance", [address, tag]),
        this.call(url, "eth_getTransactionCount", [address, tag]),
        this.call(url, "eth_getTransactionCount", [address, "pending"]),
      ]);
      const minedNonce = safeNumber(mined), pendingNonce = safeNumber(pending);
      ensure(pendingNonce >= minedNonce, "EVM_RPC_INCONSISTENT");
      return { networkId: this.network.id, address, balanceWei: quantity(balance), minedNonce, pendingNonce, blockNumber, provider: new URL(url).host };
    });
  }

  async fees(): Promise<{ baseFeeWei: bigint; priorityFeeWei: bigint }> {
    return this.withProvider(async (url) => {
      const block = await this.call(url, "eth_getBlockByNumber", ["latest", false]) as { baseFeePerGas?: unknown } | null;
      ensure(block && typeof block === "object", "EVM_RPC_MALFORMED");
      const baseFeeWei = quantity(block.baseFeePerGas);
      const priorityFeeWei = quantity(await this.call(url, "eth_maxPriorityFeePerGas", []));
      return { baseFeeWei, priorityFeeWei };
    });
  }

  /**
   * eth_estimateGas for a plain transfer of `valueWei` from `from` to `to`. The
   * value matters: sending value to an address that does not exist yet costs
   * more. A provider error (for example insufficient funds) is reported as
   * EVM_GAS_ESTIMATE_FAILED so the caller refuses rather than guesses.
   */
  async estimateTransferGas(from: `0x${string}`, to: `0x${string}`, valueWei: bigint): Promise<bigint> {
    ensure(valueWei >= 0n, "EVM_AMOUNT_NEGATIVE");
    return this.withProvider(async (url) => {
      let result: unknown;
      try {
        result = await this.call(url, "eth_estimateGas", [{ from, to, value: `0x${valueWei.toString(16)}` }]);
      } catch (error) {
        if (error instanceof EvmError && error.code === "EVM_RPC_ERROR") throw new EvmError("EVM_GAS_ESTIMATE_FAILED");
        throw error;
      }
      return quantity(result);
    });
  }

  /** Transaction by hash, or null when the provider does not know it. */
  async transaction(hash: `0x${string}`): Promise<{ blockNumber: bigint | null } | null> {
    ensure(HASH.test(hash), "EVM_HASH_INVALID");
    return this.withProvider(async (url) => {
      const tx = await this.call(url, "eth_getTransactionByHash", [hash]) as { hash?: unknown; blockNumber?: unknown } | null;
      if (tx === null) return null;
      ensure(tx && typeof tx === "object" && tx.hash === hash, "EVM_RPC_MALFORMED");
      return { blockNumber: tx.blockNumber == null ? null : quantity(tx.blockNumber) };
    });
  }

  /** Receipt by hash, or null while not included. */
  async receipt(hash: `0x${string}`): Promise<{ status: "success" | "reverted"; blockNumber: bigint } | null> {
    ensure(HASH.test(hash), "EVM_HASH_INVALID");
    return this.withProvider(async (url) => {
      const receipt = await this.call(url, "eth_getTransactionReceipt", [hash]) as { transactionHash?: unknown; status?: unknown; blockNumber?: unknown } | null;
      if (receipt === null) return null;
      ensure(receipt && typeof receipt === "object" && receipt.transactionHash === hash && (receipt.status === "0x1" || receipt.status === "0x0"), "EVM_RPC_MALFORMED");
      return { status: receipt.status === "0x1" ? "success" : "reverted", blockNumber: quantity(receipt.blockNumber) };
    });
  }

  /**
   * Broadcast signed bytes. The returned hash must equal the one computed locally.
   * Any failure here (including "already known" on a rebroadcast) leaves the
   * outcome uncertain: callers keep the transfer in `broadcast` and resolve it
   * through lookups and `classify`, never by signing again with a new nonce.
   */
  async broadcast(rawTransaction: `0x${string}`, expectedHash: `0x${string}`): Promise<void> {
    await this.withProvider(async (url) => {
      const result = await this.call(url, "eth_sendRawTransaction", [rawTransaction]);
      ensure(typeof result === "string" && HASH.test(result) && result === expectedHash.toLowerCase(), "EVM_RPC_HASH_MISMATCH");
    });
  }
}
