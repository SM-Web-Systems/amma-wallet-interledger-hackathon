import { describe, it, expect, vi } from "vitest";
import { AxiosError } from "axios";
import { Account, Asset, Keypair, Networks, Operation, TransactionBuilder, FeeBumpTransaction } from "@stellar/stellar-sdk";
import { submitStellarTx } from "./stellar-submit";
import { isSubmitUncertain, mapStellarSubmitError, stellarResultCodes } from "./stellar-submit-errors";
import { isDefiniteStellarRejection } from "./stellar-submit-reply";

const fast = { timeoutMs: 50, attempts: 2, retryDelayMs: 0, lookupTimeoutMs: 50, memoTimeoutMs: 50 };
const timeout = () => new AxiosError("timeout of 60000ms exceeded", "ECONNABORTED");
const http = (status: number, data: unknown = {}) =>
  new AxiosError(`Request failed with status code ${status}`, "ERR_BAD_RESPONSE", undefined, undefined, { status, statusText: "", headers: {}, config: {} as any, data } as any);
const codes = (c: Record<string, unknown>) => http(400, { extras: { result_codes: c } });
const rejected = codes({ transaction: "tx_failed", operations: ["op_no_destination"] });
const tx = { hash: () => Buffer.from("abcd", "hex") };
const horizon = (submit: any, extra: object = {}) => ({ submitTransaction: submit, ...extra });
const ledger = (call: () => Promise<unknown>) => ({ transactions: () => ({ transaction: (h: string) => ({ call: async () => { ledger.lastHash = h; return call(); } }) }) });
ledger.lastHash = "";

describe("submitStellarTx", () => {
  it("returns Horizon's answer", async () => {
    const submit = vi.fn(async () => ({ hash: "h" }));
    expect(await submitStellarTx(horizon(submit), tx, fast)).toEqual({ hash: "h" });
    expect(submit).toHaveBeenCalledWith(tx, { skipMemoRequiredCheck: true });
  });

  it("throws the original error at once when Horizon rejected with result codes, with no retry and no ledger lookup", async () => {
    const submit = vi.fn(async () => { throw rejected; });
    const lookup = vi.fn(async () => ({}));
    await expect(submitStellarTx(horizon(submit, ledger(lookup)), tx, fast)).rejects.toBe(rejected);
    expect(submit).toHaveBeenCalledTimes(1);
    expect(lookup).not.toHaveBeenCalled();
    expect(isDefiniteStellarRejection(rejected)).toBe(true);
  });

  it("does not retry other 4xx answers", async () => {
    const bad = http(400, { title: "Transaction Malformed" });
    const submit = vi.fn(async () => { throw bad; });
    await expect(submitStellarTx(horizon(submit), tx, fast)).rejects.toBe(bad);
    expect(submit).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["an axios timeout with no response", timeout],
    ["a connection reset", () => new AxiosError("socket hang up", "ECONNRESET")],
    ["a Horizon 504", () => http(504)],
    ["a Horizon 503", () => http(503)],
  ])("is unknown after %s, tried a bounded number of times", async (_n, make) => {
    const submit = vi.fn(async () => { throw make(); });
    const err = await submitStellarTx(horizon(submit), tx, fast).catch((e) => e);
    expect(isSubmitUncertain(err)).toBe(true);
    expect(isDefiniteStellarRejection(err)).toBe(false);
    expect(submit).toHaveBeenCalledTimes(2);
  });

  it("gives up on a request that never answers instead of hanging", async () => {
    const err = await submitStellarTx(horizon(vi.fn(() => new Promise(() => {}))), tx, fast).catch((e) => e);
    expect(isSubmitUncertain(err)).toBe(true);
  });

  it("succeeds when a retry gets through", async () => {
    const submit = vi.fn().mockRejectedValueOnce(http(504)).mockResolvedValueOnce({ hash: "h2" });
    expect(await submitStellarTx(horizon(submit), tx, fast)).toEqual({ hash: "h2" });
  });

  describe("a rejection after an earlier unknown attempt is checked against the ledger", () => {
    const tooLate = () => codes({ transaction: "tx_too_late" });
    const afterTimeout = (second: unknown) => vi.fn().mockRejectedValueOnce(timeout()).mockRejectedValueOnce(second);

    it("attempt 1 timed out, attempt 2 says tx_too_late, but the transaction was applied: success, never a rejection", async () => {
      const record = { hash: "abcd", successful: true, ledger: 7 };
      const result = await submitStellarTx(horizon(afterTimeout(tooLate()), ledger(async () => record)), tx, fast);
      expect(result).toBe(record);
      expect(ledger.lastHash).toBe("abcd");
    });

    it("tx_bad_seq after an unknown attempt is checked the same way", async () => {
      const record = { hash: "abcd", successful: true };
      expect(await submitStellarTx(horizon(afterTimeout(codes({ transaction: "tx_bad_seq" })), ledger(async () => record)), tx, fast)).toBe(record);
    });

    it("not on the ledger: unknown outcome, so it is not definite and nothing is released", async () => {
      const err = await submitStellarTx(horizon(afterTimeout(tooLate()), ledger(async () => { throw http(404, { status: 404 }); })), tx, fast).catch((e) => e);
      expect(isSubmitUncertain(err)).toBe(true);
      expect(isDefiniteStellarRejection(err)).toBe(false);
    });

    it("a lookup that itself fails is unknown too", async () => {
      const err = await submitStellarTx(horizon(afterTimeout(tooLate()), ledger(async () => { throw timeout(); })), tx, fast).catch((e) => e);
      expect(isSubmitUncertain(err)).toBe(true);
    });

    it("on the ledger but failed: definite, with a result code the user sees", async () => {
      const err = await submitStellarTx(horizon(afterTimeout(tooLate()), ledger(async () => ({ hash: "abcd", successful: false }))), tx, fast).catch((e) => e);
      expect(isDefiniteStellarRejection(err)).toBe(true);
      expect(stellarResultCodes(err)).toEqual({ transaction: "tx_failed" });
      expect(mapStellarSubmitError(err)!.status).toBe(400);
    });

    it("every attempt unknown but the ledger shows it applied: success", async () => {
      const record = { hash: "abcd", successful: true };
      const submit = vi.fn(async () => { throw timeout(); });
      expect(await submitStellarTx(horizon(submit, ledger(async () => record)), tx, fast)).toBe(record);
      expect(submit).toHaveBeenCalledTimes(2);
    });

    it("every attempt unknown and not on the ledger: unknown", async () => {
      const submit = vi.fn(async () => { throw timeout(); });
      const err = await submitStellarTx(horizon(submit, ledger(async () => { throw http(404); })), tx, fast).catch((e) => e);
      expect(isSubmitUncertain(err)).toBe(true);
    });
  });

  describe("recipient memo check fails closed", () => {
    const memo = Object.assign(new Error("memo"), { name: "AccountRequiresMemoError" });
    const submit = vi.fn(async () => ({ hash: "h" }));

    it("lets a memo-required error through before submitting", async () => {
      submit.mockClear();
      await expect(submitStellarTx(horizon(submit, { checkMemoRequired: async () => { throw memo; } }), tx, fast)).rejects.toBe(memo);
      expect(submit).not.toHaveBeenCalled();
      expect(isDefiniteStellarRejection(memo)).toBe(true);
      expect(mapStellarSubmitError(memo)).toMatchObject({ status: 400, error: expect.stringMatching(/requires a memo/) });
    });

    it.each([["a network error", () => Promise.reject(timeout())], ["a Horizon 500", () => Promise.reject(http(500))], ["a lookup that never answers", () => new Promise<void>(() => {})]])("refuses with 503 and sends nothing on %s", async (_n, check) => {
      submit.mockClear();
      const err = await submitStellarTx(horizon(submit, { checkMemoRequired: check }), tx, fast).catch((e) => e);
      expect(submit).not.toHaveBeenCalled();
      expect(mapStellarSubmitError(err)).toMatchObject({ status: 503, error: "Couldn't check the recipient right now. Try again.", code: "recipient_check_failed" });
      // Nothing was sent, so a custody reservation can be given back.
      expect(isDefiniteStellarRejection(err)).toBe(true);
      expect(isSubmitUncertain(err)).toBe(false);
    });

    it("submits when the check passes", async () => {
      submit.mockClear();
      expect(await submitStellarTx(horizon(submit, { checkMemoRequired: async () => {} }), tx, fast)).toEqual({ hash: "h" });
    });

    it("checks a fee-bump envelope decoded with this package's SDK (instanceof FeeBumpTransaction works)", async () => {
      const src = Keypair.random(), platform = Keypair.random();
      const inner = new TransactionBuilder(new Account(src.publicKey(), "1"), { fee: "100", networkPassphrase: Networks.PUBLIC })
        .addOperation(Operation.payment({ destination: Keypair.random().publicKey(), asset: Asset.native(), amount: "1" })).setTimeout(60).build();
      inner.sign(src);
      const bump = TransactionBuilder.buildFeeBumpTransaction(platform, "200", inner, Networks.PUBLIC);
      bump.sign(platform);
      const decoded = TransactionBuilder.fromXDR(bump.toXDR(), Networks.PUBLIC);
      expect(decoded instanceof FeeBumpTransaction).toBe(true);
      const check = vi.fn(async () => {});
      submit.mockClear();
      await submitStellarTx(horizon(submit, { checkMemoRequired: check }), decoded, fast);
      expect(check).toHaveBeenCalledWith(decoded);
      expect(submit).toHaveBeenCalledWith(decoded, { skipMemoRequiredCheck: true });
    });
  });
});
