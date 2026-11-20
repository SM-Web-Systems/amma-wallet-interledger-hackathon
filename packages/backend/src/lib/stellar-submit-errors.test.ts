import { describe, it, expect } from "vitest";
import { AxiosError } from "axios";
import { Asset, BadResponseError } from "@stellar/stellar-sdk";
import { mapStellarSubmitError, stellarResultCodes, StellarSubmitUncertain } from "./stellar-submit-errors";

// The shape stellar-sdk's Horizon client rejects with: an AxiosError whose response.data is Horizon's problem body.
function horizon(codes: Record<string, unknown>, status = 400) {
  return new AxiosError(`Request failed with status code ${status}`, "ERR_BAD_REQUEST", undefined, undefined, {
    status, statusText: "Bad Request", headers: {}, config: {} as any,
    data: { title: "Transaction Failed", status, extras: { envelope_xdr: "AAAASECRETXDR", result_codes: codes } },
  } as any);
}
const usd = new Asset("USD", "GBBM6BKZPEHWYO3E3YKREDPQXMS4VK35YLNU7NFBRI26RAN7GI5POFBB");
const payOps = (asset: Asset) => [{ type: "payment", asset }];

describe("mapStellarSubmitError", () => {
  it.each([
    [{ transaction: "tx_failed", operations: ["op_no_destination"] }, 400, "op_no_destination", /account doesn't exist yet\. Send at least 1 XLM/],
    [{ transaction: "tx_failed", operations: ["op_underfunded"] }, 400, "op_underfunded", /Not enough funds/],
    [{ transaction: "tx_insufficient_balance" }, 400, "tx_insufficient_balance", /Not enough XLM/],
    [{ transaction: "tx_failed", operations: ["op_low_reserve"] }, 400, "op_low_reserve", /too small to create a new account/],
    [{ transaction: "tx_failed", operations: ["op_no_trust"] }, 400, "op_no_trust", /can't accept this asset yet \(no trustline\)/],
    [{ transaction: "tx_failed", operations: ["op_not_authorized"] }, 400, "op_not_authorized", /can't accept this asset yet/],
    [{ transaction: "tx_failed", operations: ["op_line_full"] }, 400, "op_line_full", /limit/],
    [{ transaction: "tx_bad_seq" }, 409, "tx_bad_seq", /busy with another transaction/],
    [{ transaction: "tx_insufficient_fee" }, 503, "tx_insufficient_fee", /fee was too low/],
    [{ transaction: "tx_too_late" }, 400, "tx_too_late", /expired/],
    [{ transaction: "tx_bad_auth" }, 400, "tx_bad_auth", /signature/],
    [{ transaction: "tx_failed", operations: ["op_src_not_authorized"] }, 400, "op_src_not_authorized", /not authorized/],
    [{ transaction: "tx_failed", operations: ["op_already_exists"] }, 400, "op_already_exists", /just created\. Send again\./],
    [{ transaction: "tx_something_new" }, 400, "tx_something_new", /rejected this transaction \(tx_something_new\)\./],
  ])("maps %j", (codes, status, code, msg) => {
    const m = mapStellarSubmitError(horizon(codes))!;
    expect(m.status).toBe(status);
    expect(m.code).toBe(code);
    expect(m.error).toMatch(msg);
  });

  it("also reads the problem body when stellar-sdk wraps it in a BadResponseError", () => {
    const err = new BadResponseError("Transaction submission failed. Server responded: 400 Bad Request",
      { extras: { result_codes: { transaction: "tx_failed", operations: ["op_no_destination"] } } });
    expect(mapStellarSubmitError(err)!.code).toBe("op_no_destination");
  });

  it("prefers the operation code over tx_failed and skips op_success", () => {
    expect(mapStellarSubmitError(horizon({ transaction: "tx_failed", operations: ["op_success", "op_underfunded"] }))!.code).toBe("op_underfunded");
  });

  it("reads inner_transaction and operations of a fee-bumped transaction (Horizon's real shape)", () => {
    const failedOp = mapStellarSubmitError(horizon({ transaction: "tx_fee_bump_inner_failed", inner_transaction: "tx_failed", operations: ["op_no_destination"] }), { feeBumped: true })!;
    expect(failedOp.code).toBe("op_no_destination");
    expect(failedOp.status).toBe(400);
    const innerOnly = mapStellarSubmitError(horizon({ transaction: "tx_fee_bump_inner_failed", inner_transaction: "tx_bad_seq" }), { feeBumped: true })!;
    expect(innerOnly.code).toBe("tx_bad_seq");
  });

  it.each(["tx_insufficient_balance", "tx_insufficient_fee"])("outer %s on a fee bump is the platform's fee account, not the user's wallet", (outer) => {
    const m = mapStellarSubmitError(horizon({ transaction: outer }), { feeBumped: true })!;
    expect(m).toMatchObject({ status: 503, platform: true, code: outer, error: "Amma couldn't pay the network fee right now. Try again later." });
    expect(m.error).not.toMatch(/your wallet/i);
  });

  describe("op_underfunded names the asset", () => {
    const err = horizon({ transaction: "tx_failed", operations: ["op_underfunded"] });
    it("keeps the XLM reserve explanation for native", () => {
      expect(mapStellarSubmitError(err, { operations: payOps(Asset.native()) })!.error).toMatch(/Not enough XLM.*keep 1 XLM/);
    });
    it("says Not enough USD for a token, without the XLM reserve text", () => {
      const m = mapStellarSubmitError(err, { operations: payOps(usd) })!;
      expect(m.error).toBe("Not enough USD.");
    });
    it("uses the failed operation, not the first one", () => {
      const two = horizon({ transaction: "tx_failed", operations: ["op_success", "op_underfunded"] });
      expect(mapStellarSubmitError(two, { operations: [...payOps(Asset.native()), ...payOps(usd)] })!.error).toBe("Not enough USD.");
    });
    it("is neutral when the asset is not known", () => {
      expect(mapStellarSubmitError(err)!.error).toBe("Not enough funds for this payment.");
    });
  });

  it("op_no_destination for a token asks the recipient to activate first", () => {
    const err = horizon({ transaction: "tx_failed", operations: ["op_no_destination"] });
    expect(mapStellarSubmitError(err, { operations: payOps(usd) })!.error).toBe("The recipient must activate their account first.");
  });

  it("an unknown submit outcome says the network didn't confirm and does not claim failure", () => {
    const m = mapStellarSubmitError(new StellarSubmitUncertain())!;
    expect(m.status).toBe(504);
    expect(m.error).toBe("The Stellar network didn't confirm in time. Check your history before trying again.");
    expect(m.error).not.toMatch(/fail/i);
  });

  it("does not turn arbitrary errors, even timeouts from elsewhere, into 'didn't confirm'", () => {
    expect(mapStellarSubmitError(new AxiosError("timeout", "ECONNABORTED"))).toBeNull();
    expect(mapStellarSubmitError(new Error("db down"))).toBeNull();
    expect(mapStellarSubmitError(null)).toBeNull();
    expect(mapStellarSubmitError({ response: { status: 400, data: { title: "x" } } })).toBeNull();
  });

  it("never puts XDR or addresses in the output", () => {
    const err = horizon({ transaction: "tx_failed", operations: ["op_no_destination"] });
    err.message = "GABC123 failed";
    expect(JSON.stringify(mapStellarSubmitError(err))).not.toMatch(/SECRETXDR|GABC123/);
    expect(stellarResultCodes(err)).toEqual({ transaction: "tx_failed", operations: ["op_no_destination"] });
  });
});
