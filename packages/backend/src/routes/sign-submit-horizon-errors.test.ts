import { afterEach, describe, expect, it, vi } from "vitest";
import { serverSource } from "../test-support/server-source";
import Fastify from "fastify";
import { AxiosError } from "axios";
import { Asset } from "@stellar/stellar-sdk";
import { readFileSync } from "fs";
import { join } from "path";
import { setAppLogger } from "../lib/app-log";
import { replyToStellarSubmitError, replyToUnknownOutcome } from "../lib/stellar-submit-reply";
import { submitStellarTx } from "../lib/stellar-submit";

// server.ts is one bootstrap function, so this mounts the same submit + reply helpers its
// sign-and-submit route uses behind a route whose "Horizon" fails the way the real client does.
const SECRET = "SBSECRETSEEDDONOTLOGDONOTLOGDONOTLOGDONOTLOGDONOTLOGDONOT";
const XDR = "AAAAAgAAAAXDRENVELOPE";

function horizonError(codes: Record<string, unknown>) {
  return new AxiosError(`Request failed with status code 400 ${SECRET}`, "ERR_BAD_REQUEST", undefined, undefined, {
    status: 400, statusText: "Bad Request", headers: {}, config: {} as any,
    data: { extras: { envelope_xdr: XDR, result_codes: codes } },
  } as any);
}

async function post(submit: () => Promise<unknown>, ctx: object = {}) {
  const warn = vi.fn();
  const error = vi.fn();
  setAppLogger({ info: vi.fn(), warn, error });
  const app = Fastify();
  app.post("/sign-and-submit", async (request, reply) => {
    try {
      try {
        await submitStellarTx({ submitTransaction: submit as any }, "tx", { timeoutMs: 50, attempts: 2, retryDelayMs: 0 });
      } catch (err) {
        const sent = replyToStellarSubmitError(reply, err, 42, ctx);
        if (sent) return sent;
        throw err;
      }
      return { success: true };
    } catch {
      return reply.status(500).send({ error: "Failed to sign and submit" });
    }
  });
  const res = await app.inject({ method: "POST", url: "/sign-and-submit" });
  await app.close();
  return { res, warn, error };
}

afterEach(() => setAppLogger(null));

describe("sign-and-submit Horizon rejection", () => {
  it("returns 400 with a plain message for op_no_destination and logs only result codes", async () => {
    const { res, warn, error } = await post(async () => {
      throw horizonError({ transaction: "tx_failed", operations: ["op_no_destination"] });
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: "That account doesn't exist yet. Send at least 1 XLM to create it.", code: "op_no_destination" });
    expect(warn).toHaveBeenCalledWith(
      { resultCodes: { transaction: "tx_failed", operations: ["op_no_destination"] }, userId: 42 },
      "stellar submit rejected",
    );
    const logged = JSON.stringify([...warn.mock.calls, ...error.mock.calls]);
    expect(logged).not.toContain(SECRET);
    expect(logged).not.toContain(XDR);
    expect(JSON.stringify(res.json())).not.toContain(SECRET);
  });

  it("names the token for an underfunded token payment", async () => {
    const usd = new Asset("USD", "GBBM6BKZPEHWYO3E3YKREDPQXMS4VK35YLNU7NFBRI26RAN7GI5POFBB");
    const { res } = await post(async () => { throw horizonError({ transaction: "tx_failed", operations: ["op_underfunded"] }); },
      { operations: [{ type: "payment", asset: usd }] });
    expect(res.json().error).toBe("Not enough USD.");
  });

  it("alerts ops, and blames the service, when the platform fee account cannot pay", async () => {
    const { res, error } = await post(async () => { throw horizonError({ transaction: "tx_insufficient_balance" }); }, { feeBumped: true });
    expect(res.statusCode).toBe(503);
    expect(res.json().error).toBe("Amma couldn't pay the network fee right now. Try again later.");
    expect(error).toHaveBeenCalledWith({ resultCodes: { transaction: "tx_insufficient_balance" }, userId: 42 }, "platform fee account could not pay the network fee");
  });

  it("returns 504 without claiming failure when the request times out (no response on the error)", async () => {
    const { res } = await post(async () => { throw new AxiosError("timeout of 60000ms exceeded", "ECONNABORTED"); });
    expect(res.statusCode).toBe(504);
    expect(res.json().error).toMatch(/Check your history/);
    expect(res.json().error).not.toMatch(/fail/i);
  });

  it("returns 504 for a Horizon 504, after a bounded number of tries", async () => {
    const submit = vi.fn(async () => {
      throw new AxiosError("Request failed with status code 504", "ERR_BAD_RESPONSE", undefined, undefined, { status: 504, statusText: "", headers: {}, config: {} as any, data: {} } as any);
    });
    const { res } = await post(submit);
    expect(res.statusCode).toBe(504);
    expect(submit).toHaveBeenCalledTimes(2);
  });
});

describe("sign-and-submit unknown outcome", () => {
  const outer = { hash: () => Buffer.alloc(32, 1) };
  const inner = { hash: () => Buffer.alloc(32, 2) };
  async function postWith(fail: () => Promise<never>) {
    const warn = vi.fn();
    setAppLogger({ info: vi.fn(), warn, error: vi.fn() });
    const app = Fastify();
    app.post("/sign-and-submit", async (_request, reply) => {
      try {
        await submitStellarTx({ submitTransaction: fail as any }, "tx", { timeoutMs: 50, attempts: 2, retryDelayMs: 0 });
      } catch (err) {
        const unknown = replyToUnknownOutcome(reply, err, outer, inner, 42);
        if (unknown) return unknown;
        const sent = replyToStellarSubmitError(reply, err, 42);
        if (sent) return sent;
        throw err;
      }
      return { success: true };
    });
    const res = await app.inject({ method: "POST", url: "/sign-and-submit" });
    await app.close();
    return { res, warn };
  }

  it("returns 202 with the submitted and inner hashes when Horizon times out", async () => {
    const { res, warn } = await postWith(async () => { throw new AxiosError("timeout of 60000ms exceeded", "ECONNABORTED"); });
    expect(res.statusCode).toBe(202);
    expect(res.json()).toEqual({
      status: "unknown", hash: "01".repeat(32), innerHash: "02".repeat(32),
      error: "The Stellar network didn't confirm in time. We're checking whether the payment went through; don't send it again yet.",
    });
    expect(warn).toHaveBeenCalledWith({ userId: 42, hash: "01".repeat(32) }, "stellar submit outcome unknown");
  });

  it("leaves a definite rejection to the 400 mapping", async () => {
    const { res } = await postWith(async () => { throw horizonError({ transaction: "tx_failed", operations: ["op_underfunded"] }); });
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe("op_underfunded");
  });
});

describe("server.ts wiring", () => {
  const src = serverSource();
  it("submits through the bounded Horizon helper, not the wallet SDK that retries 504 forever", () => {
    expect(src).not.toContain(".submitTransaction(");
    expect(src.match(/submitStellarTx\(stellarClient\.horizon/g)).toHaveLength(2);
    expect(src.match(/replyToStellarSubmitError/g)!.length).toBeGreaterThanOrEqual(3);
  });
  it("has no console output left in the sign-and-submit handler and no stack logging", () => {
    const start = src.indexOf('"/api/v1/transactions/sign-and-submit"');
    const end = src.indexOf('"/api/v1/user/signing-mode"');
    expect(src.slice(start, end)).not.toMatch(/console\./);
    expect(src).not.toContain("[sign-and-submit] FULL ERROR");
  });
  it("releases the custody day reservation only for a definite rejection", () => {
    expect(src).toMatch(/custodyPath && isDefiniteStellarRejection\(submitErr\)[\s\S]{0,200}releaseCustodyDay/);
  });
  it("decodes /transactions/submit with the backend's own SDK, not the wallet SDK's copy", () => {
    expect(src).toContain("StellarSdk.TransactionBuilder.fromXDR(signedXdr, stellarClient.networkPassphrase)");
    expect(src).not.toContain("decodeTransaction(signedXdr)");
  });
  it("answers a non-Horizon /transactions/submit failure with a real 500", () => {
    expect(src).toContain('reply.status(500).send({ error: "Transaction submission failed" })');
  });
  it("answers an unknown outcome with 202 and the hashes before mapping other submit errors", () => {
    expect(src).toMatch(/replyToUnknownOutcome\(reply, submitErr, txToSubmit, finalTx, userId\)[\s\S]{0,2400}replyToStellarSubmitError\(reply, submitErr, userId/);
    const start = src.indexOf('"/api/v1/transactions/sign-and-submit"');
    const end = src.indexOf('"/api/v1/user/signing-mode"');
    expect(src.slice(start, end)).toContain('202: { type: "object", properties: { status: { type: "string" }, hash: { type: "string" }, innerHash: { type: "string" }, error: { type: "string" } } }');
  });
  it("keeps the client's sequence number when it rebuilds the transaction with platform fee operations", () => {
    const start = src.indexOf("── Platform Fee Injection ──");
    const end = src.indexOf("const refused = await signWithCustody(", start);
    const block = src.slice(start, end);
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    expect(block).not.toContain("loadAccount(");
    // The rebuild itself lives in lib/platform-fee.ts; the route passes the user's wallet as the source.
    expect(block).toContain("source: wallet.publicKey");
    const lib = readFileSync(join(__dirname, "..", "lib", "platform-fee.ts"), "utf-8");
    expect(lib).toContain("new StellarSdk.Account(o.source, (BigInt(tx.sequence) - 1n).toString())");
    expect(lib).not.toContain("loadAccount(o.source");
  });
  it("returns the submitted envelope's hash on success", () => {
    expect(src).toMatch(/success: true,\s*result,\s*hash: txToSubmit\.hash\(\)\.toString\("hex"\),/);
  });
});
