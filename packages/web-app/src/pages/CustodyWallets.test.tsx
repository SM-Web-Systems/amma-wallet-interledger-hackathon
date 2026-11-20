import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { IDBFactory } from "fake-indexeddb";

const api = vi.hoisted(() => ({ list: vi.fn(), add: vi.fn(), main: vi.fn(), rename: vi.fn() }));
vi.mock("../lib/custody-wallets", () => ({
  listCustodyWallets: api.list, addCustodyWallet: api.add, makeCustodyWalletMain: api.main, renameCustodyWallet: api.rename,
}));
vi.mock("../lib/evm/vault", async (orig) => {
  const real = await orig<typeof import("../lib/evm/vault")>();
  return { ...real, listEvmWallets: vi.fn(async () => [{ name: "Phone key", address: "0xDEVICE0000000000000000000000000000000001" }]) };
});
vi.mock("../lib/api", async (orig) => {
  const real = await orig<typeof import("../lib/api")>();
  return { ...real, xrplWalletApi: { ...real.xrplWalletApi, list: vi.fn(async () => []) } };
});
import { useAuthStore } from "../store/auth";
import { writeAdvancedWallets } from "../lib/advanced-wallets";
import EvmWalletPage from "./EvmWallet";
import XrpWalletPage from "./XrpWallet";

const A0 = "0xAAAA000000000000000000000000000000000000", A1 = "0xBBBB000000000000000000000000000000000001";
const w = (address: string, name: string, index: number, active: boolean, chain = "evm") => ({ chain, network: "sepolia", address, name, index, active });
const evmList = () => [w(A0, "Main wallet", 0, true), w(A1, "Savings", 1, false)];

beforeEach(() => {
  vi.stubGlobal("indexedDB", new IDBFactory());
  useAuthStore.setState({ user: { id: 7 } as never, isAuthenticated: true });
  Object.values(api).forEach((f) => f.mockReset());
  localStorage.clear();
});
const evm = () => render(<EvmWalletPage />);

describe("Ethereum page with Amma wallets", () => {
  it("lists wallets with the Main badge, and device wallets in their own section", async () => {
    api.list.mockResolvedValue(evmList());
    evm();
    const mine = await screen.findByRole("region", { name: "Your Amma Ethereum wallets" });
    expect(within(mine).getByText("Main wallet")).toBeInTheDocument();
    expect(within(mine).getByText("Savings")).toBeInTheDocument();
    expect(within(mine).getAllByText("Main")).toHaveLength(1);
    expect(within(mine).getByRole("button", { name: "Make Savings main" })).toBeInTheDocument();
    expect(within(mine).queryByRole("button", { name: "Make Main wallet main" })).toBeNull();
    const device = await screen.findByRole("region", { name: "On this device only" });
    expect(within(device).getByText("Phone key")).toBeInTheDocument();
    expect(screen.queryByLabelText("Wallet")).toBeNull();
  });

  it("starts on the main wallet and selecting a card changes the address shown", async () => {
    api.list.mockResolvedValue(evmList());
    evm();
    await waitFor(() => expect(screen.getByTestId("evm-receive-address")).toHaveTextContent(A0));
    expect(screen.queryByText(/coming next/)).toBeNull();
    expect(screen.getByRole("region", { name: "Send ETH" })).toBeInTheDocument();
    fireEvent.click(screen.getByText("Savings"));
    expect(screen.getByTestId("evm-receive-address")).toHaveTextContent(A1);
    expect(screen.getByText("Savings").closest("button")).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(await screen.findByText("Phone key"));
    expect(screen.getByTestId("evm-receive-address")).toHaveTextContent("0xDEVICE");
    expect(screen.queryByRole("region", { name: "Send ETH" })).toBeNull();
  });

  it("hides Add wallet until Advanced wallets is turned on", async () => {
    api.list.mockResolvedValue(evmList());
    evm();
    await screen.findByText("Savings");
    expect(screen.queryByRole("button", { name: "Add wallet" })).toBeNull();
    expect(screen.getByText(/Turn on Advanced wallets in Settings/)).toBeInTheDocument();
  });

  it("adds a wallet and refreshes the list", async () => {
    writeAdvancedWallets(true);
    api.list.mockResolvedValueOnce(evmList()).mockResolvedValue([...evmList(), w("0xCCCC000000000000000000000000000000000002", "Wallet 3", 2, false)]);
    api.add.mockResolvedValue({});
    evm();
    fireEvent.click(await screen.findByRole("button", { name: "Add wallet" }));
    expect(await screen.findByText("Wallet 3")).toBeInTheDocument();
    expect(api.add).toHaveBeenCalledWith("evm");
  });

  it("shows the limit message inline", async () => {
    writeAdvancedWallets(true);
    api.list.mockResolvedValue(evmList());
    api.add.mockRejectedValue(new Error("You can have up to 10 wallets on this network."));
    evm();
    fireEvent.click(await screen.findByRole("button", { name: "Add wallet" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("up to 10 wallets");
  });

  it("makes a wallet main", async () => {
    api.list.mockResolvedValueOnce(evmList()).mockResolvedValue([w(A0, "Main wallet", 0, false), w(A1, "Savings", 1, true)]);
    api.main.mockResolvedValue({});
    evm();
    fireEvent.click(await screen.findByRole("button", { name: "Make Savings main" }));
    await waitFor(() => expect(api.main).toHaveBeenCalledWith("evm", A1));
    await waitFor(() => expect(screen.queryByRole("button", { name: "Make Savings main" })).toBeNull());
  });

  it("renames a wallet", async () => {
    api.list.mockResolvedValueOnce(evmList()).mockResolvedValue([w(A0, "Main wallet", 0, true), w(A1, "Rainy day", 1, false)]);
    api.rename.mockResolvedValue({});
    evm();
    fireEvent.click(await screen.findByRole("button", { name: "Rename Savings" }));
    fireEvent.change(screen.getByLabelText("New name"), { target: { value: "Rainy day" } });
    fireEvent.click(screen.getByRole("button", { name: "Save name" }));
    await waitFor(() => expect(api.rename).toHaveBeenCalledWith("evm", A1, "Rainy day"));
    expect(await screen.findByText("Rainy day")).toBeInTheDocument();
  });

  it("loads wallets that were created after the page opened (auto setup at sign-in)", async () => {
    api.list.mockRejectedValueOnce(new Error("Amma does not hold a recovery phrase for this account.")).mockResolvedValue(evmList());
    evm();
    await screen.findByLabelText("Wallet");
    window.dispatchEvent(new Event("amma:custody:changed"));
    expect(await screen.findByRole("region", { name: "Your Amma Ethereum wallets" })).toBeInTheDocument();
  });

  it("falls back to the old page when Amma wallets are off", async () => {
    api.list.mockRejectedValue(new Error("Amma wallet setup is not switched on here yet."));
    evm();
    expect(await screen.findByLabelText("Wallet")).toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "Your Amma Ethereum wallets" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Add wallet" })).toBeNull();
  });
});

describe("XRP page with Amma wallets", () => {
  const xw = (address: string, name: string, active: boolean) => w(address, name, 0, active, "xrpl");
  it("lists wallets, selects one and shows its address and the send form", async () => {
    api.list.mockResolvedValue([xw("rMAIN0000000000000000000000000000", "Main wallet", true), xw("rSAVE0000000000000000000000000000", "Savings", false)]);
    render(<MemoryRouter><XrpWalletPage /></MemoryRouter>);
    const mine = await screen.findByRole("region", { name: "Your Amma XRP wallets" });
    expect(within(mine).getAllByText("Main")).toHaveLength(1);
    await waitFor(() => expect(screen.getByTestId("receive-address")).toHaveTextContent("rMAIN"));
    fireEvent.click(within(mine).getByText("Savings"));
    expect(screen.getByTestId("receive-address")).toHaveTextContent("rSAVE");
    expect(screen.queryByText(/coming next/)).toBeNull();
    expect(screen.getByRole("region", { name: "Send XRP" })).toBeInTheDocument();
  });

  it("adds a wallet after the reserve step and shows the limit message", async () => {
    writeAdvancedWallets(true);
    api.list.mockResolvedValue([xw("rMAIN0000000000000000000000000000", "Main wallet", true)]);
    api.add.mockRejectedValue(new Error("You can have up to 10 wallets on this network."));
    render(<MemoryRouter><XrpWalletPage /></MemoryRouter>);
    fireEvent.click(await screen.findByRole("button", { name: "Add wallet" }));
    expect(api.add).not.toHaveBeenCalled();
    expect(screen.getByRole("group", { name: "Before you add an XRP wallet" })).toHaveTextContent(/reserve/i);
    fireEvent.click(screen.getByRole("button", { name: "Create wallet" }));
    expect(api.add).toHaveBeenCalledWith("xrpl");
    expect(await screen.findByText(/up to 10 wallets/)).toBeInTheDocument();
  });

  it("falls back to the old page when Amma wallets are off", async () => {
    api.list.mockRejectedValue(new Error("off"));
    render(<MemoryRouter><XrpWalletPage /></MemoryRouter>);
    expect(await screen.findByRole("heading", { name: "Create a Testnet wallet" })).toBeInTheDocument();
    await waitFor(() => expect(api.list).toHaveBeenCalled());
    expect(screen.queryByRole("button", { name: "Add wallet" })).toBeNull();
  });
});
