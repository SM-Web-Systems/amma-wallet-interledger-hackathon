import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { useWalletStore } from "../store/wallet";
import { useAuthStore } from "../store/auth";

const vault = vi.hoisted(() => ({
  listLocalWallets: vi.fn(async (_o: string) => [] as { address: string }[]),
  changeLocalPassphrase: vi.fn(async (_o: string, _a: string, _c: string, _n: string) => ({})),
}));
vi.mock("../lib/xrpl/vault", async (orig) => ({ ...(await orig<typeof import("../lib/xrpl/vault")>()), listLocalWallets: vault.listLocalWallets, changeLocalPassphrase: vault.changeLocalPassphrase }));

import { VaultError } from "../lib/xrpl/vault";
import ChangePassphraseCard from "./ChangePassphraseCard";

const OLD = "lamp river garden 42";
const NEW = "blue mountain coffee 77";
const changePassphrase = vi.fn(async (_c: string, _n: string) => 1);

beforeEach(() => {
  changePassphrase.mockClear().mockResolvedValue(1);
  vault.listLocalWallets.mockClear().mockResolvedValue([]);
  vault.changeLocalPassphrase.mockClear().mockResolvedValue({});
  useWalletStore.setState({ accounts: [{ id: "a1", name: "Main", publicKey: "GA", encryptedSecret: "x", createdAt: 1 }], changePassphrase } as never);
  useAuthStore.setState({ user: { id: 7 } } as never);
});

function open() {
  render(<ChangePassphraseCard />);
  fireEvent.click(screen.getByRole("button", { name: /change wallet passphrase/i }));
}
function fill(current: string, next: string, confirm: string) {
  fireEvent.change(screen.getByLabelText(/^current passphrase/i), { target: { value: current } });
  fireEvent.change(screen.getByLabelText(/^new passphrase/i), { target: { value: next } });
  fireEvent.change(screen.getByLabelText(/^repeat new passphrase/i), { target: { value: confirm } });
  fireEvent.click(screen.getByRole("button", { name: /^change passphrase$/i }));
}

describe("Change wallet passphrase (Settings)", () => {
  it("says it affects this device only", () => {
    open();
    expect(screen.getByText(/this device only/i)).toBeInTheDocument();
  });

  it("changes the Stellar wallets and every XRP wallet that opens with the current passphrase", async () => {
    vault.listLocalWallets.mockResolvedValue([{ address: "rAAA" }, { address: "rBBB" }]);
    open();
    fill(OLD, NEW, NEW);
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("Passphrase changed for 3 wallets on this device."));
    expect(changePassphrase).toHaveBeenCalledWith(OLD, NEW);
    expect(vault.changeLocalPassphrase).toHaveBeenCalledWith("7", "rAAA", OLD, NEW);
    expect(vault.changeLocalPassphrase).toHaveBeenCalledWith("7", "rBBB", OLD, NEW);
  });

  it("leaves an XRP wallet under another passphrase alone and says so", async () => {
    vault.listLocalWallets.mockResolvedValue([{ address: "rAAA" }, { address: "rBBB" }]);
    vault.changeLocalPassphrase.mockImplementation(async (_o, address) => { if (address === "rBBB") throw new VaultError("UNLOCK_FAILED"); return {}; });
    open();
    fill(OLD, NEW, NEW);
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent(/2 wallets.*1 XRP wallet uses a different passphrase and was not changed/));
  });

  it("does not call anything for a weak, unchanged or mismatched passphrase", () => {
    open();
    fill(OLD, "short", "short");
    expect(screen.getByRole("alert")).toHaveTextContent(/12 characters/);
    fill(OLD, OLD, OLD);
    expect(screen.getByRole("alert")).toHaveTextContent(/different/i);
    fill(OLD, NEW, NEW + "x");
    expect(screen.getByRole("alert")).toHaveTextContent(/do not match/i);
    expect(changePassphrase).not.toHaveBeenCalled();
    expect(vault.changeLocalPassphrase).not.toHaveBeenCalled();
  });

  it("says so when the current passphrase opens nothing", async () => {
    changePassphrase.mockRejectedValue(new Error("Wrong passphrase."));
    vault.listLocalWallets.mockResolvedValue([{ address: "rAAA" }]);
    vault.changeLocalPassphrase.mockRejectedValue(new VaultError("UNLOCK_FAILED"));
    open();
    fill("not the passphrase", NEW, NEW);
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent(/not the current passphrase for any wallet/i));
  });

  it("stops and shows the error when the store cannot save (no XRP wallet is touched)", async () => {
    changePassphrase.mockRejectedValue(new Error("This browser could not save the new passphrase. Nothing was changed; try again."));
    vault.listLocalWallets.mockResolvedValue([{ address: "rAAA" }]);
    open();
    fill(OLD, NEW, NEW);
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent(/nothing was changed/i));
    expect(vault.changeLocalPassphrase).not.toHaveBeenCalled();
  });
});
