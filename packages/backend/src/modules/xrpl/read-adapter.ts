import { Client, type Request } from "xrpl";
import { NETWORK_IDS, readXrplConfig, type XrplNetwork } from "./config";
import { classicAddress, drops, object, transactionHash, uint, XrplReadError } from "./validation";

const FEE_SETTINGS_ID = "4BC50C9B0D8515D3EAAE1E74B29A95804346C491EE1A95BF25E4AAB854A6A651";
const RIPPLE_EPOCH_SECONDS = 946684800;
type ReadCommand = "server_info" | "ledger" | "ledger_entry" | "account_info" | "account_tx" | "fee" | "tx";
export type ReadRequest = { command: ReadCommand; [field: string]: unknown };
export interface ReadConnection {
  connect(): Promise<void>;
  request(request: ReadRequest): Promise<unknown>;
  disconnect(): Promise<unknown>;
  /** Available only to the payment adapter after the same session is anchored. */
  submit?(blob: string): Promise<unknown>;
}
export type ReadConnectionFactory = (url: string, timeoutMs: number) => ReadConnection;

const sdkConnection: ReadConnectionFactory = (url, timeoutMs) => {
  const client = new Client(url, { connectionTimeout: timeoutMs, timeout: timeoutMs });
  // Keep transport errors from becoming unhandled EventEmitter exceptions.
  client.on("error", () => {});
  return { connect: () => client.connect(), request: (request) => client.request({ ...request, api_version: 2 } as Request),
    submit: (blob) => client.request({ command: "submit", tx_blob: blob, fail_hard: false, api_version: 2 }), disconnect: () => client.disconnect() };
};

export interface LedgerObservation {
  chain: "xrpl";
  network: XrplNetwork;
  endpoint: string;
  validatedLedgerIndex: number;
  validatedLedgerHash: string;
  observedAt: string;
}
export interface AccountSnapshot extends LedgerObservation {
  address: string;
  funded: boolean;
  balanceDrops: string;
  reserveDrops: string;
  /** The ledger base reserve alone (what activating an account needs). */
  baseReserveDrops?: string;
  /** Balance minus reserve, before paying a transaction fee. */
  spendableDrops: string;
  sequence: number | null;
  ownerCount: number;
  requiresDestinationTag: boolean;
  masterDisabled?: boolean;
  hasRegularKey?: boolean;
  hasSignerList?: boolean;
  depositAuth?: boolean;
  disallowIncomingXrp?: boolean;
}
export interface FeeSnapshot extends LedgerObservation {
  feeDrops: string;
  currentLedgerIndex: number;
}
export type TransactionObservation = LedgerObservation & (
  { status: "not_found" | "pending"; transactionHash: string; validated: false; authoritative: false } |
  { status: "validated"; transactionHash: string; validated: true; ledgerIndex: number; ledgerHash: string;
    resultCode: string; transaction: Record<string, unknown>; metadata: Record<string, unknown> }
);
type Read = (request: ReadRequest) => Promise<Record<string, unknown>>;

function result(response: unknown) {
  const envelope = object(response);
  if (envelope.status === "error") throw new XrplReadError("INVALID_LEDGER_RESPONSE", true);
  const body = object(envelope.result);
  if (body.error !== undefined) throw new XrplReadError("INVALID_LEDGER_RESPONSE", true);
  return body;
}
function ledgerHash(value: unknown) {
  try { return transactionHash(value); } catch { throw new XrplReadError("INVALID_LEDGER_RESPONSE", true); }
}
function atLedger(response: Record<string, unknown>, ledger: LedgerObservation) {
  if (response.validated !== true || ledgerHash(response.ledger_hash) !== ledger.validatedLedgerHash || uint(response.ledger_index, true) !== ledger.validatedLedgerIndex) throw new XrplReadError("INVALID_LEDGER_RESPONSE", true);
}
function rpcError(error: unknown): Record<string, unknown> | undefined {
  if (error && typeof error === "object" && "data" in error && error.data && typeof error.data === "object" && !Array.isArray(error.data)) return error.data as Record<string, unknown>;
  return undefined;
}

export class XrplReadAdapter {
  private readonly settings;
  /** The one XRPL network this adapter talks to; every session must prove it (server_info.network_id). */
  readonly xrplNetwork: XrplNetwork;
  constructor(env: NodeJS.ProcessEnv = process.env, private readonly factory: ReadConnectionFactory = sdkConnection) {
    this.settings = readXrplConfig(env);
    this.xrplNetwork = this.settings.network;
  }

  private assertEnabled() { if (!this.settings.enabled) throw new XrplReadError("XRPL_DISABLED"); }

  protected stopRetry(cause: unknown): boolean { return cause instanceof XrplReadError && cause.code === "UNSUPPORTED_ACCOUNT"; }

  protected async withEndpoint<T>(work: (read: Read, ledger: LedgerObservation, submit: (blob: string) => Promise<Record<string, unknown>>, info: Record<string, unknown>) => Promise<T>): Promise<T> {
    this.assertEnabled();
    let last: XrplReadError = new XrplReadError("XRPL_UNAVAILABLE", true);
    for (const endpoint of this.settings.endpoints) {
      let client: ReadConnection;
      try { client = this.factory(endpoint, this.settings.timeoutMs); }
      catch { last = new XrplReadError("XRPL_UNAVAILABLE", true); continue; }
      let closed = false;
      let timeout: ReturnType<typeof setTimeout> | undefined;
      const read: Read = async (request) => {
        if (closed) throw new XrplReadError("XRPL_UNAVAILABLE", true);
        const response = await client.request(request);
        if (closed) throw new XrplReadError("XRPL_UNAVAILABLE", true);
        return result(response);
      };
      try {
        const attempt = (async () => {
          await client.connect();
          const info = object((await read({ command: "server_info" })).info);
          if (info.network_id !== NETWORK_IDS[this.settings.network]) throw new XrplReadError("WRONG_NETWORK");
          if (!["full", "validating", "proposing"].includes(String(info.server_state))) throw new XrplReadError("XRPL_UNAVAILABLE", true);
          const validated = object(info.validated_ledger);
          if (uint(validated.age) > this.settings.maxLedgerAgeSeconds) throw new XrplReadError("STALE_LEDGER", true);
          const observation: LedgerObservation = { chain: "xrpl", network: this.settings.network, endpoint,
            validatedLedgerIndex: uint(validated.seq, true), validatedLedgerHash: ledgerHash(validated.hash), observedAt: new Date().toISOString() };
          const anchor = await read({ command: "ledger", ledger_hash: observation.validatedLedgerHash, transactions: false, expand: false });
          atLedger(anchor, observation);
          const header = object(anchor.ledger);
          const age = Date.now() / 1000 - (uint(header.close_time) + RIPPLE_EPOCH_SECONDS);
          if (age > this.settings.maxLedgerAgeSeconds || age < -5) throw new XrplReadError("STALE_LEDGER", true);
          const submit = async (blob: string) => {
            if (closed || !client.submit) throw new XrplReadError("XRPL_UNAVAILABLE", true);
            const response = await client.submit(blob);
            if (closed) throw new XrplReadError("XRPL_UNAVAILABLE", true);
            return result(response);
          };
          const response = await work(read, observation, submit, info);
          if (Date.now() / 1000 - (uint(header.close_time) + RIPPLE_EPOCH_SECONDS) > this.settings.maxLedgerAgeSeconds) throw new XrplReadError("STALE_LEDGER", true);
          return response;
        })();
        const deadline = new Promise<never>((_, reject) => { timeout = setTimeout(() => reject(new XrplReadError("XRPL_UNAVAILABLE", true)), this.settings.timeoutMs); });
        return await Promise.race([attempt, deadline]);
      } catch (error) {
        if (this.stopRetry(error)) throw error;
        last = error instanceof XrplReadError ? error : new XrplReadError("XRPL_UNAVAILABLE", true);
        if (last.code === "UNSUPPORTED_ACCOUNT") throw last;
      } finally {
        closed = true;
        if (timeout) clearTimeout(timeout);
        // Intentionally disconnect each short-lived session, cancelling SDK reconnects.
        let cleanup: ReturnType<typeof setTimeout> | undefined;
        await Promise.race([Promise.resolve().then(() => client.disconnect()).catch(() => {}), new Promise<void>((resolve) => { cleanup = setTimeout(resolve, 1000); })]);
        if (cleanup) clearTimeout(cleanup);
      }
    }
    throw last;
  }

  async getHealth(): Promise<{ status: "disabled" } | (LedgerObservation & { status: "healthy" })> {
    if (!this.settings.enabled) return { status: "disabled" };
    return this.withEndpoint(async (_, ledger) => ({ ...ledger, status: "healthy" as const }));
  }

  async getAccount(addressInput: unknown): Promise<AccountSnapshot> {
    this.assertEnabled();
    const address = classicAddress(addressInput);
    return this.withEndpoint(async (read, ledger) => {
      const fees = await read({ command: "ledger_entry", index: FEE_SETTINGS_ID, ledger_hash: ledger.validatedLedgerHash, binary: false });
      atLedger(fees, ledger);
      const node = object(fees.node);
      if (node.LedgerEntryType !== "FeeSettings") throw new XrplReadError("INVALID_LEDGER_RESPONSE", true);
      const modern = node.ReserveBaseDrops !== undefined || node.ReserveIncrementDrops !== undefined;
      const base = modern ? drops(node.ReserveBaseDrops) : BigInt(uint(node.ReserveBase));
      const increment = modern ? drops(node.ReserveIncrementDrops) : BigInt(uint(node.ReserveIncrement));
      let account: Record<string, unknown>;
      let hasSignerList = false;
      try {
        const response = await read({ command: "account_info", account: address, ledger_hash: ledger.validatedLedgerHash, strict: true, signer_lists: true });
        atLedger(response, ledger);
        account = object(response.account_data);
        if (response.signer_lists !== undefined && !Array.isArray(response.signer_lists)) throw new XrplReadError("INVALID_LEDGER_RESPONSE", true);
        hasSignerList = Array.isArray(response.signer_lists) && response.signer_lists.length > 0;
      } catch (error) {
        const data = rpcError(error);
        if (data?.error !== "actNotFound") throw error;
        if (data.validated === false || (data.ledger_hash !== undefined && ledgerHash(data.ledger_hash) !== ledger.validatedLedgerHash) || (data.ledger_index !== undefined && uint(data.ledger_index, true) !== ledger.validatedLedgerIndex)) throw new XrplReadError("INVALID_LEDGER_RESPONSE", true);
        return { ...ledger, address, funded: false, balanceDrops: "0", reserveDrops: base.toString(), baseReserveDrops: base.toString(), spendableDrops: "0", sequence: null, ownerCount: 0, requiresDestinationTag: false };
      }
      if (account.Account !== address) throw new XrplReadError("INVALID_LEDGER_RESPONSE", true);
      // Do not claim a spendable value for sponsorship or special-purpose accounts
      // until their reserve rules are implemented explicitly.
      if (["Sponsor", "SponsoredOwnerCount", "SponsoringOwnerCount", "SponsoringAccountCount", "AMMID", "VaultID", "LoanBrokerID"].some((field) => account[field] !== undefined)) throw new XrplReadError("UNSUPPORTED_ACCOUNT");
      const balance = drops(account.Balance);
      const ownerCount = uint(account.OwnerCount);
      const reserve = base + increment * BigInt(ownerCount);
      const flags = uint(account.Flags);
      return { ...ledger, address, funded: true, balanceDrops: balance.toString(), reserveDrops: reserve.toString(), baseReserveDrops: base.toString(),
        spendableDrops: (balance > reserve ? balance - reserve : 0n).toString(), sequence: uint(account.Sequence, true), ownerCount,
        requiresDestinationTag: (flags & 0x00020000) !== 0, masterDisabled: (flags & 0x00100000) !== 0,
        hasRegularKey: account.RegularKey !== undefined, hasSignerList, depositAuth: (flags & 0x01000000) !== 0, disallowIncomingXrp: (flags & 0x00080000) !== 0 };
    });
  }

  async getFee(): Promise<FeeSnapshot> {
    return this.withEndpoint(async (read, ledger) => {
      const fee = await read({ command: "fee" });
      const currentLedgerIndex = uint(fee.ledger_current_index, true);
      if (currentLedgerIndex < ledger.validatedLedgerIndex || currentLedgerIndex > ledger.validatedLedgerIndex + 5) throw new XrplReadError("INVALID_LEDGER_RESPONSE", true);
      const values = object(fee.drops);
      const base = drops(values.base_fee, true);
      const open = drops(values.open_ledger_fee, true);
      // The previous ledger's median includes complex transactions and is not
      // the required fee for a new simple Payment. Preparation adds its policy
      // cushion/ceiling later; this read exposes the current network estimate.
      return { ...ledger, currentLedgerIndex, feeDrops: (base > open ? base : open).toString() };
    });
  }

  async lookupTransaction(hashInput: unknown): Promise<TransactionObservation> {
    this.assertEnabled();
    const hash = transactionHash(hashInput);
    return this.withEndpoint(async (read, ledger) => {
      let tx: Record<string, unknown>;
      try { tx = await read({ command: "tx", transaction: hash, binary: false }); }
      catch (error) {
        if (rpcError(error)?.error !== "txnNotFound") throw error;
        // Not-found is never evidence of expiry or permission to pay again.
        return { ...ledger, status: "not_found", transactionHash: hash, validated: false, authoritative: false };
      }
      return this.transactionObservation(read,ledger,tx,hash);
    });
  }

  protected async transactionObservation(read: Read, ledger: LedgerObservation, tx: Record<string, unknown>, hash: string): Promise<TransactionObservation> {
    if (ledgerHash(tx.hash) !== hash) throw new XrplReadError("INVALID_LEDGER_RESPONSE", true);
    if (tx.validated !== true) return { ...ledger, status: "pending", transactionHash: hash, validated: false, authoritative: false };
    const ledgerIndex = uint(tx.ledger_index, true);
    if (ledgerIndex > ledger.validatedLedgerIndex) throw new XrplReadError("INVALID_LEDGER_RESPONSE", true);
    const header = await read({ command: "ledger", ledger_index: ledgerIndex, transactions: false, expand: false });
    if (header.validated !== true || uint(header.ledger_index, true) !== ledgerIndex) throw new XrplReadError("INVALID_LEDGER_RESPONSE", true);
    const metadata = object(tx.meta), transaction = object(tx.tx_json);
    if (typeof metadata.TransactionResult !== "string" || !/^[A-Za-z][A-Za-z0-9_]{1,63}$/.test(metadata.TransactionResult)) throw new XrplReadError("INVALID_LEDGER_RESPONSE", true);
    return { ...ledger, status: "validated", transactionHash: hash, validated: true, ledgerIndex, ledgerHash: ledgerHash(header.ledger_hash), resultCode: metadata.TransactionResult, transaction, metadata };
  }
}
