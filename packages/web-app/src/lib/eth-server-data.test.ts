import { describe, expect, it, vi, beforeEach } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";

const req = vi.hoisted(() => ({ request: vi.fn() }));
vi.mock("./api", () => req);
import { formatTokenBalance, formatWei, getEvmAlerts, getEvmBalances, getEvmHistory, markEvmAlertsSeen, previewEvmSend, useEvmServerConfig } from "./eth-server-data";

beforeEach(() => { req.request.mockReset(); });

describe("eth server data client", () => {
  it("calls the server endpoints with the address encoded and never any RPC URL", async () => {
    req.request.mockResolvedValue({});
    await getEvmBalances("0xabc");
    await getEvmHistory("0xabc");
    await getEvmHistory("0xabc", "a b");
    await previewEvmSend({ from: "0xa", to: "0xb", amountWei: "1" });
    expect(req.request.mock.calls.map((c) => c[0])).toEqual([
      "/api/v1/custody/evm/balances?address=0xabc", "/api/v1/custody/evm/history?address=0xabc", "/api/v1/custody/evm/history?address=0xabc&pageKey=a%20b", "/api/v1/custody/evm/preview"]);
    expect(JSON.parse(req.request.mock.calls[3][1].body)).toEqual({ from: "0xa", to: "0xb", amountWei: "1" });
    req.request.mockResolvedValue({ alerts: [{ id: "1" }] });
    expect(await getEvmAlerts()).toEqual([{ id: "1" }]);
    await markEvmAlertsSeen(["1", "2"]);
    const last = req.request.mock.calls.at(-1)!;
    expect(last[0]).toBe("/api/v1/custody/evm/alerts/seen");
    expect(JSON.parse(last[1].body)).toEqual({ ids: ["1", "2"] });
  });

  it("formats token balances exactly", () => {
    expect(formatTokenBalance("2500000", 6)).toBe("2.5");
    expect(formatTokenBalance("1000000000000000000", 18)).toBe("1");
    expect(formatTokenBalance("42", null)).toBe("42");
    expect(formatTokenBalance("x", 6)).toBe("0");
    expect(formatWei("42000000000000")).toBe("0.000042");
    expect(formatWei(null)).toBeNull();
  });

  it("the config hook is 'on' only when the server says serverData, and 'off' on a flag-off or older server", async () => {
    req.request.mockResolvedValue({ serverData: true, simulate: true, alerts: false, network: "ethereum" });
    const on = renderHook(() => useEvmServerConfig());
    expect(on.result.current.status).toBe("loading");
    await waitFor(() => expect(on.result.current.status).toBe("on"));
    req.request.mockResolvedValue({ serverData: false, simulate: false, alerts: false, network: "sepolia" });
    const off = renderHook(() => useEvmServerConfig());
    await waitFor(() => expect(off.result.current.status).toBe("off"));
  });

  it("is off on a server without the endpoint (404)", async () => {
    req.request.mockRejectedValue(new Error("Not found."));
    const older = renderHook(() => useEvmServerConfig());
    await waitFor(() => expect(older.result.current.status).toBe("off"));
  });
});
