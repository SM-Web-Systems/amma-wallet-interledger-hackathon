import { ensure } from "./errors";

/**
 * Transaction tracking for one signed transfer. A broadcast whose outcome is
 * unknown is never "retried" by signing a new transaction with a new nonce:
 * that is how wallets double-pay. The only automatic recovery is rebroadcasting
 * the same signed bytes; anything else (speed-up, cancel) reuses the same nonce
 * and is a separate, user-approved action.
 */
export type TransferState =
  | "signed"      // bytes exist, not yet handed to a node
  | "broadcast"   // a node accepted or we lost the response; outcome open
  | "pending"     // seen by a node, not in a block
  | "included"    // in a block, fewer confirmations than policy
  | "confirmed"   // successful and final per network policy
  | "reverted"    // in a block with status 0 (fee spent, value not moved)
  | "replaced"    // our nonce was consumed by a different transaction
  | "unknown";    // not seen and nonce not consumed: keep rebroadcasting the same bytes

export interface Observation {
  /** Transaction lookup by our hash. null when the node does not know it. */
  readonly transaction: { readonly blockNumber: bigint | null } | null;
  /** Receipt by our hash, when included. */
  readonly receipt: { readonly status: "success" | "reverted"; readonly blockNumber: bigint } | null;
  /** Account nonce at the latest block (count of mined transactions from the sender). */
  readonly minedNonce: number;
  readonly latestBlock: bigint;
}

export function classify(nonce: number, requiredConfirmations: number, observation: Observation): TransferState {
  ensure(Number.isSafeInteger(nonce) && nonce >= 0 && requiredConfirmations >= 1, "EVM_TRACKING_INVALID");
  const { receipt } = observation;
  if (receipt) {
    if (receipt.status === "reverted") return "reverted";
    const depth = observation.latestBlock - receipt.blockNumber + 1n;
    return depth >= BigInt(requiredConfirmations) ? "confirmed" : "included";
  }
  // No receipt for our hash. If the sender's nonce has moved past ours, a
  // different transaction used it: ours can never be included.
  if (observation.minedNonce > nonce) return "replaced";
  if (observation.transaction) return "pending";
  return "unknown";
}

const FINAL: ReadonlySet<TransferState> = new Set(["confirmed", "reverted", "replaced"]);
export const isFinal = (state: TransferState) => FINAL.has(state);

/** What the tracker may do next without asking the user. */
export function automaticAction(state: TransferState): "broadcast" | "rebroadcast-same-bytes" | "poll" | "none" {
  switch (state) {
    case "signed": return "broadcast";
    case "broadcast": case "unknown": return "rebroadcast-same-bytes";
    case "pending": case "included": return "poll";
    default: return "none";
  }
}

/**
 * A new transfer from the same account must not take a nonce while an earlier
 * one is unresolved, or the two can race. Returns the nonce to use, or refuses.
 */
export function nextNonce(pendingNonces: readonly { nonce: number; state: TransferState }[], chainPendingNonce: number): number {
  const open = pendingNonces.filter((p) => !isFinal(p.state));
  ensure(open.length === 0, "EVM_EARLIER_TRANSFER_UNRESOLVED");
  ensure(Number.isSafeInteger(chainPendingNonce) && chainPendingNonce >= 0, "EVM_NONCE_INVALID");
  return chainPendingNonce;
}
