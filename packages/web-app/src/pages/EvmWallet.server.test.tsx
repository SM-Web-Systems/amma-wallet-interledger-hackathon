import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { IDBFactory } from "fake-indexeddb";
import { useAuthStore } from "../store/auth";

const ADDR = "0x6b30c7d7657A83141186Cd8c155CDB90C8750371";
const api = vi.hoisted(() => ({ config: vi.fn(), bal: vi.fn(), hist: vi.fn(), preview: vi.fn() }));
// The server endpoints, answered by path at the lowest level (the page's own helpers run for real).
vi.mock("../lib/api", async (orig) => ({
  ...(await orig<typeof import("../lib/api")>()),
  request: async (path: string) => {
    if (path.includes("/custody/evm/config")) return api.config();
    if (path.includes("/custody/evm/balances")) return api.bal(path);
    if (path.includes("/custody/evm/history")) return api.hist(path);
    throw new Error("unexpected " + path);
  },
}));
const stable = vi.hoisted(() => ({ value: undefined as unknown }));
vi.mock("../lib/use-custody-wallets", () => ({
  shortAddress: (a: string) => a,
  // One object for every render: a new array each time would re-run the page's effects forever.
  useCustodyWallets: () => {
    if (!stable.value) stable.value = { status: "on", wallets: [{ chain: "evm", network: "ethereum", address: "0x6b30c7d7657A83141186Cd8c155CDB90C8750371", name: "Main", index: 0, active: true }], message: "", working: false, add: () => undefined, makeMain: () => undefined, rename: () => undefined };
    return stable.value;
  },
}));
import EvmWalletPage from "./EvmWallet";

const fetchSpy = vi.fn();
beforeEach(() => {
  vi.stubGlobal("indexedDB", new IDBFactory());
  vi.stubGlobal("fetch", fetchSpy);
  vi.stubEnv("VITE_MAINNET_CUSTODY", "on");
  fetchSpy.mockReset(); Object.values(api).forEach((f) => f.mockReset());
  api.bal.mockResolvedValue({ address: ADDR.toLowerCase(), network: "ethereum", wei: "2000000000000000000", tokens: [{ contract: "0x" + "c".repeat(40), symbol: "USDC", name: "USD Coin", decimals: 6, logo: null, balance: "7000000" }], tokensUnavailable: false });
  api.hist.mockResolvedValue({ address: ADDR.toLowerCase(), transfers: [], pageKey: null });
  useAuthStore.setState({ user: { id: 7 } as never, isAuthenticated: true });
});
// Let the page's mount-time jobs (wallet list from IndexedDB, balances) finish before the stubs and the
// test environment go away; otherwise a late setState can run after teardown ("window is not defined").
afterEach(async () => {
  await waitFor(() => expect(document.querySelector('[aria-busy="true"]')).toBeNull());
  cleanup();
  vi.unstubAllEnvs(); vi.unstubAllGlobals();
});

describe("Ethereum page with ETH_SERVER_DATA on", () => {
  it("shows balances with tokens and history from the server, and makes no browser RPC call or mainnet-RPC warning", async () => {
    api.config.mockResolvedValue({ serverData: true, simulate: true, alerts: false, network: "ethereum" });
    render(<EvmWalletPage />);
    const list = await screen.findByTestId("evm-server-balances");
    expect(list).toHaveTextContent("ETH: 2");
    expect(list).toHaveTextContent("USDC: 7");
    expect(await screen.findByText("No transfers yet.")).toBeInTheDocument();
    expect(screen.queryByText(/No Ethereum mainnet RPC is configured/)).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(api.bal).toHaveBeenCalledWith(expect.stringContaining(ADDR));
  });

  it("with the flag off keeps the browser-RPC behaviour (and its warning when no URL is configured)", async () => {
    api.config.mockResolvedValue({ serverData: false, simulate: false, alerts: false, network: "ethereum" });
    render(<EvmWalletPage />);
    expect(await screen.findByText(/No Ethereum mainnet RPC is configured/)).toBeInTheDocument();
    expect(screen.queryByTestId("evm-server-balances")).toBeNull();
    expect(api.bal).not.toHaveBeenCalled();
  });

  it("on a server without the endpoint behaves as before", async () => {
    api.config.mockRejectedValue(new Error("Not found."));
    render(<EvmWalletPage />);
    await waitFor(() => expect(screen.getByText(/No Ethereum mainnet RPC is configured/)).toBeInTheDocument());
    expect(api.bal).not.toHaveBeenCalled();
  });
});
