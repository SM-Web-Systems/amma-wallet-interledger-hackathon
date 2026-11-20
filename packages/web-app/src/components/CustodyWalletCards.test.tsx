import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, act } from "@testing-library/react";
import { CustodyWalletCards } from "./CustodyWalletCards";
import { MAX_WALLETS_PER_CHAIN, readAdvancedWallets, writeAdvancedWallets } from "../lib/advanced-wallets";

const wallet = (i: number) => ({ chain: "xrpl" as const, network: "testnet", address: `rWALLET${i}XXXXXXXXXXXXXXXXXXXXXXXXXX`, name: `Wallet ${i}`, index: i, active: i === 0 });
const custody = (count: number, add = vi.fn()) => ({
  status: "on" as const, wallets: Array.from({ length: count }, (_, i) => wallet(i)), message: "", working: false,
  add, makeMain: vi.fn(), rename: vi.fn(),
});
const show = (chain: "xrpl" | "evm", c: ReturnType<typeof custody>) =>
  render(<CustodyWalletCards chain={chain} custody={c} selected={undefined} onSelect={() => undefined} balances={{}} />);

beforeEach(() => localStorage.clear());

describe("Add wallet sits behind the Advanced setting", () => {
  it("is off by default: no Add wallet button, and a line saying where to turn it on", () => {
    expect(readAdvancedWallets()).toBe(false);
    show("evm", custody(1));
    expect(screen.queryByRole("button", { name: "Add wallet" })).toBeNull();
    expect(screen.getByText(/Advanced/)).toBeInTheDocument();
  });

  it("existing wallets stay visible and usable while Advanced is off", () => {
    show("evm", custody(3));
    expect(screen.getByText("Wallet 2")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Rename Wallet 2" })).toBeInTheDocument();
  });

  it("shows Add wallet once Advanced is on, and an ETH wallet is added with one click", () => {
    writeAdvancedWallets(true);
    const add = vi.fn();
    show("evm", custody(1, add));
    fireEvent.click(screen.getByRole("button", { name: "Add wallet" }));
    expect(add).toHaveBeenCalledTimes(1);
  });

  it("a broken storage means off, not on", () => {
    const spy = vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => { throw new Error("blocked"); });
    expect(readAdvancedWallets()).toBe(false);
    spy.mockRestore();
  });
});

describe("the limit of 10 wallets per chain", () => {
  it("disables Add wallet at 10 and says why", () => {
    writeAdvancedWallets(true);
    const add = vi.fn();
    show("evm", custody(MAX_WALLETS_PER_CHAIN, add));
    const button = screen.getByRole("button", { name: "Add wallet" });
    expect(button).toBeDisabled();
    expect(screen.getByText(/limit of 10 wallets/i)).toBeInTheDocument();
    fireEvent.click(button);
    expect(add).not.toHaveBeenCalled();
  });

  it("still allows the 10th wallet (9 held)", () => {
    writeAdvancedWallets(true);
    show("evm", custody(MAX_WALLETS_PER_CHAIN - 1));
    expect(screen.getByRole("button", { name: "Add wallet" })).toBeEnabled();
  });
});

describe("the reserve is shown before an extra XRP wallet is made", () => {
  it("asks first: shows the reserve, makes nothing until the person confirms, and cancel makes nothing", () => {
    writeAdvancedWallets(true);
    const add = vi.fn();
    show("xrpl", custody(1, add));
    fireEvent.click(screen.getByRole("button", { name: "Add wallet" }));
    expect(add).not.toHaveBeenCalled();
    const note = screen.getByRole("group", { name: "Before you add an XRP wallet" });
    expect(note).toHaveTextContent(/reserve/i);
    expect(note).toHaveTextContent(/1 XRP/);
    expect(note).toHaveTextContent(/cannot be spent/i);
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(add).not.toHaveBeenCalled();
    expect(screen.queryByRole("group", { name: "Before you add an XRP wallet" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Add wallet" }));
    fireEvent.click(screen.getByRole("button", { name: "Create wallet" }));
    expect(add).toHaveBeenCalledTimes(1);
  });

  it("never asks the person to move the reserve in themselves; says how the wallet is activated", () => {
    for (const mainnet of [false, true]) {
      if (mainnet) { vi.stubEnv("VITE_MAINNET_CUSTODY", "on"); vi.stubEnv("VITE_XRPL_MAINNET", "on"); }
      writeAdvancedWallets(true);
      const { unmount } = show("xrpl", custody(1));
      fireEvent.click(screen.getByRole("button", { name: "Add wallet" }));
      const note = screen.getByRole("group", { name: "Before you add an XRP wallet" });
      expect(note).toHaveTextContent("Not activated yet. This wallet is activated when you complete an eligible task.");
      expect(note.textContent).not.toMatch(/yourself|move the reserve|send at least/i);
      unmount(); vi.unstubAllEnvs();
    }
  });

  it("Ethereum has no reserve step", () => {
    writeAdvancedWallets(true);
    show("evm", custody(1));
    fireEvent.click(screen.getByRole("button", { name: "Add wallet" }));
    expect(screen.queryByRole("group", { name: "Before you add an XRP wallet" })).toBeNull();
  });
});

describe("review fixes", () => {
  it("the XRP limit applies too, and the reserve step is not offered when no wallet can be added", () => {
    writeAdvancedWallets(true);
    show("xrpl", custody(MAX_WALLETS_PER_CHAIN));
    expect(screen.getByRole("button", { name: "Add wallet" })).toBeDisabled();
    expect(screen.getByText(/limit of 10 wallets/i)).toBeInTheDocument();
  });

  it("the reserve step closes after Create wallet", () => {
    writeAdvancedWallets(true);
    show("xrpl", custody(1));
    fireEvent.click(screen.getByRole("button", { name: "Add wallet" }));
    fireEvent.click(screen.getByRole("button", { name: "Create wallet" }));
    expect(screen.queryByRole("group", { name: "Before you add an XRP wallet" })).toBeNull();
  });

  it("turning Advanced off while the step is open closes it, and turning it on again does not bring it back", () => {
    writeAdvancedWallets(true);
    show("xrpl", custody(1));
    fireEvent.click(screen.getByRole("button", { name: "Add wallet" }));
    act(() => writeAdvancedWallets(false));
    expect(screen.queryByRole("group", { name: "Before you add an XRP wallet" })).toBeNull();
    act(() => writeAdvancedWallets(true));
    expect(screen.queryByRole("group", { name: "Before you add an XRP wallet" })).toBeNull();
    expect(screen.getByRole("button", { name: "Add wallet" })).toBeInTheDocument();
  });

  it("the reserve wording says it applies once the wallet is funded", () => {
    writeAdvancedWallets(true);
    show("xrpl", custody(1));
    fireEvent.click(screen.getByRole("button", { name: "Add wallet" }));
    expect(screen.getByRole("group", { name: "Before you add an XRP wallet" })).toHaveTextContent(/once funded/i);
  });

  it("writing the setting survives a store that throws", () => {
    const spy = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("full"); });
    expect(() => writeAdvancedWallets(true)).not.toThrow();
    spy.mockRestore();
  });
});
