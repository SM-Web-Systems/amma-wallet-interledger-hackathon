import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { IDBFactory } from "fake-indexeddb";
import { useAuthStore } from "../store/auth";
import EvmWalletPage from "./EvmWallet";

beforeEach(() => {
  vi.stubGlobal("indexedDB", new IDBFactory());
  useAuthStore.setState({ user: { id: 7 } as never, isAuthenticated: true });
});

// The page reads the device's wallets from IndexedDB on mount. Every test waits
// for that read to finish, so no state update lands after the test file ends.
const settled = async (container: HTMLElement) =>
  waitFor(() => expect(container.firstElementChild).toHaveAttribute("aria-busy", "false"));

describe("Ethereum Sepolia page", () => {
  it("stays busy until every piece of work has finished, not just the first", async () => {
    let finishList!: () => void;
    const vault = await import("../lib/evm/vault");
    const real = vault.listEvmWallets;
    const spy = vi.spyOn(vault, "listEvmWallets").mockImplementation((owner) => new Promise((done) => { finishList = () => done(real(owner)); }));
    const { container } = render(<EvmWalletPage />);
    // The other mount-time jobs finish at once; the wallet read is still open.
    await new Promise((r) => setTimeout(r, 20));
    expect(container.firstElementChild).toHaveAttribute("aria-busy", "true");
    finishList();
    await settled(container);
    spy.mockRestore();
  });

  it("labels the network as testnet, explains a missing RPC and offers setup", async () => {
    const { container } = render(<EvmWalletPage />);
    expect(screen.getByRole("heading", { name: /Ethereum Sepolia \(testnet\)/ })).toBeInTheDocument();
    expect(screen.getByText(/No Sepolia RPC is configured/)).toBeInTheDocument();
    expect(await screen.findByText("Set up a Sepolia wallet")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Generate 12-word phrase" })).toBeInTheDocument();
    await settled(container);
  });
});

describe("Ethereum recovery phrase length", () => {
  it.each([["Generate 12-word phrase", 12], ["Generate 24-word phrase", 24]] as const)("%s shows %i words and says so", async (label, count) => {
    const { container } = render(<EvmWalletPage />);
    fireEvent.click(await screen.findByRole("button", { name: label }));
    expect(screen.getByTestId("evm-phrase").textContent!.trim().split(" ")).toHaveLength(count);
    expect(screen.getByText(new RegExp(`Write these ${count} words down`))).toBeInTheDocument();
    await settled(container);
  });
});

describe("explain", () => {
  it("never shows a raw engine code", async () => {
    const { explain } = await import("../lib/evm/messages");
    const { EvmError } = await import("@amma-wallet/evm-core");
    expect(explain(new EvmError("EVM_ADDRESS_ZERO"))).toMatch(/zero address/);
    expect(explain(new EvmError("EVM_SIGN_RECIPIENT_MISMATCH"))).toMatch(/was not sent/);
    expect(explain(new EvmError("EVM_RPC_MALFORMED"))).toMatch(/RPC is unavailable/);
    expect(explain(new EvmError("EVM_NONCE_INVALID"))).toBe("This could not be completed (EVM_NONCE_INVALID). Nothing was sent.");
  });
});
