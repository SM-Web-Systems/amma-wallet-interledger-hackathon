import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { render, waitFor } from "@testing-library/react";

const api = vi.hoisted(() => ({ config: vi.fn(), alerts: vi.fn(), seen: vi.fn() }));
vi.mock("../lib/eth-server-data", () => ({ getEvmConfig: api.config, getEvmAlerts: api.alerts, markEvmAlertsSeen: api.seen }));
import EthAlertsPoller from "./EthAlertsPoller";
import { useNotificationStore } from "../store/notifications";

beforeEach(() => { api.config.mockReset(); api.alerts.mockReset(); api.seen.mockReset(); api.seen.mockResolvedValue({ marked: 1 }); useNotificationStore.setState({ notifications: [] }); });
afterEach(() => { vi.unstubAllEnvs(); });

describe("EthAlertsPoller", () => {
  it("does nothing when alerts are off", async () => {
    api.config.mockResolvedValue({ serverData: true, alerts: false });
    render(<EthAlertsPoller />);
    await new Promise((r) => setTimeout(r, 20));
    expect(api.alerts).not.toHaveBeenCalled();
  });
  it("does nothing on an older server", async () => {
    api.config.mockRejectedValue(new Error("Not found."));
    render(<EthAlertsPoller />);
    await new Promise((r) => setTimeout(r, 20));
    expect(api.alerts).not.toHaveBeenCalled();
  });
  it("adds a bell notification for each unread alert", async () => {
    api.config.mockResolvedValue({ serverData: true, alerts: true });
    api.alerts.mockResolvedValue([{ id: "1", hash: "0x1", to: "0x2", from: "0x1111111111111111111111111111111111111111", asset: "ETH", value: "0.5", createdAt: "2026-11-15T00:00:00Z" }]);
    render(<EthAlertsPoller />);
    await waitFor(() => expect(useNotificationStore.getState().notifications).toHaveLength(1));
    const n = useNotificationStore.getState().notifications[0];
    expect(n).toMatchObject({ type: "success", title: "Payment received", read: false });
    // No sender, shortened or not: a look-alike address is the whole poisoning trick.
    expect(n.message).toBe("You received 0.5 ETH on the Sepolia test network.");
    expect(n.message).not.toMatch(/0x/);
    await waitFor(() => expect(api.seen).toHaveBeenCalledWith(["1"]));
  });
  it("says plain ETH on a mainnet build", async () => {
    vi.stubEnv("VITE_MAINNET_CUSTODY", "on");
    api.config.mockResolvedValue({ serverData: true, alerts: true });
    api.alerts.mockResolvedValue([{ id: "9", hash: "0x1", to: "0x2", from: "0x3", asset: "ETH", value: "0.01", createdAt: "2026-11-15T00:00:00Z" }]);
    render(<EthAlertsPoller />);
    await waitFor(() => expect(useNotificationStore.getState().notifications[0]?.message).toBe("You received 0.01 ETH."));
  });
  it("does not notify twice for an alert the server sends again because marking it seen failed", async () => {
    api.config.mockResolvedValue({ serverData: true, alerts: true });
    api.seen.mockRejectedValue(new Error("offline"));
    api.alerts.mockResolvedValue([{ id: "5", hash: "0x1", to: "0x2", from: null, asset: "ETH", value: "1", createdAt: "2026-11-15T00:00:00Z" }]);
    vi.useFakeTimers({ shouldAdvanceTime: true });
    render(<EthAlertsPoller />);
    await waitFor(() => expect(api.seen).toHaveBeenCalledTimes(1));
    await vi.advanceTimersByTimeAsync(61_000);
    await waitFor(() => expect(api.alerts.mock.calls.length).toBeGreaterThan(1));
    expect(useNotificationStore.getState().notifications).toHaveLength(1);
    vi.useRealTimers();
  });
});
