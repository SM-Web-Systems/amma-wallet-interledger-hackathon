import { beforeEach, describe, expect, it, vi } from "vitest";
import { EXPIRY_GRACE_SECONDS, pendingSlot, classifySubmitError, clearPending, loadPending, lookupStellarTx, savePending, stellarTxUrl } from "./stellar-pending";

const H = "a".repeat(64);
const res = (status: number, body: unknown = {}) =>
  ({ ok: status >= 200 && status < 300, status, json: async () => body }) as unknown as Response;
const at = (seconds: number) => seconds * 1000;
const fetchOf = (f: unknown) => f as unknown as typeof fetch;

describe("lookupStellarTx", () => {
  it("is applied when Horizon has the transaction and it succeeded", async () => {
    const f = vi.fn(async () => res(200, { successful: true }));
    expect(await lookupStellarTx("https://horizon.example", { hash: H, maxTime: 100 }, at(50), fetchOf(f))).toBe("applied");
    expect(f).toHaveBeenCalledWith(`https://horizon.example/transactions/${H}`);
  });
  it("is failed when Horizon has it with successful false", async () => {
    const f = vi.fn(async () => res(200, { successful: false }));
    expect(await lookupStellarTx("h", { hash: H, maxTime: 100 }, at(50), fetchOf(f))).toBe("failed");
  });
  it("with the server's hash: waits on 404 until the time bound plus the grace period has passed, then says expired", async () => {
    const f = vi.fn(async () => res(404));
    const p = { hash: H, maxTime: 1000, serverHash: true };
    expect(await lookupStellarTx("h", p, at(1000 + EXPIRY_GRACE_SECONDS), fetchOf(f))).toBe("waiting");
    expect(await lookupStellarTx("h", p, at(1001 + EXPIRY_GRACE_SECONDS), fetchOf(f))).toBe("expired");
  });
  it("with only the browser's own hash: never says expired (the server may have submitted a different transaction), says unknown", async () => {
    const f = vi.fn(async () => res(404));
    expect(await lookupStellarTx("h", { hash: H, maxTime: 1000 }, at(1000 + EXPIRY_GRACE_SECONDS), fetchOf(f))).toBe("waiting");
    expect(await lookupStellarTx("h", { hash: H, maxTime: 1000 }, at(1001 + EXPIRY_GRACE_SECONDS), fetchOf(f))).toBe("unknown");
    expect(await lookupStellarTx("h", { hash: H, maxTime: 1000, serverHash: false }, at(99_999), fetchOf(f))).toBe("unknown");
  });
  it("finds a payment by the server's hash: applied even though it differs from the browser's envelope hash", async () => {
    const SERVER = "b".repeat(64);
    const f = vi.fn(async (url: string) => (url.endsWith(SERVER) ? res(200, { successful: true }) : res(404)));
    expect(await lookupStellarTx("https://horizon.example", { hash: SERVER, maxTime: 1000, serverHash: true }, at(5000), fetchOf(f))).toBe("applied");
    expect(f).toHaveBeenCalledWith(`https://horizon.example/transactions/${SERVER}`);
  });
  it("never says expired for a transaction without a time bound", async () => {
    const f = vi.fn(async () => res(404));
    expect(await lookupStellarTx("h", { hash: H, maxTime: 0 }, at(10_000_000), fetchOf(f))).toBe("waiting");
  });
  it("waits on a network error, a 5xx, or a body it cannot read", async () => {
    const down = vi.fn(async () => { throw new TypeError("Failed to fetch"); });
    expect(await lookupStellarTx("h", { hash: H, maxTime: 1 }, at(10_000), fetchOf(down))).toBe("waiting");
    const busy = vi.fn(async () => res(503));
    expect(await lookupStellarTx("h", { hash: H, maxTime: 1 }, at(10_000), fetchOf(busy))).toBe("waiting");
    const odd = vi.fn(async () => ({ ok: true, status: 200, json: async () => { throw new Error("bad json"); } }) as unknown as Response);
    expect(await lookupStellarTx("h", { hash: H, maxTime: 1 }, at(10_000), fetchOf(odd))).toBe("waiting");
  });
});

describe("pending store", () => {
  beforeEach(() => { localStorage.clear(); sessionStorage.clear(); });
  const p = { hash: H, maxTime: 1234, network: "testnet" as const, summary: "5 XLM to GABC...WXYZ" };
  it("saves, loads and clears a pending send per network and wallet", () => {
    savePending("GSOURCE", p);
    expect(localStorage.getItem("amma.stellarPending.testnet.GSOURCE")).toBe(JSON.stringify(p));
    expect(loadPending("testnet", "GSOURCE")).toEqual(p);
    expect(loadPending("public", "GSOURCE")).toBeNull();
    expect(loadPending("testnet", "GOTHER")).toBeNull();
    clearPending("testnet", "GSOURCE");
    expect(loadPending("testnet", "GSOURCE")).toBeNull();
  });
  it("keeps whether the hash came from the server; old records without the flag load as not from the server", () => {
    savePending("GSOURCE", { ...p, serverHash: true });
    expect(loadPending("testnet", "GSOURCE")).toEqual({ ...p, serverHash: true });
    localStorage.setItem("amma.stellarPending.testnet.GSOURCE", JSON.stringify(p));
    expect(loadPending("testnet", "GSOURCE")!.serverHash).toBeUndefined();
  });
  it("lives in localStorage, so every tab of this browser sees it (a new tab can't build a second payment)", () => {
    savePending("GSOURCE", { ...p, serverHash: true });
    expect(localStorage.getItem(pendingSlot("testnet", "GSOURCE"))).toContain(H);
    expect(sessionStorage.getItem(pendingSlot("testnet", "GSOURCE"))).toBeNull();
  });
  it("ignores a stored value that is not a pending send", () => {
    for (const raw of ["not json", JSON.stringify({ hash: "zz", maxTime: 1, network: "testnet", summary: "" }), JSON.stringify({ hash: H, network: "testnet" })]) {
      localStorage.setItem("amma.stellarPending.testnet.GSOURCE", raw);
      expect(loadPending("testnet", "GSOURCE")).toBeNull();
    }
  });
});

describe("stellarTxUrl", () => {
  it("links to Stellar Expert for the network", () => {
    expect(stellarTxUrl("testnet", H)).toBe(`https://stellar.expert/explorer/testnet/tx/${H}`);
    expect(stellarTxUrl("public", H)).toBe(`https://stellar.expert/explorer/public/tx/${H}`);
  });
});

describe("classifySubmitError", () => {
  const e = (props: Record<string, unknown>) => Object.assign(new Error("x"), props);
  it("is unknown when there was no answer, a timeout, a 5xx without a result code, or a reply it cannot read", () => {
    expect(classifySubmitError(new TypeError("Failed to fetch"), false)).toBe("unknown");
    expect(classifySubmitError(new SyntaxError("Unexpected token <"), false)).toBe("unknown");
    expect(classifySubmitError(e({ code: "timeout", status: 504, unreadable: false }), false)).toBe("unknown");
    expect(classifySubmitError(e({ status: 500, unreadable: false }), false)).toBe("unknown");
    expect(classifySubmitError(e({ status: 502, unreadable: true }), false)).toBe("unknown");
    expect(classifySubmitError(e({ status: 408, unreadable: true }), false)).toBe("unknown");
  });
  it("is rejected for a result code on the first send, and for an op_ code or a never-sent code on any send", () => {
    expect(classifySubmitError(e({ code: "tx_bad_seq", status: 409, unreadable: false }), false)).toBe("rejected");
    expect(classifySubmitError(e({ code: "tx_too_late", status: 400, unreadable: false }), false)).toBe("rejected");
    expect(classifySubmitError(e({ code: "tx_insufficient_fee", status: 503, unreadable: false }), false)).toBe("rejected");
    expect(classifySubmitError(e({ code: "op_underfunded", status: 400, unreadable: false }), true)).toBe("rejected");
    expect(classifySubmitError(e({ code: "recipient_check_failed", status: 503, unreadable: false }), true)).toBe("rejected");
    expect(classifySubmitError(e({ code: "account_requires_memo", status: 400, unreadable: false }), true)).toBe("rejected");
  });
  it("is unknown for any tx_ code on a re-send, because the first copy may have applied", () => {
    for (const code of ["tx_bad_seq", "tx_too_late", "tx_insufficient_fee", "tx_failed"]) {
      expect(classifySubmitError(e({ code, status: 400, unreadable: false }), true)).toBe("unknown");
    }
  });
  it("is retry for a refusal before the submit: wrong password, rate limit, or a code that is not a Stellar result", () => {
    expect(classifySubmitError(new Error("That password is not correct."), false)).toBe("retry");
    expect(classifySubmitError(e({ status: 429, unreadable: false }), true)).toBe("retry");
    expect(classifySubmitError(e({ code: "rate_limited", status: 429, unreadable: false }), true)).toBe("retry");
  });
});
