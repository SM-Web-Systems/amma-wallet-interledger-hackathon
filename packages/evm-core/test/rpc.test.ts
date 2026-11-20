import { describe, expect, it } from "vitest";
import { EvmError, EvmRpcReader, NETWORKS, type Transport } from "../src";

const SEPOLIA = NETWORKS["ethereum-sepolia"];
const ADDRESS = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266" as const;
type Handler = (method: string, params: unknown[]) => unknown;

function fake(handlers: Record<string, Handler | "down">): Transport & { calls: string[] } {
  const calls: string[] = [];
  const transport = (async (url: string, body: string) => {
    const { id, method, params } = JSON.parse(body);
    calls.push(`${new URL(url).host} ${method}`);
    const handler = handlers[url];
    if (!handler || handler === "down") throw new Error("ECONNREFUSED");
    const result = handler(method, params);
    return { ok: true, status: 200, text: async () => JSON.stringify(result instanceof Error ? { jsonrpc: "2.0", id, error: { code: -32000, message: result.message } } : { jsonrpc: "2.0", id, result }) };
  }) as unknown as Transport & { calls: string[] };
  transport.calls = calls;
  return transport;
}
const sepolia: Handler = (method, params) => ({
  eth_chainId: "0xaa36a7", eth_blockNumber: "0x10", eth_getBalance: "0xde0b6b3a7640000",
  eth_getTransactionCount: params[1] === "pending" ? "0x8" : "0x7",
  eth_getBlockByNumber: { baseFeePerGas: "0x3b9aca00" }, eth_maxPriorityFeePerGas: "0x5f5e100",
  eth_sendRawTransaction: "0x" + "ab".repeat(32), eth_estimateGas: "0x32a1f",
}[method]);
const code = async (p: Promise<unknown>) => p.then(() => "no error", (e) => (e as EvmError).code);

describe("EVM RPC reader", () => {
  it("estimates gas for the exact transfer and refuses on a provider error", async () => {
    let seen: unknown;
    const ok = fake({ "https://a.example/": (m, p) => { if (m === "eth_estimateGas") seen = p[0]; return sepolia(m, p); } });
    expect(await new EvmRpcReader(SEPOLIA, ["https://a.example/"], ok).estimateTransferGas(ADDRESS, ADDRESS, 10n ** 15n)).toBe(207_391n);
    expect(seen).toEqual({ from: ADDRESS, to: ADDRESS, value: "0x38d7ea4c68000" });
    const broke = fake({ "https://a.example/": (m, p) => m === "eth_estimateGas" ? new Error("insufficient funds") : sepolia(m, p) });
    expect(await code(new EvmRpcReader(SEPOLIA, ["https://a.example/"], broke).estimateTransferGas(ADDRESS, ADDRESS, 1n))).toBe("EVM_GAS_ESTIMATE_FAILED");
  });
  it("reads a consistent account snapshot pinned to one block", async () => {
    const transport = fake({ "https://a.example/": sepolia });
    const snapshot = await new EvmRpcReader(SEPOLIA, ["https://a.example/"], transport).account(ADDRESS);
    expect(snapshot).toMatchObject({ balanceWei: 10n ** 18n, minedNonce: 7, pendingNonce: 8, blockNumber: 16n, provider: "a.example" });
  });
  it("falls back past an unreachable provider and never uses one on the wrong chain", async () => {
    const mainnet: Handler = (m, p) => (m === "eth_chainId" ? "0x1" : sepolia(m, p));
    const transport = fake({ "https://down.example/": "down", "https://mainnet.example/": mainnet, "https://good.example/": sepolia });
    const reader = new EvmRpcReader(SEPOLIA, ["https://down.example/", "https://mainnet.example/", "https://good.example/"], transport);
    expect((await reader.account(ADDRESS)).provider).toBe("good.example");
    expect(transport.calls.filter((c) => c.startsWith("mainnet.example")).map((c) => c.split(" ")[1])).toEqual(["eth_chainId"]);
  });
  it("refuses when every provider reports another chain", async () => {
    const reader = new EvmRpcReader(SEPOLIA, ["https://m.example/"], fake({ "https://m.example/": (m, p) => (m === "eth_chainId" ? "0x1" : sepolia(m, p)) }));
    expect(await code(reader.account(ADDRESS))).toBe("EVM_RPC_WRONG_CHAIN");
  });
  it("rejects malformed quantities and inconsistent nonces", async () => {
    const decimal: Handler = (m, p) => (m === "eth_getBalance" ? "1000" : sepolia(m, p));
    expect(await code(new EvmRpcReader(SEPOLIA, ["https://a.example/"], fake({ "https://a.example/": decimal })).account(ADDRESS))).toBe("EVM_RPC_MALFORMED");
    const behind: Handler = (m, p) => (m === "eth_getTransactionCount" ? (p[1] === "pending" ? "0x6" : "0x7") : sepolia(m, p));
    expect(await code(new EvmRpcReader(SEPOLIA, ["https://a.example/"], fake({ "https://a.example/": behind })).account(ADDRESS))).toBe("EVM_RPC_INCONSISTENT");
  });
  it("reads fees and checks the broadcast hash", async () => {
    const reader = new EvmRpcReader(SEPOLIA, ["https://a.example/"], fake({ "https://a.example/": sepolia }));
    expect(await reader.fees()).toEqual({ baseFeeWei: 1_000_000_000n, priorityFeeWei: 100_000_000n });
    expect(await code(reader.broadcast("0x02", ("0x" + "ab".repeat(32)) as `0x${string}`))).toBe("no error");
    expect(await code(reader.broadcast("0x02", ("0x" + "cd".repeat(32)) as `0x${string}`))).toBe("EVM_RPC_HASH_MISMATCH");
  });
  it("surfaces a node error on broadcast as uncertain, not as success", async () => {
    const known: Handler = (m, p) => (m === "eth_sendRawTransaction" ? new Error("already known") : sepolia(m, p));
    const reader = new EvmRpcReader(SEPOLIA, ["https://a.example/"], fake({ "https://a.example/": known }));
    expect(await code(reader.broadcast("0x02", ("0x" + "ab".repeat(32)) as `0x${string}`))).toBe("EVM_RPC_ERROR");
  });
  it("parses transaction and receipt lookups strictly", async () => {
    const hash = ("0x" + "ab".repeat(32)) as `0x${string}`;
    const lookups: Handler = (m, p) => ({
      eth_getTransactionByHash: { hash, blockNumber: "0x10" },
      eth_getTransactionReceipt: { transactionHash: hash, status: "0x1", blockNumber: "0x10" },
    } as Record<string, unknown>)[m] ?? sepolia(m, p);
    const reader = new EvmRpcReader(SEPOLIA, ["https://a.example/"], fake({ "https://a.example/": lookups }));
    expect(await reader.transaction(hash)).toEqual({ blockNumber: 16n });
    expect(await reader.receipt(hash)).toEqual({ status: "success", blockNumber: 16n });
    const missing = new EvmRpcReader(SEPOLIA, ["https://a.example/"], fake({ "https://a.example/": (m, p) => (m.startsWith("eth_getTransaction") ? null : sepolia(m, p)) }));
    expect(await missing.transaction(hash)).toBeNull();
    expect(await missing.receipt(hash)).toBeNull();
    const other = new EvmRpcReader(SEPOLIA, ["https://a.example/"], fake({ "https://a.example/": (m, p) => (m === "eth_getTransactionReceipt" ? { transactionHash: "0x" + "cd".repeat(32), status: "0x1", blockNumber: "0x1" } : sepolia(m, p)) }));
    expect(await code(other.receipt(hash))).toBe("EVM_RPC_MALFORMED");
  });
  it("accepts only https provider URLs without credentials", () => {
    for (const bad of [["http://a.example/"], ["https://user:pw@a.example/"], ["not a url"], []]) {
      expect(() => new EvmRpcReader(SEPOLIA, bad, fake({}))).toThrow(EvmError);
    }
  });
});
