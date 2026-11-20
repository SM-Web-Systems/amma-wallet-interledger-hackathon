import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";

const m = vi.hoisted(() => ({ open: vi.fn(), move: vi.fn() }));
vi.mock("../lib/pin-retire", async (orig) => ({ ...(await orig<typeof import("../lib/pin-retire")>()), openWithPin: m.open, moveLegacyPinWallet: m.move }));

import { useWalletStore } from "../store/wallet";
import { useAuthStore } from "../store/auth";
import PinRetiredPrompt from "./PinRetiredPrompt";

const removeLocalKey = vi.fn(async () => {});
beforeEach(() => {
  vi.clearAllMocks();
  m.open.mockResolvedValue("SSECRET");
  m.move.mockResolvedValue("moved");
  useAuthStore.setState({ signingMode: "delegated" } as never);
  useWalletStore.setState({
    accounts: [{ id: "a1", serverId: 9, name: "Main", publicKey: "GPUB", encryptedSecret: "", createdAt: 1 }],
    activeAccountId: "a1", isUnlocked: false, _secretKey: null, _mnemonic: null, needsPassphraseUpgrade: true, removeLocalKey,
  } as never);
});

function submit(pin: string, password: string) {
  if (pin) fireEvent.change(screen.getByLabelText(/^wallet passphrase/i), { target: { value: pin } });
  fireEvent.change(screen.getByLabelText(/amma login password/i), { target: { value: password } });
  fireEvent.click(screen.getByRole("button", { name: /move wallet/i }));
}

describe("move a short-passphrase wallet to the Amma account", () => {
  it("is hidden unless needed", () => {
    useWalletStore.setState({ needsPassphraseUpgrade: false });
    const { container } = render(<PinRetiredPrompt />);
    expect(container).toBeEmptyDOMElement();
  });

  it("offers no way to keep the PIN or set a passphrase", () => {
    render(<PinRetiredPrompt />);
    expect(screen.queryByLabelText(/new passphrase/i)).toBeNull();
    expect(screen.getByRole("dialog", { name: /move this wallet to your amma account/i })).toBeInTheDocument();
  });

  it("opens the key with the old passphrase, moves it with the login password and removes this device's copy", async () => {
    render(<PinRetiredPrompt />);
    submit("123456", "login pw");
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent(/login password to send/i));
    expect(m.open).toHaveBeenCalledWith(expect.objectContaining({ publicKey: "GPUB" }), "123456");
    expect(m.move).toHaveBeenCalledWith({ address: "GPUB", secret: "SSECRET", password: "login pw", selfCustody: false, name: "Main" });
    expect(removeLocalKey).toHaveBeenCalledWith("a1", "GPUB");
    expect(useWalletStore.getState().needsPassphraseUpgrade).toBe(false);
  });

  it("a self-custody account becomes Amma-managed after the move", async () => {
    useAuthStore.setState({ signingMode: "self" } as never);
    render(<PinRetiredPrompt />);
    submit("123456", "login pw");
    await waitFor(() => expect(m.move).toHaveBeenCalledWith(expect.objectContaining({ selfCustody: true })));
    await waitFor(() => expect(useAuthStore.getState().signingMode).toBe("delegated"));
  });

  it("says sending is paused where Amma can't hold the wallet yet, and keeps this device's copy", async () => {
    m.move.mockResolvedValue("paused");
    render(<PinRetiredPrompt />);
    submit("123456", "login pw");
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent(/sending is paused/i));
    expect(removeLocalKey).not.toHaveBeenCalled();
  });

  it("shows a wrong passphrase or password and changes nothing", async () => {
    m.open.mockRejectedValue(new Error("That wallet passphrase is not correct."));
    render(<PinRetiredPrompt />);
    submit("111111", "login pw");
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent(/not correct/));
    expect(m.move).not.toHaveBeenCalled();
    expect(useWalletStore.getState().needsPassphraseUpgrade).toBe(true);
  });
});
