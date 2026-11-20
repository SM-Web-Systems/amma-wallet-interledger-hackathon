/** Builders for eth_simulateV1 responses (shape per the execution-apis spec / geth docs; field set matches what a real node returned, see __fixtures__). */
export const NATIVE_EMITTER_SPEC = "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE"; // spec/geth pseudo-address for traceTransfers
export const NATIVE_EMITTER_ERIGON = "0xfffffffffffffffffffffffffffffffffffffffe"; // seen on publicnode Sepolia
const pad = (a: string) => "0x" + "0".repeat(24) + a.slice(2).toLowerCase();
const word = (n: bigint) => n.toString(16).padStart(64, "0");
const T = { transfer: "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef", approval: "0x8c5be1e5ebec7d5bd14f71427d1e84f3dd0314c0f7b2291e5b200ac8c7c3b925", approvalAll: "0x17307eab39ab6107e8899845ad3d59bd9653f200f220920489ca2b5937696c31", single: "0xc3d58168c5ae7397731d063d5bbf3d657854427343f4c083240f7aacaa2d0f62" };

export const log = (address: string, topics: string[], data = "0x") => ({ address, topics, data, blockNumber: "0x1", transactionIndex: "0x0", logIndex: "0x0", removed: false });
export const nativeLog = (from: string, to: string, wei: bigint, emitter = NATIVE_EMITTER_SPEC) => log(emitter, [T.transfer, pad(from), pad(to)], "0x" + word(wei));
export const erc20Log = (token: string, from: string, to: string, v: bigint) => log(token, [T.transfer, pad(from), pad(to)], "0x" + word(v));
export const erc721Log = (token: string, from: string, to: string, id: bigint) => log(token, [T.transfer, pad(from), pad(to), "0x" + word(id)]);
export const approvalLog = (token: string, owner: string, spender: string, v: bigint) => log(token, [T.approval, pad(owner), pad(spender)], "0x" + word(v));
export const approvalForAllLog = (token: string, owner: string, op: string, on: boolean) => log(token, [T.approvalAll, pad(owner), pad(op)], "0x" + word(on ? 1n : 0n));
export const erc1155SingleLog = (token: string, operator: string, from: string, to: string) => log(token, [T.single, pad(operator), pad(from), pad(to)], "0x" + word(1n) + word(1n));

/** A successful call. */
export const okCall = (logs: unknown[], gasUsed = "0x5208") => ({ returnData: "0x", logs, gasUsed, maxUsedGas: gasUsed, status: "0x1" });
/** A reverted call, as the spec describes it (status 0x0, error with code 3 for reverts). */
export const revertedCall = (message = "execution reverted") => ({ returnData: "0x", logs: [], gasUsed: "0x5208", maxUsedGas: "0x5208", status: "0x0", error: { code: 3, message, data: "0x" } });
/** The `result` of eth_simulateV1: one simulated block holding the calls. */
export const simResult = (...calls: unknown[]) => [{ number: "0x1", hash: "0x" + "a".repeat(64), gasUsed: "0x5208", transactions: [], calls }];
