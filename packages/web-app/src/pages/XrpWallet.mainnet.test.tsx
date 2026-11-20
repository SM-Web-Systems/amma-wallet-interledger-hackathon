import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { IDBFactory } from "fake-indexeddb";

const ADDRESS = "rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh";
const mocks = vi.hoisted(() => ({ account: vi.fn(), list: vi.fn(async () => []) }));
vi.mock("../lib/api", async (orig) => {
  const real = await orig<typeof import("../lib/api")>();
  return { ...real, xrplWalletApi: { ...real.xrplWalletApi, list: mocks.list } };
});
vi.mock("../lib/custody-send", async (orig) => ({ ...(await orig<typeof import("../lib/custody-send")>()), getCustodyXrpAccount: mocks.account }));
vi.mock("../lib/use-custody-wallets", async (orig) => ({
  ...(await orig<typeof import("../lib/use-custody-wallets")>()),
  useCustodyWallets: () => ({ status: "on", wallets: [{ chain: "xrpl", network: "mainnet", address: ADDRESS, name: "Amma XRP", index: 0, active: true }], message: "", working: false, add: vi.fn(), makeMain: vi.fn(), rename: vi.fn() }),
}));
import { useAuthStore } from "../store/auth";
import XrpWalletPage from "./XrpWallet";

const unactivated = { address: ADDRESS, network: "mainnet", activated: false, balanceDrops: "0", reserveDrops: "1000000", spendableDrops: "0", baseReserveDrops: "1000000" };
beforeEach(() => {
  vi.stubGlobal("indexedDB", new IDBFactory());
  useAuthStore.setState({ user: { id: 7 } as never, isAuthenticated: true });
  mocks.account.mockReset(); mocks.list.mockClear();
});
afterEach(() => vi.unstubAllEnvs());
const mainnetBuild = () => { vi.stubEnv("VITE_MAINNET_CUSTODY", "on"); vi.stubEnv("VITE_XRPL_MAINNET", "on"); };

describe("XRP page in a mainnet build (VITE_XRPL_MAINNET=on)", () => {
  it("shows an unfunded Amma-held wallet as not activated, without asking the user to send XRP", async () => {
    mainnetBuild(); mocks.account.mockResolvedValue(unactivated);
    render(<MemoryRouter><XrpWalletPage /></MemoryRouter>);
    const notes = await screen.findAllByText("Not activated yet. This wallet is activated when you complete an eligible task.");
    expect(notes.length).toBeGreaterThanOrEqual(1);
    expect(mocks.account).toHaveBeenCalledWith(ADDRESS);
    const text = document.body.textContent ?? "";
    expect(text).not.toMatch(/testnet/i);
    expect(text).not.toMatch(/send at least|fund (it|this)/i);
    expect(screen.queryByRole("link", { name: /funding instructions/i })).toBeNull();
    expect(screen.queryByText(/Create a Testnet wallet/)).toBeNull();
    expect(screen.getByRole("heading", { name: "Receive XRP" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Send XRP" })).toBeInTheDocument();
    // No self-custody (testnet-only) calls on mainnet.
    expect(mocks.list).not.toHaveBeenCalled();
  });
  it("shows the balance once the wallet is activated", async () => {
    mainnetBuild(); mocks.account.mockResolvedValue({ ...unactivated, activated: true, balanceDrops: "2500000", spendableDrops: "1500000" });
    render(<MemoryRouter><XrpWalletPage /></MemoryRouter>);
    expect(await screen.findByText("Balance: 2.500000 XRP")).toBeInTheDocument();
    expect(screen.queryByText(/Not activated yet/)).toBeNull();
  });
});

describe("XRP page in a testnet build", () => {
  it("keeps the testnet page as it was", async () => {
    render(<MemoryRouter><XrpWalletPage /></MemoryRouter>);
    expect(screen.getByText(/XRPL Testnet · Test funds only/)).toBeInTheDocument();
    expect(screen.getByText(/Create a Testnet wallet/)).toBeInTheDocument();
    expect(mocks.account).not.toHaveBeenCalled();
  });
});
