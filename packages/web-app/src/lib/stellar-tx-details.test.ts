import { describe, expect, it, vi } from "vitest";
import {
  explorerTxUrl, extractTxHash, mapHorizonTx, fetchTxDetails, fetchTxDetailsWithRetry, hasOperationId, historyDetailPath,
} from "./stellar-tx-details";

const HASH = "d02a0de8e5d6" + "a".repeat(52);
const ISSUER = "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN";
const A = "GBRPYHIL2CI3FNQ4BXLFMNDLFJUNPU2HY3ZMFSHONUCEOASW7QC7OX2H";
const B = "GDQP2KPQGKIHYJGXNUIYOMHARUARCA7DJT5FO2FFOOKY3B2WSQHG4W37";

const baseTx = {
  id: HASH, hash: HASH, successful: true, ledger: 55123456, created_at: "2026-11-16T05:36:12Z",
  source_account: A, fee_account: A, fee_charged: "100", max_fee: "100000",
  memo_type: "hash", memo: Buffer.from("ab".repeat(32), "hex").toString("base64"),
};
const payment = {
  id: "281344426885435393", type: "payment", transaction_hash: HASH, from: A, to: B,
  amount: "0.1000000", asset_type: "native", source_account: A,
};

describe("explorerTxUrl / historyDetailPath", () => {
  it("uses the public path on mainnet and the testnet path on testnet", () => {
    expect(explorerTxUrl("public", HASH)).toBe(`https://stellar.expert/explorer/public/tx/${HASH}`);
    expect(explorerTxUrl("testnet", HASH)).toBe(`https://stellar.expert/explorer/testnet/tx/${HASH}`);
  });
  it("points the success panel at the History detail for the hash", () => {
    expect(historyDetailPath(HASH)).toBe(`/history?tx=${HASH}`);
  });
});

describe("extractTxHash", () => {
  it("finds the hash in a Horizon submit result, the server wrapper and a bare string", () => {
    expect(extractTxHash({ hash: HASH })).toBe(HASH);
    expect(extractTxHash({ success: true, result: { hash: HASH } })).toBe(HASH);
    expect(extractTxHash({ success: true, result: { id: HASH } })).toBe(HASH);
    expect(extractTxHash({ success: true })).toBeNull();
    expect(extractTxHash({ hash: "nope" })).toBeNull();
    expect(extractTxHash(null)).toBeNull();
  });
});

describe("mapHorizonTx", () => {
  it("maps a native payment: operation id, amount, destination, fee in XLM, ledger, time, hash memo as full hex", () => {
    const d = mapHorizonTx(baseTx, [payment], "public");
    expect(d.hash).toBe(HASH);
    expect(d.ledger).toBe(55123456);
    expect(d.createdAt).toBe("2026-11-16T05:36:12Z");
    expect(d.feeXlm).toBe("0.0000100");
    expect(d.memo).toEqual({ type: "hash", value: "ab".repeat(32) });
    expect(d.explorerUrl).toBe(`https://stellar.expert/explorer/public/tx/${HASH}`);
    expect(d.feeBump).toBeNull();
    expect(d.operations).toHaveLength(1);
    expect(d.operations[0]).toMatchObject({
      id: "281344426885435393", type: "payment", amount: "0.1000000", assetCode: "XLM", assetIssuer: null, destination: B,
    });
    expect(hasOperationId(d.operations[0])).toBe(true);
  });

  it("maps a credit-asset payment with a text memo and none memo", () => {
    const op = { ...payment, asset_type: "credit_alphanum4", asset_code: "USDC", asset_issuer: ISSUER };
    const d = mapHorizonTx({ ...baseTx, memo_type: "text", memo: "invoice 7" }, [op], "testnet");
    expect(d.operations[0]).toMatchObject({ assetCode: "USDC", assetIssuer: ISSUER });
    expect(d.memo).toEqual({ type: "text", value: "invoice 7" });
    expect(d.explorerUrl).toContain("/explorer/testnet/tx/");
    expect(mapHorizonTx({ ...baseTx, memo_type: "none", memo: undefined }, [op], "public").memo).toEqual({ type: "none", value: "" });
  });

  it("maps create_account (starting balance is the amount, account is the destination)", () => {
    const op = { id: "1000", type: "create_account", funder: A, account: B, starting_balance: "5.0000000", source_account: A };
    const d = mapHorizonTx(baseTx, [op], "public");
    expect(d.operations[0]).toMatchObject({ id: "1000", type: "create_account", amount: "5.0000000", assetCode: "XLM", destination: B });
    expect(hasOperationId(d.operations[0])).toBe(true);
  });

  it("maps path_payment_strict_send with the delivered amount and the source amount", () => {
    const op = {
      id: "2000", type: "path_payment_strict_send", from: A, to: B, amount: "9.5000000", source_amount: "10.0000000",
      asset_type: "credit_alphanum4", asset_code: "USDC", asset_issuer: ISSUER, source_asset_type: "native",
    };
    const d = mapHorizonTx(baseTx, [op], "public");
    expect(d.operations[0]).toMatchObject({
      id: "2000", type: "path_payment_strict_send", amount: "9.5000000", assetCode: "USDC", assetIssuer: ISSUER,
      sourceAmount: "10.0000000", sourceAssetCode: "XLM", destination: B,
    });
    expect(hasOperationId(d.operations[0])).toBe(true);
  });

  it("maps a fee-bump transaction: outer fee is shown, inner hash and fee source are kept", () => {
    const INNER = "b".repeat(64);
    const tx = {
      ...baseTx, fee_account: B, fee_charged: "200", memo_type: "id", memo: "42",
      fee_bump_transaction: { hash: HASH, max_fee: "200000" }, inner_transaction: { hash: INNER, max_fee: "100" },
    };
    const d = mapHorizonTx(tx, [payment], "public");
    expect(d.feeXlm).toBe("0.0000200");
    expect(d.feeBump).toEqual({ outerHash: HASH, innerHash: INNER, feeAccount: B });
    expect(d.memo).toEqual({ type: "id", value: "42" });
  });

  it("does not offer an operation id for operations that are not payments", () => {
    const d = mapHorizonTx(baseTx, [{ id: "3", type: "change_trust", asset_type: "credit_alphanum4", asset_code: "USDC", asset_issuer: ISSUER }], "public");
    expect(hasOperationId(d.operations[0])).toBe(false);
  });

  it("flags a failed transaction", () => {
    expect(mapHorizonTx({ ...baseTx, successful: false }, [payment], "public").successful).toBe(false);
  });
});

const res = (status: number, body: unknown) => ({ ok: status >= 200 && status < 300, status, json: async () => body }) as unknown as Response;

describe("fetchTxDetails", () => {
  it("calls the transaction and its operations on the configured Horizon and maps them", async () => {
    const f = vi.fn(async (url: string) => (url.includes("/operations") ? res(200, { _embedded: { records: [payment] } }) : res(200, baseTx)));
    const d = await fetchTxDetails("testnet", HASH, f as never);
    expect(f.mock.calls.map((c) => c[0])).toEqual([
      `https://horizon-testnet.stellar.org/transactions/${HASH}`,
      `https://horizon-testnet.stellar.org/transactions/${HASH}/operations?limit=200`,
    ]);
    expect(d?.operations[0].id).toBe("281344426885435393");
  });

  it("returns null while Horizon has not ingested the transaction (404)", async () => {
    expect(await fetchTxDetails("public", HASH, (async () => res(404, {})) as never)).toBeNull();
  });

  it("throws on other errors without leaking the response body", async () => {
    await expect(fetchTxDetails("public", HASH, (async () => res(500, { secret: "x" })) as never)).rejects.toThrow(/^Horizon error: 500$/);
  });
});

describe("fetchTxDetailsWithRetry", () => {
  it("retries a bounded number of times, then gives up with null", async () => {
    const f = vi.fn(async () => res(404, {}));
    const sleep = vi.fn(async () => {});
    expect(await fetchTxDetailsWithRetry("public", HASH, { fetchImpl: f as never, attempts: 4, delayMs: 10, sleep })).toBeNull();
    expect(f).toHaveBeenCalledTimes(4);
    expect(sleep).toHaveBeenCalledTimes(3);
  });

  it("returns the details as soon as Horizon has them", async () => {
    let n = 0;
    const f = vi.fn(async (url: string) => {
      if (url.includes("/operations")) return res(200, { _embedded: { records: [payment] } });
      return ++n < 3 ? res(404, {}) : res(200, baseTx);
    });
    const d = await fetchTxDetailsWithRetry("public", HASH, { fetchImpl: f as never, attempts: 6, delayMs: 1, sleep: async () => {} });
    expect(d?.hash).toBe(HASH);
    expect(n).toBe(3);
  });

  it("stops when aborted", async () => {
    const ac = new AbortController();
    ac.abort();
    const f = vi.fn(async () => res(404, {}));
    expect(await fetchTxDetailsWithRetry("public", HASH, { fetchImpl: f as never, signal: ac.signal, sleep: async () => {} })).toBeNull();
    expect(f).not.toHaveBeenCalled();
  });
});

describe("platform fee operation", () => {
  const PLATFORM = "GAPLATFORMWALLETXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX";
  const fee = { id: "10", type: "payment", from: A, to: PLATFORM, amount: "0.0001000", asset_type: "native" };
  it("flags the payment to the platform wallet and lists the user's payment first", () => {
    const d = mapHorizonTx(baseTx, [fee, { ...payment, id: "9" }], "public", PLATFORM);
    expect(d.operations.map((o) => [o.id, o.platformFee])).toEqual([["9", false], ["10", true]]);
  });
  it("flags nothing when no platform wallet is configured", () => {
    expect(mapHorizonTx(baseTx, [fee, payment], "public").operations.every((o) => !o.platformFee)).toBe(true);
  });
});

describe("retry on transient errors", () => {
  it("retries 429, 5xx and network errors, and passes the abort signal to fetch", async () => {
    let n = 0;
    const seen: unknown[] = [];
    const f = vi.fn(async (url: string, init?: RequestInit) => {
      seen.push(init?.signal);
      if (url.includes("/operations")) return res(200, { _embedded: { records: [payment] } });
      n++;
      if (n === 1) return res(429, {});
      if (n === 2) return res(503, {});
      if (n === 3) throw new TypeError("network");
      return res(200, baseTx);
    });
    const ac = new AbortController();
    const sleep = vi.fn(async () => {});
    const d = await fetchTxDetailsWithRetry("public", HASH, { fetchImpl: f as never, attempts: 6, delayMs: 1, sleep, signal: ac.signal });
    expect(d?.hash).toBe(HASH);
    expect(n).toBe(4);
    expect(seen.every((x) => x === ac.signal)).toBe(true);
  });
  it("still gives up after the bounded attempts and does not retry a 400", async () => {
    const f = vi.fn(async () => res(503, {}));
    expect(await fetchTxDetailsWithRetry("public", HASH, { fetchImpl: f as never, attempts: 3, delayMs: 1, sleep: async () => {} })).toBeNull();
    expect(f).toHaveBeenCalledTimes(3);
    const g = vi.fn(async () => res(400, {}));
    await expect(fetchTxDetailsWithRetry("public", HASH, { fetchImpl: g as never, attempts: 3, delayMs: 1, sleep: async () => {} })).rejects.toThrow(/400/);
    expect(g).toHaveBeenCalledTimes(1);
  });
});
