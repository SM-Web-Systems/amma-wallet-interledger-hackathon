import { afterEach, describe, expect, it, vi } from "vitest";
import { XrplReadAdapter, type ReadConnection, type ReadConnectionFactory, type ReadRequest } from "./read-adapter";
import { TESTNET_ENDPOINTS } from "./config";

const address = "rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh";
const hash = "A".repeat(64);
const txHash = "B".repeat(64);
const env = { XRPL_ENABLED: "true", XRPL_RPC_URLS: TESTNET_ENDPOINTS[0] };
const closeTime = () => Math.floor(Date.now() / 1000) - 946684800 - 2;
const envelope = (result: Record<string, unknown>) => ({ result });
const anchored = (extra = {}) => ({ validated: true, ledger_index: 1234, ledger_hash: hash, ...extra });
const missing = (error: string) => Object.assign(new Error("do not expose raw RPC details"), { data: { error } });

function fixture(change?: (request: ReadRequest, value: Record<string, unknown>) => unknown) {
  const request = vi.fn(async (req: ReadRequest) => {
    let value: Record<string, unknown>;
    switch (req.command) {
      case "server_info": value = { info: { network_id: 1, server_state: "full", validated_ledger: { seq: 1234, hash, age: 2 } } }; break;
      case "ledger": value = anchored({ ledger: { close_time: closeTime() } }); break;
      case "ledger_entry": value = anchored({ node: { LedgerEntryType: "FeeSettings", ReserveBaseDrops: "1000000", ReserveIncrementDrops: "200000" } }); break;
      case "account_info": value = anchored({ account_data: { Account: address, Balance: "12000000", OwnerCount: 3, Sequence: 123, Flags: 0x20000 } }); break;
      case "fee": value = { ledger_current_index: 1235, drops: { base_fee: "10", open_ledger_fee: "12", median_fee: "1000000" } }; break;
      case "tx": value = { validated: true, hash: txHash, ledger_index: 1234, tx_json: { TransactionType: "Payment", Account: address }, meta: { TransactionResult: "tesSUCCESS", delivered_amount: "1000000" } }; break;
      case "account_tx": value = {account:address,ledger_index_min:1234,ledger_index_max:1254,transactions:[]};break;
    }
    return envelope((change?.(req, value) ?? value) as Record<string, unknown>);
  });
  const client = { connect: vi.fn(async () => {}), disconnect: vi.fn(async () => {}), request } satisfies ReadConnection;
  return { client, factory: vi.fn(() => client) as ReadConnectionFactory, request };
}
afterEach(() => { vi.useRealTimers(); });

describe("XRPL read adapter", () => {
  it("opens no connection when disabled", async () => {
    const f = fixture(); const adapter = new XrplReadAdapter({}, f.factory);
    expect(await adapter.getHealth()).toEqual({ status: "disabled" });
    await expect(adapter.getAccount(address)).rejects.toMatchObject({ code: "XRPL_DISABLED" });
    await expect(adapter.getFee()).rejects.toMatchObject({ code: "XRPL_DISABLED" });
    await expect(adapter.lookupTransaction(txHash)).rejects.toMatchObject({ code: "XRPL_DISABLED" });
    expect(f.factory).not.toHaveBeenCalled();
  });
  describe("on mainnet (XRPL_MAINNET_CUSTODY=on)", () => {
    const main = { XRPL_ENABLED: "true", STELLAR_NETWORK: "public", MAINNET_CUSTODY: "on", XRPL_NETWORK: "mainnet", XRPL_MAINNET_CUSTODY: "on", XRPL_MAINNET_WS: "wss://xrplcluster.com/" };
    const withId = (id: unknown) => fixture((req, value) => { if (req.command === "server_info") { const info = { ...(value.info as Record<string, unknown>) }; if (id === undefined) delete info.network_id; else info.network_id = id; return { info }; } return value; });
    it("accepts a server reporting network_id 0 and labels every observation mainnet", async () => {
      const f = withId(0); const adapter = new XrplReadAdapter(main, f.factory);
      expect(adapter.xrplNetwork).toBe("mainnet");
      expect(await adapter.getAccount(address)).toMatchObject({ network: "mainnet", endpoint: "wss://xrplcluster.com/", funded: true });
      expect(f.factory).toHaveBeenCalledWith("wss://xrplcluster.com/", 10000);
    });
    it("refuses a testnet (1), devnet (2) or unlabelled server before any account read", async () => {
      for (const id of [1, 2, undefined, "0"]) {
        const f = withId(id);
        await expect(new XrplReadAdapter(main, f.factory).getAccount(address)).rejects.toMatchObject({ code: "WRONG_NETWORK" });
        expect(f.request.mock.calls.some(([r]) => r.command === "account_info")).toBe(false);
      }
    });
    it("testnet still requires network_id 1", async () => {
      await expect(new XrplReadAdapter(env, withId(0).factory).getHealth()).rejects.toMatchObject({ code: "WRONG_NETWORK" });
      expect(new XrplReadAdapter(env).xrplNetwork).toBe("testnet");
    });
  });
  it("rejects invalid user input before opening a socket", async () => {
    const f = fixture(); const adapter = new XrplReadAdapter(env, f.factory);
    await expect(adapter.getAccount("invalid")).rejects.toMatchObject({ code: "INVALID_ADDRESS" });
    await expect(adapter.lookupTransaction("invalid")).rejects.toMatchObject({ code: "INVALID_HASH" });
    expect(f.factory).not.toHaveBeenCalled();
  });
  it("uses one validated ledger for account and dynamic reserve settings", async () => {
    const f = fixture(); const snapshot = await new XrplReadAdapter(env, f.factory).getAccount(address);
    expect(snapshot).toMatchObject({ funded: true, balanceDrops: "12000000", reserveDrops: "1600000", spendableDrops: "10400000", sequence: 123, requiresDestinationTag: true, validatedLedgerHash: hash });
    for (const command of ["account_info", "ledger_entry"]) expect(f.request.mock.calls.find(([r]) => r.command === command)?.[0].ledger_hash).toBe(hash);
    expect(f.client.disconnect).toHaveBeenCalledOnce();
  });
  it("supports integer legacy reserves, exact large balances and clamp-to-zero", async () => {
    const f = fixture((req, value) => {
      if (req.command === "ledger_entry") return anchored({ node: { LedgerEntryType: "FeeSettings", ReserveBase: 1000000, ReserveIncrement: 200000 } });
      if (req.command === "account_info") (value.account_data as any).Balance = "9007199254740993";
      return value;
    });
    expect((await new XrplReadAdapter(env, f.factory).getAccount(address)).spendableDrops).toBe("9007199253140993");
    const low = fixture((req, value) => { if (req.command === "account_info") (value.account_data as any).Balance = "1"; return value; });
    expect((await new XrplReadAdapter(env, low.factory).getAccount(address)).spendableDrops).toBe("0");
  });
  it("reads validated master/regular/multisign and destination policy settings",async()=>{
    const f=fixture((req,value)=>{
      if(req.command==="account_info")return {...value,signer_lists:[{}],account_data:{...(value.account_data as object),Flags:0x00100000|0x01000000|0x00080000,RegularKey:address}};
      return value;
    });
    expect(await new XrplReadAdapter(env,f.factory).getAccount(address)).toMatchObject({masterDisabled:true,hasRegularKey:true,hasSignerList:true,depositAuth:true,disallowIncomingXrp:true});
    expect(f.request.mock.calls.find(([r])=>r.command==="account_info")?.[0]).toMatchObject({signer_lists:true});
  });
  it("distinguishes a confirmed unfunded account from an unavailable server", async () => {
    const f = fixture((req, value) => { if (req.command === "account_info") throw missing("actNotFound"); return value; });
    expect(await new XrplReadAdapter(env, f.factory).getAccount(address)).toMatchObject({ funded: false, balanceDrops: "0", reserveDrops: "1000000", sequence: null });
    const failed = fixture((req, value) => { if (req.command === "account_info") throw new Error("secret-looking raw error"); return value; });
    await expect(new XrplReadAdapter(env, failed.factory).getAccount(address)).rejects.toMatchObject({ code: "XRPL_UNAVAILABLE", message: "XRPL_UNAVAILABLE" });
  });
  it.each(["Sponsor", "SponsoredOwnerCount", "AMMID", "VaultID"])("refuses unsupported account reserve rules: %s", async (field) => {
    const f = fixture((req, value) => { if (req.command === "account_info") (value.account_data as any)[field] = 1; return value; });
    await expect(new XrplReadAdapter(env, f.factory).getAccount(address)).rejects.toMatchObject({ code: "UNSUPPORTED_ACCOUNT" });
  });
  it("rejects wrong networks, stale clocks and unvalidated/mismatched snapshots", async () => {
    const cases = [
      fixture((req, value) => { if (req.command === "server_info") (value.info as any).network_id = 0; return value; }),
      fixture((req, value) => { if (req.command === "server_info") (value.info as any).validated_ledger.age = 90; return value; }),
      fixture((req, value) => { if (req.command === "ledger") (value.ledger as any).close_time = closeTime() - 90; return value; }),
      fixture((req, value) => req.command === "account_info" ? { ...value, validated: false } : value),
      fixture((req, value) => req.command === "ledger_entry" ? { ...value, ledger_hash: "C".repeat(64) } : value),
      fixture((req, value) => { if (req.command === "account_info") (value.account_data as any).Account = "another"; return value; }),
    ];
    for (const f of cases) { await expect(new XrplReadAdapter(env, f.factory).getAccount(address)).rejects.toThrow(); expect(f.client.disconnect).toHaveBeenCalledOnce(); }
  });
  it("retries a whole read on a fresh fallback connection and closes both", async () => {
    const first = fixture(); first.client.connect.mockRejectedValue(new Error("offline")); const second = fixture();
    const factory = vi.fn().mockReturnValueOnce(first.client).mockReturnValueOnce(second.client);
    const health = await new XrplReadAdapter({ XRPL_ENABLED: "true" }, factory).getHealth();
    expect(health).toMatchObject({ status: "healthy", endpoint: TESTNET_ENDPOINTS[1] });
    expect(first.client.disconnect).toHaveBeenCalledOnce(); expect(second.client.disconnect).toHaveBeenCalledOnce();
  });
  it("sanitizes connection-construction failures and bounds slow cleanup", async () => {
    await expect(new XrplReadAdapter(env, () => { throw new Error("do not expose transport internals"); }).getHealth()).rejects.toMatchObject({ code: "XRPL_UNAVAILABLE", message: "XRPL_UNAVAILABLE" });
    vi.useFakeTimers(); const f = fixture(); f.client.disconnect.mockImplementation(() => new Promise(() => {}));
    const pending = new XrplReadAdapter(env, f.factory).getHealth();
    await vi.advanceTimersByTimeAsync(1001);
    expect(await pending).toMatchObject({ status: "healthy" });
  });
  it("bounds a hung operation and suppresses late follow-up requests", async () => {
    vi.useFakeTimers(); const f = fixture(); let connected!: () => void;
    f.client.connect.mockImplementation(() => new Promise<void>((resolve) => { connected = resolve; }));
    const pending = new XrplReadAdapter({ ...env, XRPL_TIMEOUT_MS: "1000" }, f.factory).getHealth();
    const assertion = expect(pending).rejects.toMatchObject({ code: "XRPL_UNAVAILABLE" });
    await vi.advanceTimersByTimeAsync(1001); await assertion;
    connected(); await vi.advanceTimersByTimeAsync(1);
    expect(f.request).not.toHaveBeenCalled(); expect(f.client.disconnect).toHaveBeenCalledOnce();
  });
  it("uses the base/open-ledger fee without treating the historical median as a required fee", async () => {
    const f = fixture(); expect(await new XrplReadAdapter(env, f.factory).getFee()).toMatchObject({ feeDrops: "12", currentLedgerIndex: 1235 });
    const invalid = fixture((req, value) => req.command === "fee" ? { ...value, drops: { base_fee: "10", open_ledger_fee: "1.2", median_fee: "1" } } : value);
    await expect(new XrplReadAdapter(env, invalid.factory).getFee()).rejects.toMatchObject({ code: "INVALID_LEDGER_RESPONSE" });
  });
  it("separates validated success, ledger failure, pending and nonauthoritative not-found", async () => {
    const f = fixture(); expect(await new XrplReadAdapter(env, f.factory).lookupTransaction(txHash)).toMatchObject({ status: "validated", resultCode: "tesSUCCESS", ledgerHash: hash });
    const failure = fixture((req, value) => req.command === "tx" ? { ...value, meta: { TransactionResult: "tecPATH_DRY" } } : value);
    expect(await new XrplReadAdapter(env, failure.factory).lookupTransaction(txHash)).toMatchObject({ status: "validated", resultCode: "tecPATH_DRY" });
    const pending = fixture((req, value) => req.command === "tx" ? { hash: txHash, validated: false } : value);
    expect(await new XrplReadAdapter(env, pending.factory).lookupTransaction(txHash)).toMatchObject({ status: "pending", authoritative: false, validated: false });
    const absent = fixture((req, value) => { if (req.command === "tx") throw missing("txnNotFound"); return value; });
    expect(await new XrplReadAdapter(env, absent.factory).lookupTransaction(txHash)).toMatchObject({ status: "not_found", authoritative: false, validated: false });
  });
  it("rejects mismatched hashes and malformed metadata instead of issuing a receipt", async () => {
    for (const tx of [{ hash, validated: true }, { hash: txHash, validated: true, ledger_index: 1234, tx_json: {}, meta: "binary" }]) {
      const f = fixture((req, value) => req.command === "tx" ? tx : value);
      await expect(new XrplReadAdapter(env, f.factory).lookupTransaction(txHash)).rejects.toMatchObject({ code: "INVALID_LEDGER_RESPONSE" });
    }
  });
});
