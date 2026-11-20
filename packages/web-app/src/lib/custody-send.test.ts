import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

const req = vi.hoisted(() => ({ request: vi.fn() }));
vi.mock("./api", () => req);
import { dropsToXrp, ethToWei, weiToEth, xrpToDrops, sendCustodyEvm, sendCustodyXrp, listCustodyEvmTransfers, getXrpPaymentStatus, getCustodyXrpAccount } from "./custody-send";
import { CUSTODY_CHANGED, CUSTODY_SETUP_LIMIT_MS, ensureCustodyWallets } from "./custody-onboard";

describe("XRP routes by build", () => {
  afterEach(() => vi.unstubAllEnvs());
  it("reads payment status from the testnet payment route, or the custody route in an XRP mainnet build", async () => {
    req.request.mockReset(); req.request.mockResolvedValue({ state: "submitted" });
    await getXrpPaymentStatus("abc");
    expect(req.request).toHaveBeenLastCalledWith("/api/v1/xrpl/payment-intents/abc");
    vi.stubEnv("VITE_MAINNET_CUSTODY", "on"); vi.stubEnv("VITE_XRPL_MAINNET", "on");
    await getXrpPaymentStatus("abc");
    expect(req.request).toHaveBeenLastCalledWith("/api/v1/custody/xrpl/payments/abc");
  });
  it("reads an Amma-held wallet's activation by address", async () => {
    req.request.mockReset(); req.request.mockResolvedValue({ activated: false });
    await getCustodyXrpAccount("rABC");
    expect(req.request).toHaveBeenLastCalledWith("/api/v1/custody/xrpl/account?address=rABC");
  });
});

describe("exact amounts", () => {
  it("converts XRP to drops with string math", () => {
    expect(xrpToDrops("1")).toBe("1000000");
    expect(xrpToDrops("0.000001")).toBe("1");
    expect(xrpToDrops("12.345678")).toBe("12345678");
    expect(xrpToDrops("99999999999.999999")).toBe("99999999999999999");
    expect(xrpToDrops("0.1")).toBe("100000");
  });
  it("rejects bad XRP amounts", () => {
    for (const bad of ["", "0", "0.0000001", "-1", "1e3", "1,5", ".5", "abc", "1.", "0.000000"]) expect(xrpToDrops(bad)).toBeNull();
  });
  it("formats drops back", () => {
    expect(dropsToXrp(1_000_200n)).toBe("1.0002");
    expect(dropsToXrp(5_000_000n)).toBe("5");
  });
  it("converts ETH to wei exactly and refuses rounding", () => {
    expect(ethToWei("0.01")).toBe(10_000_000_000_000_000n);
    expect(ethToWei("0.000000000000000001")).toBe(1n);
    expect(ethToWei("1.123456789012345678")).toBe(1_123_456_789_012_345_678n);
    expect(ethToWei("1".repeat(23))).toBeNull();
    expect(ethToWei("9".repeat(22))).not.toBeNull();
    for (const bad of ["", "0", "0.0000000000000000001", "-1", "1e3", "abc", ".5"]) expect(ethToWei(bad)).toBeNull();
    expect(weiToEth(1_500_000_000_000_000_000n)).toBe("1.5");
  });
});

describe("custody API calls", () => {
  beforeEach(() => req.request.mockReset());
  it("posts the exact body shapes", async () => {
    req.request.mockResolvedValue({ state: "submitted" });
    await sendCustodyXrp({ from: "rA", to: "rB", amountDrops: "5", destinationTag: 7, password: "pw", idempotencyKey: "k" });
    expect(req.request).toHaveBeenLastCalledWith("/api/v1/custody/xrpl/send", { method: "POST", body: JSON.stringify({ from: "rA", to: "rB", amountDrops: "5", destinationTag: 7, password: "pw", idempotencyKey: "k" }) });
    await sendCustodyEvm({ from: "0xa", to: "0xb", amountWei: "5", password: "pw", idempotencyKey: "k" });
    expect(req.request.mock.calls[1][0]).toBe("/api/v1/custody/evm/send");
    req.request.mockResolvedValue({ transfers: [{ hash: "0x1" }] });
    expect(await listCustodyEvmTransfers("0xA b")).toEqual([{ hash: "0x1" }]);
    expect(req.request.mock.calls[2][0]).toBe("/api/v1/custody/evm/transfers?from=0xA%20b");
  });
});

describe("auto wallet setup", () => {
  // The CI web-lib config has no DOM, so this stands in for the browser window.
  const target = new EventTarget();
  beforeEach(() => { req.request.mockReset(); vi.stubGlobal("window", target); });
  afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });
  it("posts to onboard directly, once, and announces new wallets", async () => {
    const seen = vi.fn(); target.addEventListener(CUSTODY_CHANGED, seen);
    req.request.mockResolvedValue({ created: true, wallets: {} });
    await ensureCustodyWallets();
    expect(req.request).toHaveBeenCalledTimes(1);
    expect(req.request.mock.calls[0][0]).toBe("/api/v1/custody/onboard");
    expect(req.request.mock.calls[0][1].method).toBe("POST");
    expect(seen).toHaveBeenCalledTimes(1);
    target.removeEventListener(CUSTODY_CHANGED, seen);
  });
  it("stays quiet when wallets already existed", async () => {
    const seen = vi.fn(); target.addEventListener(CUSTODY_CHANGED, seen);
    req.request.mockResolvedValue({ created: false, wallets: [] });
    await ensureCustodyWallets();
    expect(seen).not.toHaveBeenCalled();
    target.removeEventListener(CUSTODY_CHANGED, seen);
  });
  it("never throws for self-custody (409) or setup off (503)", async () => {
    req.request.mockRejectedValueOnce(new Error("You keep your own keys, so Amma does not set up wallets for you."));
    await expect(ensureCustodyWallets()).resolves.toBeUndefined();
    req.request.mockRejectedValueOnce(new Error("Amma wallet setup is not switched on here yet."));
    await expect(ensureCustodyWallets()).resolves.toBeUndefined();
  });
  it("stays silent when the server says Amma-held wallets are not available for this account (mainnet allow-list, 403)", async () => {
    const seen = vi.fn(); target.addEventListener(CUSTODY_CHANGED, seen);
    req.request.mockRejectedValueOnce(new Error("Amma-held wallets aren't available for this account on mainnet yet."));
    await expect(ensureCustodyWallets()).resolves.toBeUndefined();
    expect(seen).not.toHaveBeenCalled();
    target.removeEventListener(CUSTODY_CHANGED, seen);
  });
  it("stops waiting after the limit so sign-in is held for at most 8 s", async () => {
    vi.useFakeTimers();
    req.request.mockReturnValue(new Promise(() => {}));
    let done = false;
    const waiting = ensureCustodyWallets().then(() => { done = true; });
    await vi.advanceTimersByTimeAsync(CUSTODY_SETUP_LIMIT_MS - 1);
    expect(done).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await waiting;
    expect(done).toBe(true);
    expect(CUSTODY_SETUP_LIMIT_MS).toBe(8000);
  });
  it("never throws when the request itself throws", async () => {
    req.request.mockImplementation(() => { throw new Error("synchronous failure"); });
    await expect(ensureCustodyWallets()).resolves.toBeUndefined();
  });
});
