import { isFinal, nextNonce, normalizeAddress, type TransferState } from "@amma-wallet/evm-core";
import { encryptedRecordStore, VaultError } from "../xrpl/storage";

/**
 * Signed Sepolia transfers, kept on this device until they are final.
 *
 * The signed bytes are written before the first broadcast, so a reload, a closed
 * tab or a lost RPC response never loses them. Recovery only ever rebroadcasts
 * these same bytes; a new transfer is refused while any earlier one is open,
 * so an uncertain outcome can never lead to signing a second payment.
 * Records hold no key material: the raw transaction is public once broadcast.
 */
export const EVM_TRANSFER_DATABASE = "amma-evm-transfers-v1";
const store = encryptedRecordStore(EVM_TRANSFER_DATABASE);
const NETWORK = "ethereum-sepolia";
const STATES: readonly TransferState[] = ["signed", "broadcast", "pending", "included", "confirmed", "reverted", "replaced", "unknown"];
const HASH = /^0x[0-9a-f]{64}$/;
const RAW = /^0x(?:[0-9a-f]{2}){1,4096}$/;

export interface TrackedTransfer {
  id: string;
  version: 1;
  ownerId: string;
  networkId: typeof NETWORK;
  from: `0x${string}`;
  to: `0x${string}`;
  nonce: number;
  hash: `0x${string}`;
  raw: `0x${string}`;
  /** Display amount and symbol exactly as approved. */
  amount: string;
  symbol: string;
  state: TransferState;
  /** Present only on a user-approved cancel (same nonce, zero value, to self). */
  kind?: "cancel";
  createdAt: number;
  updatedAt: number;
}

function owner(value: string) { if (!/^[1-9][0-9]{0,14}$/.test(value)) throw new VaultError("INVALID_OWNER"); return value; }
const transferId = (ownerId: string, from: string, nonce: number, hash: string) => `evm-transfer:${NETWORK}:${owner(ownerId)}:${from}:${nonce}:${hash}`;
const BASE_KEYS = ["id", "version", "ownerId", "networkId", "from", "to", "nonce", "hash", "raw", "amount", "symbol", "state", "createdAt", "updatedAt"];
const KEYS = [...BASE_KEYS].sort().join(), CANCEL_KEYS = [...BASE_KEYS, "kind"].sort().join();

function checked(value: unknown): TrackedTransfer {
  const r = value as TrackedTransfer;
  const valid = !!value && typeof value === "object" && !Array.isArray(value) && (Object.keys(value).sort().join() === KEYS || (Object.keys(value).sort().join() === CANCEL_KEYS && (value as { kind?: unknown }).kind === "cancel"))
    && r.version === 1 && r.networkId === NETWORK && typeof r.ownerId === "string" && /^[1-9][0-9]{0,14}$/.test(r.ownerId)
    && typeof r.from === "string" && typeof r.to === "string" && Number.isSafeInteger(r.nonce) && r.nonce >= 0
    && typeof r.hash === "string" && HASH.test(r.hash) && typeof r.raw === "string" && RAW.test(r.raw)
    && typeof r.amount === "string" && r.amount.length <= 80 && typeof r.symbol === "string" && r.symbol.length <= 16
    && STATES.includes(r.state) && Number.isSafeInteger(r.createdAt) && Number.isSafeInteger(r.updatedAt);
  if (!valid) throw new VaultError("CORRUPT_TRANSFER");
  let from: string, to: string;
  try { from = normalizeAddress(r.from); to = normalizeAddress(r.to); } catch { throw new VaultError("CORRUPT_TRANSFER"); }
  if (from !== r.from || to !== r.to || r.id !== transferId(r.ownerId, r.from, r.nonce, r.hash)) throw new VaultError("CORRUPT_TRANSFER");
  if (r.kind === "cancel" && (r.to !== r.from || r.amount !== "0")) throw new VaultError("CORRUPT_TRANSFER");
  return r;
}

/** All transfers for one owner's wallet, newest nonce first. A record that fails validation fails the whole read. */
export async function listTransfers(ownerId: string, from: `0x${string}`): Promise<TrackedTransfer[]> {
  owner(ownerId);
  const records = (await store.readAll()).map(checked);
  return records.filter((r) => r.ownerId === ownerId && r.from === from).sort((a, b) => b.nonce - a.nonce || b.createdAt - a.createdAt);
}

export const openTransfers = (transfers: readonly TrackedTransfer[]) => transfers.filter((t) => !isFinal(t.state));

/** The nonce for a new transfer, refusing while any stored transfer from this wallet is unresolved. */
export async function nonceForNewTransfer(ownerId: string, from: `0x${string}`, chainPendingNonce: number): Promise<number> {
  return nextNonce(await listTransfers(ownerId, from), chainPendingNonce);
}

/** Persist signed bytes before they are broadcast. Refuses a second open transfer for the same wallet. */
export async function recordSigned(input: { ownerId: string; from: `0x${string}`; to: `0x${string}`; nonce: number; hash: `0x${string}`; raw: `0x${string}`; amount: string; symbol: string }, now = Date.now()): Promise<TrackedTransfer> {
  const existing = await listTransfers(input.ownerId, input.from);
  if (openTransfers(existing).length > 0) throw new VaultError("EVM_EARLIER_TRANSFER_UNRESOLVED");
  const record = checked({
    id: transferId(input.ownerId, input.from, input.nonce, input.hash.toLowerCase()), version: 1, ownerId: input.ownerId, networkId: NETWORK,
    from: input.from, to: input.to, nonce: input.nonce, hash: input.hash.toLowerCase(), raw: input.raw.toLowerCase(),
    amount: input.amount, symbol: input.symbol, state: "signed", createdAt: now, updatedAt: now,
  });
  await store.write(record);
  return record;
}

/**
 * Persist a signed cancel for an open transfer before it is broadcast. Allowed only
 * for the same nonce as an open, non-cancel transfer, and only once per nonce.
 */
export async function recordCancel(original: TrackedTransfer, input: { hash: `0x${string}`; raw: `0x${string}`; symbol: string }, now = Date.now()): Promise<TrackedTransfer> {
  const existing = await listTransfers(original.ownerId, original.from);
  const target = existing.find((t) => t.id === original.id);
  if (!target || target.kind === "cancel" || isFinal(target.state)) throw new VaultError("EVM_CANCEL_NOT_APPLICABLE");
  if (existing.some((t) => t.kind === "cancel" && t.nonce === target.nonce)) throw new VaultError("EVM_CANCEL_ALREADY_SENT");
  const record = checked({
    id: transferId(target.ownerId, target.from, target.nonce, input.hash.toLowerCase()), version: 1, ownerId: target.ownerId, networkId: NETWORK,
    from: target.from, to: target.from, nonce: target.nonce, hash: input.hash.toLowerCase(), raw: input.raw.toLowerCase(),
    amount: "0", symbol: input.symbol, state: "signed", kind: "cancel", createdAt: now, updatedAt: now,
  });
  await store.write(record);
  return record;
}

/** Whether automatic recovery may rebroadcast this record. A transfer the user chose to cancel is never pushed again. */
export const mayRebroadcast = (record: TrackedTransfer, all: readonly TrackedTransfer[]) =>
  record.kind === "cancel" || !all.some((t) => t.kind === "cancel" && t.nonce === record.nonce);

/**
 * Move a transfer to a new observed state. A final state is never left. `onlyFrom`
 * limits the move to the given current states (so a late "broadcast" write cannot
 * overwrite a state the tracker already observed).
 */
export async function updateState(record: TrackedTransfer, state: TransferState, options: { onlyFrom?: readonly TransferState[]; now?: number } = {}): Promise<TrackedTransfer> {
  const current = checked(await store.read(record.id));
  if (isFinal(current.state) || current.state === state || (options.onlyFrom && !options.onlyFrom.includes(current.state))) return current;
  const now = options.now ?? Date.now();
  const next = checked({ ...current, state, updatedAt: now });
  await store.write(next);
  return next;
}
