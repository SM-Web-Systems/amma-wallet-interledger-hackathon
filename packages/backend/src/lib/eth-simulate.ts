import { AlchemyError, alchemyCall, hexToBigInt, toHex, type FetchLike } from "./alchemy";

/**
 * eth_simulateV1 (standard JSON-RPC, with traceTransfers) for an ETH transfer, and the judgement of what it shows. Advisory: nothing here signs or sends.
 * (alchemy_simulateAssetChanges is not used: it answers -32600 "Unsupported method" on the owner's plan, while eth_simulateV1 works.)
 *
 * With traceTransfers=true every native ETH movement appears in the call's `logs` as an ERC-20 style Transfer(from,to,value) log emitted by a
 * pseudo-address: 0xEeee...EEeE per the spec/geth, 0xffff...fffe on Erigon-style nodes (publicnode Sepolia was seen returning that one). Both are accepted.
 */
export interface SimChange { asset: string; direction: "in" | "out" | "other"; amount: string; kind: "native" | "token" | "approval" | "nft" | "other"; contract: string | null; raw: string | null; counterparty: string | null }
export interface SimResult { changes: SimChange[]; gasUsed: bigint | null; error: string | null }

interface RawLog { address?: string; topics?: string[]; data?: string }
interface RawCall { status?: string; gasUsed?: string; logs?: RawLog[]; error?: { message?: string } | null }
interface RawBlock { calls?: RawCall[] }

export const TOPIC_TRANSFER = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
export const TOPIC_APPROVAL = "0x8c5be1e5ebec7d5bd14f71427d1e84f3dd0314c0f7b2291e5b200ac8c7c3b925";
export const TOPIC_APPROVAL_FOR_ALL = "0x17307eab39ab6107e8899845ad3d59bd9653f200f220920489ca2b5937696c31";
export const TOPIC_TRANSFER_SINGLE = "0xc3d58168c5ae7397731d063d5bbf3d657854427343f4c083240f7aacaa2d0f62";
export const TOPIC_TRANSFER_BATCH = "0x4a39dc06d4c0dbc64b70af90fd698a233a518aa5d07e595d983b8c0526c8f7fb";
const NATIVE_EMITTERS = new Set(["0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee", "0xfffffffffffffffffffffffffffffffffffffffe"]);

const clip = (v: unknown, n: number): string => (typeof v === "string" ? v.replace(/[^\w .:$-]/g, "").slice(0, n) : "");
const lower = (v: unknown) => (typeof v === "string" ? v.toLowerCase() : "");
const topicAddr = (t: unknown): string | null => (typeof t === "string" && /^0x0{24}[0-9a-fA-F]{40}$/.test(t) ? "0x" + t.slice(26).toLowerCase() : null);
const word = (data: unknown): bigint | null => (typeof data === "string" && /^0x[0-9a-fA-F]{64}/.test(data) ? BigInt(data.slice(0, 66)) : null);

/** wei -> a plain ETH decimal string. */
function ethString(wei: bigint): string {
  const d = wei.toString().padStart(19, "0");
  const frac = d.slice(-18).replace(/0+$/, "");
  return frac ? `${d.slice(0, -18)}.${frac}` : d.slice(0, -18);
}

const MAX_LOGS = 200;
/** Something moved or was permitted that this code could not read. Always outgoing + unexpected, so the guard refuses and the preview warns. */
const UNKNOWN: SimChange = { asset: "assets", direction: "out", kind: "other", amount: "an unknown amount of", raw: null, contract: null, counterparty: null };
const KNOWN_TOPICS = new Set([TOPIC_TRANSFER, TOPIC_APPROVAL, TOPIC_APPROVAL_FOR_ALL, TOPIC_TRANSFER_SINGLE, TOPIC_TRANSFER_BATCH]);

/** Parse one log. null = not about asset movement (skip); "unknown" = a known movement/permission signature that could not be read strictly. */
function parseLog(l: RawLog, me: string): SimChange[] | "unknown" | null {
  const topics = Array.isArray(l?.topics) ? l.topics : [];
  const t0 = lower(topics[0]);
  if (!KNOWN_TOPICS.has(t0)) return null;
  const contract = typeof l?.address === "string" && /^0x[0-9a-fA-F]{40}$/.test(l.address) ? l.address.toLowerCase() : null;
  if (!contract) return "unknown";
  const short = `token ${contract.slice(0, 10)}`;
  if (t0 === TOPIC_TRANSFER) {
    if (topics.length !== 3 && topics.length !== 4) return "unknown";
    const from = topicAddr(topics[1]), to = topicAddr(topics[2]);
    if (!from || !to) return "unknown";
    const direction = from === me ? "out" : to === me ? "in" : "other";
    const counterparty = direction === "out" ? to : direction === "in" ? from : null;
    if (topics.length === 4) { // ERC-721: the token id is the 4th topic
      return [{ asset: short, direction, kind: "nft", amount: "1", raw: "1", contract, counterparty }];
    }
    const v = word(l.data);
    if (v === null) return "unknown";
    return [NATIVE_EMITTERS.has(contract)
      ? { asset: "ETH", direction, kind: "native", amount: ethString(v), raw: v.toString(), contract: null, counterparty }
      : { asset: short, direction, kind: "token", amount: v.toString(), raw: v.toString(), contract, counterparty }];
  }
  if (t0 === TOPIC_APPROVAL || t0 === TOPIC_APPROVAL_FOR_ALL) {
    const erc20Shape = topics.length === 3; // ERC-20 Approval and ApprovalForAll: owner, spender indexed + a data word
    const nftApprove = t0 === TOPIC_APPROVAL && topics.length === 4; // ERC-721 Approval: tokenId indexed too
    if (!erc20Shape && !nftApprove) return "unknown";
    const owner = topicAddr(topics[1]), spender = topicAddr(topics[2]);
    if (!owner || !spender) return "unknown";
    if (nftApprove) return owner === me && spender !== "0x0000000000000000000000000000000000000000" ? [{ asset: short, direction: "out", kind: "approval", amount: "0", raw: null, contract, counterparty: spender }] : [];
    const v = word(l.data);
    if (v === null) return "unknown";
    // An allowance of zero (or ApprovalForAll=false) revokes: not a new permission.
    if (owner !== me || v === 0n) return [];
    return [{ asset: short, direction: "out", kind: "approval", amount: "0", raw: null, contract, counterparty: spender }];
  }
  // ERC-1155 TransferSingle / TransferBatch: operator, from, to indexed.
  if (topics.length !== 4) return "unknown";
  const from = topicAddr(topics[2]), to = topicAddr(topics[3]);
  if (!from || !to || topicAddr(topics[1]) === null) return "unknown";
  const direction = from === me ? "out" : to === me ? "in" : "other";
  return [{ asset: short, direction, kind: "nft", amount: "1", raw: null, contract, counterparty: direction === "out" ? to : direction === "in" ? from : null }];
}

/**
 * The sender-relevant changes in one call's logs: outgoing native ETH, outgoing tokens/NFTs, approvals, and incoming transfers (for the preview).
 * Fail closed: more than MAX_LOGS logs, or a log with a known Transfer/Approval signature that does not parse strictly, adds an unknown outgoing change.
 * Limit: assets that move WITHOUT emitting these events (non-standard tokens) cannot be detected from logs.
 */
function changesFromLogs(logs: RawLog[], me: string): SimChange[] {
  const out: SimChange[] = [];
  let unknown = logs.length > MAX_LOGS;
  for (const l of logs.slice(0, MAX_LOGS)) {
    const r = parseLog(l, me);
    if (r === "unknown") unknown = true;
    else if (r) out.push(...r);
  }
  if (unknown) out.push({ ...UNKNOWN });
  return out;
}

// eth_simulateV1 defaults basefee/gasprice to 0, which a contract could branch on to behave differently than on-chain. Simulate with realistic fees.
const SIM_BASE_FEE = 1_000_000_000n, SIM_MAX_FEE = 2_000_000_000n, SIM_TIP = 1_000_000_000n;
export const INSUFFICIENT_FUNDS = "insufficient_funds";
export const INSUFFICIENT_FUNDS_MESSAGE = "This wallet doesn't hold enough ETH for this amount plus the network fee.";
/** `gas` is always sent: without it Alchemy assumes a huge default limit and answers -38014 for ordinary wallets. */
export interface SimTx { from: string; to: string; value: bigint; gas?: bigint; maxFeePerGas?: bigint; maxPriorityFeePerGas?: bigint }

export async function simulateEthSend(url: string, tx: SimTx, fetchImpl?: FetchLike): Promise<SimResult> {
  const maxFee = tx.maxFeePerGas && tx.maxFeePerGas > 0n ? tx.maxFeePerGas : SIM_MAX_FEE;
  const baseFee = maxFee < SIM_BASE_FEE ? maxFee : SIM_BASE_FEE;
  const tip = (tx.maxPriorityFeePerGas && tx.maxPriorityFeePerGas > 0n ? tx.maxPriorityFeePerGas : SIM_TIP);
  // -32600 / -32601: this RPC/plan does not offer the method. A distinct reason, so logs can tell "not on this plan" from an outage.
  const blocks = await alchemyCall<RawBlock[]>(url, "eth_simulateV1", [
    { blockStateCalls: [{ blockOverrides: { baseFeePerGas: toHex(baseFee) }, calls: [{ from: tx.from, to: tx.to, value: toHex(tx.value), gas: toHex(tx.gas && tx.gas > 0n ? tx.gas : 21000n), maxFeePerGas: toHex(maxFee), maxPriorityFeePerGas: toHex(tip < maxFee ? tip : maxFee) }] }], traceTransfers: true }, "latest",
  ], fetchImpl).catch((e) => {
    // -38014: the wallet cannot cover gas * price + value. A clear reason of its own, not an outage.
    throw e instanceof AlchemyError ? (e.code === "rpc_-32600" || e.code === "rpc_-32601" ? new AlchemyError("rpc_unsupported") : e.code === "rpc_-38014" ? new AlchemyError(INSUFFICIENT_FUNDS) : e) : e;
  });
  const call = Array.isArray(blocks) ? blocks[0]?.calls?.[0] : undefined;
  if (!call || typeof call !== "object") throw new AlchemyError("bad_response");
  const me = tx.from.toLowerCase();
  const failed = call.status !== undefined ? hexToBigInt(call.status) !== 1n : !!call.error;
  return {
    // A reverted call has no usable logs; its changes would never happen.
    changes: failed ? [] : changesFromLogs(Array.isArray(call.logs) ? call.logs : [], me),
    gasUsed: typeof call.gasUsed === "string" && /^0x[0-9a-fA-F]+$/.test(call.gasUsed) ? hexToBigInt(call.gasUsed) : null,
    error: failed || call.error ? clip(call.error?.message, 120) || "The simulation reported an error." : null,
  };
}

/** The one change a plain ETH send should show: this much native ETH leaving the wallet for the recipient. */
const isExpected = (c: SimChange, tx: { to: string; value: bigint }) => c.kind === "native" && c.direction === "out" && c.counterparty === tx.to.toLowerCase() && c.raw === tx.value.toString();

/** Everything that is not the expected ETH out. `outgoing` is the subset that moves something else out of the wallet (or approves a spender). */
export function unexpectedChanges(sim: SimResult, tx: { to: string; value: bigint }): { other: SimChange[]; outgoing: SimChange[] } {
  const other = sim.changes.filter((c) => !isExpected(c, tx));
  return { other, outgoing: other.filter((c) => c.direction === "out" || c.kind === "approval") };
}

/** Why the simulation guard cannot work with this configuration, or null when it can. Codes match the runtime failure codes in the logs. */
export function simulationConfigProblem(env: Record<string, string | undefined>, url: string | null): "no_rpc" | "not_alchemy" | null {
  if (!url) return "no_rpc";
  try { return /(^|\.)alchemy\.com$/.test(new URL(url).hostname) ? null : "not_alchemy"; } catch { return "no_rpc"; }
}

export const SEND_MOVES_MORE = "This transaction would move more than you asked. It was not sent.";

/** One-time start-up probe: is eth_simulateV1 available on this RPC? Resolves true only when it is known NOT to be. Never throws. */
export async function simulationUnsupported(url: string, fetchImpl?: FetchLike): Promise<boolean> {
  try {
    await simulateEthSend(url, { from: "0x0000000000000000000000000000000000000001", to: "0x0000000000000000000000000000000000000002", value: 0n }, fetchImpl);
    return false;
  } catch (e) { return e instanceof AlchemyError && e.code === "rpc_unsupported"; }
}
