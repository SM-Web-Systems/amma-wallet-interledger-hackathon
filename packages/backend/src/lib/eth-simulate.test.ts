import { describe, expect, it, vi } from "vitest";
import live from "./__fixtures__/eth-simulate-v1-publicnode-sepolia.json";
import { simulateEthSend, simulationUnsupported, unexpectedChanges } from "./eth-simulate";
import type { FetchLike } from "./alchemy";
import { log, NATIVE_EMITTER_ERIGON, NATIVE_EMITTER_SPEC, approvalForAllLog, approvalLog, erc1155SingleLog, erc20Log, erc721Log, nativeLog, okCall, revertedCall, simResult } from "./eth-simulate.fixtures";

const ME = "0x1111111111111111111111111111111111111111", TO = "0x2222222222222222222222222222222222222222", EVIL = "0x3333333333333333333333333333333333333333";
const USDC = "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48";
const URL = "https://eth-mainnet.g.alchemy.com/v2/SECRETKEY123";
const tx = { from: ME, to: TO, value: 1n };
const respond = (result: unknown): FetchLike => async () => ({ ok: true, status: 200, json: async () => ({ jsonrpc: "2.0", id: 1, result }) });
const rpcError = (code: number): FetchLike => async () => ({ ok: true, status: 200, json: async () => ({ jsonrpc: "2.0", id: 1, error: { code, message: "Unsupported method" } }) });

describe("simulateEthSend (eth_simulateV1)", () => {
  it("sends eth_simulateV1 with traceTransfers and the transfer as a single call on latest", async () => {
    const f = vi.fn(respond(simResult(okCall([]))));
    await simulateEthSend(URL, { from: ME, to: TO, value: 255n }, f);
    const body = JSON.parse((f.mock.calls[0] as any)[1].body);
    expect(body.method).toBe("eth_simulateV1");
    expect(body.params).toEqual([{ blockStateCalls: [{ blockOverrides: { baseFeePerGas: "0x3b9aca00" }, calls: [{ from: ME, to: TO, value: "0xff", gas: "0x5208", maxFeePerGas: "0x77359400", maxPriorityFeePerGas: "0x3b9aca00" }] }], traceTransfers: true }, "latest"]);
  });

  it("always sends a gas limit: the given one, else 21000 (Alchemy otherwise assumes a huge default)", async () => {
    const f = vi.fn(respond(simResult(okCall([]))));
    await simulateEthSend(URL, { ...tx, gas: 30000n }, f);
    await simulateEthSend(URL, { ...tx, gas: 0n }, f);
    const gas = (i: number) => JSON.parse((f.mock.calls[i] as any)[1].body).params[0].blockStateCalls[0].calls[0].gas;
    expect(gas(0)).toBe("0x7530");
    expect(gas(1)).toBe("0x5208");
  });

  it("maps -38014 (insufficient funds) to the distinct code insufficient_funds", async () => {
    await expect(simulateEthSend(URL, tx, rpcError(-38014))).rejects.toMatchObject({ code: "insufficient_funds" });
    expect(await simulationUnsupported(URL, rpcError(-38014))).toBe(false);
  });

  it("uses the send route's fees when given, never a zero basefee or gas price, and keeps the tip below the max fee", async () => {
    const f = vi.fn(respond(simResult(okCall([]))));
    await simulateEthSend(URL, { ...tx, maxFeePerGas: 30_000_000_000n, maxPriorityFeePerGas: 2_000_000_000n }, f);
    const st = JSON.parse((f.mock.calls[0] as any)[1].body).params[0].blockStateCalls[0];
    expect(st.calls[0]).toMatchObject({ maxFeePerGas: "0x6fc23ac00", maxPriorityFeePerGas: "0x77359400" });
    expect(BigInt(st.blockOverrides.baseFeePerGas)).toBeGreaterThan(0n);
    await simulateEthSend(URL, { ...tx, maxFeePerGas: 500n, maxPriorityFeePerGas: 900n }, f);
    const low = JSON.parse((f.mock.calls[1] as any)[1].body).params[0].blockStateCalls[0];
    expect(BigInt(low.blockOverrides.baseFeePerGas)).toBeLessThanOrEqual(500n);
    expect(BigInt(low.calls[0].maxPriorityFeePerGas)).toBeLessThanOrEqual(500n);
  });

  it("reads the REAL response recorded from publicnode Sepolia (native ETH as a Transfer log from 0xff..fe)", async () => {
    const sim = await simulateEthSend(URL, tx, respond(live.result));
    expect(sim).toEqual({ changes: [{ asset: "ETH", direction: "out", kind: "native", amount: "0.000000000000000001", raw: "1", contract: null, counterparty: TO }], gasUsed: 21000n, error: null });
    expect(unexpectedChanges(sim, tx).outgoing).toEqual([]);
  });

  it("reads native ETH from the spec pseudo-address 0xEeee...EEeE too, with a decimal ETH amount", async () => {
    const v = 500_000_000_000_000_000n;
    const sim = await simulateEthSend(URL, { ...tx, value: v }, respond(simResult(okCall([nativeLog(ME, TO, v, NATIVE_EMITTER_SPEC)]))));
    expect(sim.changes).toEqual([{ asset: "ETH", direction: "out", kind: "native", amount: "0.5", raw: v.toString(), contract: null, counterparty: TO }]);
    expect(unexpectedChanges(sim, { to: TO, value: v })).toEqual({ other: [], outgoing: [] });
  });

  it("flags outgoing ERC-20, ERC-721, ERC-1155, approvals and approvals-for-all; incoming tokens are not outgoing", async () => {
    const logs = [nativeLog(ME, TO, 1n), erc20Log(USDC, ME, EVIL, 5n), erc721Log(USDC, ME, EVIL, 7n), erc1155SingleLog(USDC, ME, ME, EVIL),
      approvalLog(USDC, ME, EVIL, 9n), approvalForAllLog(USDC, ME, EVIL, true), erc20Log(USDC, EVIL, ME, 3n)];
    const sim = await simulateEthSend(URL, tx, respond(simResult(okCall(logs))));
    expect(sim.changes.map((c) => [c.kind, c.direction])).toEqual([["native", "out"], ["token", "out"], ["nft", "out"], ["nft", "out"], ["approval", "out"], ["approval", "out"], ["token", "in"]]);
    const { other, outgoing } = unexpectedChanges(sim, tx);
    expect(other).toHaveLength(6);
    expect(outgoing).toHaveLength(5);
    expect(sim.changes[1]).toMatchObject({ amount: "5", raw: "5", contract: USDC, counterparty: EVIL });
  });

  it("flags native ETH out for a different amount, a different recipient, or a second transfer", async () => {
    const wrongAmount = await simulateEthSend(URL, tx, respond(simResult(okCall([nativeLog(ME, TO, 2n)]))));
    expect(unexpectedChanges(wrongAmount, tx).outgoing).toHaveLength(1);
    const wrongTo = await simulateEthSend(URL, tx, respond(simResult(okCall([nativeLog(ME, EVIL, 1n)]))));
    expect(unexpectedChanges(wrongTo, tx).outgoing).toHaveLength(1);
    const twice = await simulateEthSend(URL, tx, respond(simResult(okCall([nativeLog(ME, TO, 1n), nativeLog(ME, EVIL, 1n, NATIVE_EMITTER_ERIGON)]))));
    expect(unexpectedChanges(twice, tx).outgoing).toHaveLength(1);
  });

  it("ignores transfers between other accounts, revokes (zero allowance) and approvals by someone else", async () => {
    const logs = [nativeLog(ME, TO, 1n), nativeLog(TO, EVIL, 1n), erc20Log(USDC, TO, EVIL, 5n), approvalLog(USDC, ME, EVIL, 0n), approvalLog(USDC, TO, EVIL, 9n), approvalForAllLog(USDC, ME, EVIL, false)];
    const sim = await simulateEthSend(URL, tx, respond(simResult(okCall(logs))));
    expect(unexpectedChanges(sim, tx).outgoing).toEqual([]);
    expect(sim.changes.filter((c) => c.direction === "other")).toHaveLength(2);
  });

  it("reports a revert as an error with no changes (status 0x0, spec error shape)", async () => {
    const sim = await simulateEthSend(URL, tx, respond(simResult(revertedCall("execution reverted: nope"))));
    expect(sim).toEqual({ changes: [], gasUsed: 21000n, error: "execution reverted: nope" });
    expect((await simulateEthSend(URL, tx, respond(simResult({ ...revertedCall(), error: undefined })))).error).toBe("The simulation reported an error.");
  });

  it("does not trust logs on a reverted call", async () => {
    const sim = await simulateEthSend(URL, tx, respond(simResult({ ...revertedCall(), logs: [erc20Log(USDC, ME, EVIL, 5n)] })));
    expect(sim.changes).toEqual([]);
  });

  it("ignores logs that are not about assets, including junk", async () => {
    const sim = await simulateEthSend(URL, tx, respond(simResult(okCall([{ address: "nope", topics: [], data: "0x" }, null, {}, log(USDC, ["0x" + "ab".repeat(32)])]))));
    expect(sim.changes).toEqual([]);
  });

  it("F1: more than 200 logs cannot hide an outgoing transfer: the guard refuses", async () => {
    const junk = Array.from({ length: 201 }, () => log(USDC, ["0x" + "ab".repeat(32)]));
    const sim = await simulateEthSend(URL, tx, respond(simResult(okCall([...junk, nativeLog(ME, TO, 1n), erc20Log(USDC, ME, EVIL, 5n)]))));
    expect(unexpectedChanges(sim, tx).outgoing.length).toBeGreaterThan(0);
    const exactly200 = await simulateEthSend(URL, tx, respond(simResult(okCall([nativeLog(ME, TO, 1n), ...junk.slice(0, 199)]))));
    expect(unexpectedChanges(exactly200, tx).outgoing).toEqual([]);
  });

  it("F2: a known Transfer/Approval signature that does not parse strictly is an unknown outgoing change, not skipped", async () => {
    const T = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
    const good = erc20Log(USDC, EVIL, TO, 1n);
    const dirty = "0x" + "ff".repeat(12) + ME.slice(2); // upper bits set
    const cases: Record<string, any> = {
      "1-topic Transfer (non-indexed)": log(USDC, [T], "0x" + "0".repeat(192)),
      "2-topic Transfer": log(USDC, [T, good.topics[1]], good.data),
      "dirty address topic": { ...good, topics: [T, dirty, good.topics[2]] },
      "short data": { ...good, data: "0x01" },
      "no data": { ...good, data: "0x" },
      "bad emitter address": { ...good, address: "0x12" },
      "Approval with short data": { ...approvalLog(USDC, ME, EVIL, 9n), data: "0x" },
      "Approval with 1 topic": log(USDC, ["0x8c5be1e5ebec7d5bd14f71427d1e84f3dd0314c0f7b2291e5b200ac8c7c3b925"], "0x" + "0".repeat(192)),
      "ApprovalForAll dirty topic": { ...approvalForAllLog(USDC, ME, EVIL, true), topics: [approvalForAllLog(USDC, ME, EVIL, true).topics[0], dirty, good.topics[2]] },
      "TransferSingle with 2 topics": log(USDC, ["0xc3d58168c5ae7397731d063d5bbf3d657854427343f4c083240f7aacaa2d0f62", good.topics[1]], "0x"),
      "TransferBatch with dirty topic": log(USDC, ["0x4a39dc06d4c0dbc64b70af90fd698a233a518aa5d07e595d983b8c0526c8f7fb", good.topics[1], dirty, good.topics[2]], "0x"),
    };
    for (const [name, bad] of Object.entries(cases)) {
      const sim = await simulateEthSend(URL, tx, respond(simResult(okCall([nativeLog(ME, TO, 1n), bad]))));
      expect(unexpectedChanges(sim, tx).outgoing, name).toHaveLength(1);
    }
  });

  it("maps -32600 / -32601 to rpc_unsupported and throws bad_response for an unusable result", async () => {
    for (const c of [-32600, -32601]) await expect(simulateEthSend(URL, tx, rpcError(c))).rejects.toMatchObject({ code: "rpc_unsupported" });
    await expect(simulateEthSend(URL, tx, rpcError(-32000))).rejects.toMatchObject({ code: "rpc_-32000" });
    for (const r of [null, [], [{}], [{ calls: [] }], "x"]) await expect(simulateEthSend(URL, tx, respond(r))).rejects.toMatchObject({ code: "bad_response" });
  });

  it("probe: true only when known unsupported, never throws, and probes eth_simulateV1", async () => {
    expect(await simulationUnsupported(URL, rpcError(-32600))).toBe(true);
    expect(await simulationUnsupported(URL, respond(simResult(okCall([]))))).toBe(false);
    expect(await simulationUnsupported(URL, async () => { throw new Error("net"); })).toBe(false);
    expect(await simulationUnsupported(URL, rpcError(-32000))).toBe(false);
    const f = vi.fn(respond(simResult(okCall([]))));
    await simulationUnsupported(URL, f);
    expect(JSON.parse((f.mock.calls[0] as any)[1].body).method).toBe("eth_simulateV1");
  });
});
