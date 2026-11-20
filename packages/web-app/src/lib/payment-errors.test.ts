import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { paymentErrorText } from "./payment-display";

const codeError = (code: string) => Object.assign(new Error(code.replaceAll("_", " ")), { code });

describe("paymentErrorText", () => {
  it("turns the common codes into a plain sentence and a next step", () => {
    expect(paymentErrorText(codeError("INSUFFICIENT_SPENDABLE_LIQUIDITY"))).toBe(
      "Your available funds cannot cover this payment, including network fees. Check your balances, add funds if needed, then get a new quote.",
    );
    expect(paymentErrorText(codeError("INVOICE_ALREADY_IN_PROGRESS"))).toBe(
      "This payment is already being processed. Check your payment history before trying again.",
    );
    expect(paymentErrorText(codeError("INVOICE_EXPIRED"))).toBe(
      "This payment request has expired. Ask the shop for a new QR code or link.",
    );
    expect(paymentErrorText(codeError("QUOTE_EXPIRED"))).toMatch(/quote has expired.*Refresh the quote/);
  });

  it("works from the message alone when the error carries no code", () => {
    expect(paymentErrorText(new Error("INVOICE EXPIRED"))).toMatch(/payment request has expired/);
  });

  it("never shows an unknown code as the headline, but keeps it as a reference for support", () => {
    const text = paymentErrorText(codeError("SOME_NEW_BACKEND_FAULT"));
    expect(text).toMatch(/^We could not complete this payment\./);
    expect(text).toContain("SOME_NEW_BACKEND_FAULT");
    expect(text).not.toMatch(/^SOME/);
  });

  it("leaves plain sentences from the wallet alone", () => {
    expect(paymentErrorText(new Error("Funding wallet or network changed."))).toBe("Funding wallet or network changed.");
    expect(paymentErrorText(new Error("Enter a valid amount."))).toBe("Enter a valid amount.");
  });

  it("copes with things that are not errors", () => {
    expect(paymentErrorText(undefined)).toMatch(/^We could not complete this payment\./);
    expect(paymentErrorText("INVOICE EXPIRED")).toMatch(/payment request has expired/);
  });

  it("explains the reasons the backend records on a failed execution", () => {
    expect(paymentErrorText(codeError("APPROVAL_EXPIRED"))).toMatch(/took too long to finish.*Return available funds/);
    expect(paymentErrorText(codeError("QUOTE_EXCEEDS_APPROVAL"))).toMatch(/price changed.*Return available funds/);
  });

  it("points people at their history, not a blind retry, when a payment may already be moving", () => {
    for (const code of ["INVOICE_ALREADY_IN_PROGRESS", "QUOTE_ALREADY_APPROVED", "IDEMPOTENCY_CONFLICT", "PAYMENT_SERVICE_UNAVAILABLE"]) {
      expect(paymentErrorText(codeError(code))).toMatch(/payment history/);
    }
    for (const code of ["PAYMENT_UNRESOLVED", "FUNDING_UNRESOLVED"]) {
      expect(paymentErrorText(codeError(code))).toMatch(/still being processed.*payment history/);
    }
  });

  it("keeps the single-payment limit apart from the daily one", () => {
    expect(paymentErrorText(codeError("PAYMENT_LIMIT_EXCEEDED"))).not.toMatch(/tomorrow/);
    expect(paymentErrorText(codeError("DAILY_PAYMENT_LIMIT_EXCEEDED"))).toMatch(/tomorrow/);
  });
});

describe("Payments page", () => {
  const src = readFileSync(join(__dirname, "../pages/Payments.tsx"), "utf8");
  it("never shows a raw error message", () => {
    expect(src).not.toMatch(/setError\(\s*e\.message\s*\)/);
    expect(src).not.toMatch(/setError\(\s*\(e as Error\)\.message\s*\)/);
    expect(src).toContain("paymentErrorText(");
  });
  it("the consent page does not show raw codes either", () => {
    const consent = readFileSync(join(__dirname, "../pages/PaymentConsent.tsx"), "utf8");
    expect(consent).not.toMatch(/setError\(\s*e\.message\s*\)/);
    expect(consent).not.toMatch(/setError\(\s*\(e as Error\)\.message\s*\)/);
    expect(consent).toContain("paymentErrorText(");
  });
  it("says why a payment failed or needs recovery", () => {
    expect(src).toMatch(/execution\.error&&\['failed','recovery'\]\.includes\(execution\.state\)&&<p role="alert"[^>]*>\{paymentErrorText\(\{code:execution\.error\}\)\}/);
  });
});

describe("request()", () => {
  it("keeps the backend's error code on the thrown error, and leaves other errors without one", async () => {
    const { request } = await import("./api");
    const answer = (status: number, body: unknown) => vi.fn(async () => new Response(JSON.stringify(body), { status }));
    vi.stubGlobal("fetch", answer(400, { error: { code: "INVOICE_EXPIRED", message: "INVOICE EXPIRED" } }));
    const withCode = await request("/api/v1/payments/x").catch((e) => e);
    expect(withCode).toBeInstanceOf(Error);
    expect(withCode.message).toBe("INVOICE EXPIRED");
    expect(withCode.code).toBe("INVOICE_EXPIRED");
    vi.stubGlobal("fetch", answer(500, { error: "plain text" }));
    const plain = await request("/api/v1/other").catch((e) => e);
    expect(plain.message).toBe("plain text");
    expect(plain.code).toBeUndefined();
    vi.unstubAllGlobals();
  });
});
