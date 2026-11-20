import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor, act } from "@testing-library/react";
import { IDBFactory } from "fake-indexeddb";

const h = vi.hoisted(() => ({ request: vi.fn(), list: vi.fn(), reveal: vi.fn() }));
vi.mock("../lib/api", async (orig) => ({ ...(await orig<typeof import("../lib/api")>()), request: h.request }));
vi.mock("../lib/custody-wallets", () => ({ listCustodyWallets: h.list }));
vi.mock("../lib/stellar-device", () => ({ revealStellarSecret: h.reveal }));
import StellarMoveToAmmaCard from "./StellarMoveToAmmaCard";
import { useWalletStore } from "../store/wallet";
import { saveStellarSecret, loadStellarSecret } from "../lib/stellar-keystore";

const acct = (id: string, publicKey: string, over: Record<string, unknown> = {}) => ({ id, name: `W-${id}`, publicKey, encryptedSecret: "cipher", createdAt: 1, ...over });
const seed = (over: Record<string, unknown> = {}) => useWalletStore.setState({
  accounts: [acct("a1", "GAAA"), acct("a2", "GBBB")], activeAccountId: "a1", network: "testnet", isUnlocked: false, _secretKey: null, ...over,
} as never);

beforeEach(() => {
  vi.stubGlobal("indexedDB", new IDBFactory());
  Object.values(h).forEach((f) => f.mockReset());
  h.list.mockResolvedValue([]); h.reveal.mockResolvedValue("S-SECRET");
  h.request.mockResolvedValue({ imported: true, verified: true, wallet: { chain: "stellar", address: "GAAA" } });
  seed();
});
const button = () => screen.queryByRole("button", { name: "Move W-a1 to Amma" });

describe("Stellar card gating", () => {
  it("shows on testnet with custody on and a device key", async () => {
    render(<StellarMoveToAmmaCard />);
    expect(await screen.findByRole("button", { name: "Move W-a1 to Amma" })).toBeInTheDocument();
  });
  it("is hidden on the public network", async () => {
    seed({ network: "public" });
    render(<StellarMoveToAmmaCard />);
    await waitFor(() => expect(h.list).toHaveBeenCalled());
    expect(button()).toBeNull();
  });
  it("is hidden when custody is off", async () => {
    h.list.mockRejectedValue(new Error("off"));
    render(<StellarMoveToAmmaCard />);
    await waitFor(() => expect(h.list).toHaveBeenCalled());
    expect(button()).toBeNull();
  });
  it("is hidden when there is no device key", async () => {
    seed({ accounts: [acct("a1", "GAAA", { encryptedSecret: "" })] });
    render(<StellarMoveToAmmaCard />);
    await waitFor(() => expect(h.list).toHaveBeenCalled());
    expect(button()).toBeNull();
  });
  it("shows when the key is only in the browser keystore", async () => {
    seed({ accounts: [acct("a1", "GAAA", { encryptedSecret: "" })] });
    await saveStellarSecret("GAAA", "cipher");
    render(<StellarMoveToAmmaCard />);
    expect(await screen.findByRole("button", { name: "Move W-a1 to Amma" })).toBeInTheDocument();
  });
});

describe("Stellar card gating with the mainnet custody build flag", () => {
  it("shows on the public network when VITE_MAINNET_CUSTODY=on", async () => {
    vi.stubEnv("VITE_MAINNET_CUSTODY", "on");
    seed({ network: "public" });
    render(<StellarMoveToAmmaCard />);
    expect(await screen.findByRole("button", { name: "Move W-a1 to Amma" })).toBeInTheDocument();
    vi.unstubAllEnvs();
  });
  it("stays hidden on the public network for any other value", async () => {
    vi.stubEnv("VITE_MAINNET_CUSTODY", "true");
    seed({ network: "public" });
    render(<StellarMoveToAmmaCard />);
    await waitFor(() => expect(h.list).toHaveBeenCalled());
    expect(button()).toBeNull();
    vi.unstubAllEnvs();
  });
});

describe("Stellar card flow", () => {
  const run = async () => {
    fireEvent.click(await screen.findByRole("button", { name: "Move W-a1 to Amma" }));
    fireEvent.change(screen.getByLabelText("Device passphrase"), { target: { value: "device pass 12345" } });
    fireEvent.change(screen.getByLabelText("Your Amma password"), { target: { value: "amma pass" } });
    fireEvent.click(screen.getByRole("button", { name: "Move to Amma" }));
  };
  it("moves, then deletes the device key only after a confirmed second click", async () => {
    await saveStellarSecret("GAAA", "cipher");
    render(<StellarMoveToAmmaCard />);
    await run();
    fireEvent.click(await screen.findByRole("button", { name: "Remove the copy on this device" }));
    expect(screen.getByRole("alert")).toHaveTextContent(/recovery phrase/);
    expect(await loadStellarSecret("GAAA")).toBe("cipher");
    fireEvent.click(screen.getByRole("button", { name: "Yes, delete the copy on this device" }));
    await screen.findByText(/copy on this device is removed/);
    expect(await loadStellarSecret("GAAA")).toBeNull();
    expect(useWalletStore.getState().accounts[0].encryptedSecret).toBe("");
    expect(useWalletStore.getState().accounts[1].encryptedSecret).toBe("cipher");
  });
  it("an account switch closes the dialog and never retargets the removal", async () => {
    render(<StellarMoveToAmmaCard />);
    await run();
    await screen.findByRole("status");
    act(() => useWalletStore.setState({ activeAccountId: "a2" } as never));
    await waitFor(() => expect(screen.queryByText(/Move W-a1 to Amma/)).toBeNull());
    expect(screen.queryByRole("button", { name: /Remove the copy/ })).toBeNull();
    expect(screen.getByRole("button", { name: "Move W-a2 to Amma" })).toBeInTheDocument();
  });
});

describe("removeLocalKey guard", () => {
  it("refuses when the public key does not match, and removes nothing", async () => {
    await saveStellarSecret("GAAA", "cipher");
    await expect(useWalletStore.getState().removeLocalKey("a1", "GWRONG")).rejects.toThrow();
    expect(await loadStellarSecret("GAAA")).toBe("cipher");
    expect(useWalletStore.getState().accounts[0].encryptedSecret).toBe("cipher");
  });
  it("does not lock a different, unlocked account", async () => {
    seed({ activeAccountId: "a2", isUnlocked: true, _secretKey: "SKEY" });
    await useWalletStore.getState().removeLocalKey("a1", "GAAA");
    expect(useWalletStore.getState().isUnlocked).toBe(true);
    expect(useWalletStore.getState()._secretKey).toBe("SKEY");
  });
  it("locks when the wallet that lost its key is the active one", async () => {
    seed({ isUnlocked: true, _secretKey: "SKEY" });
    await useWalletStore.getState().removeLocalKey("a1", "GAAA");
    expect(useWalletStore.getState().isUnlocked).toBe(false);
  });
});

describe("Stellar card network wording", () => {
  it("says Testnet only on testnet", async () => {
    render(<StellarMoveToAmmaCard />);
    await screen.findByRole("button", { name: "Move W-a1 to Amma" });
    expect(screen.getByText(/Testnet only\./)).toBeInTheDocument();
  });
  it("says real XLM on the public network in a mainnet build, in the card and the dialog", async () => {
    vi.stubEnv("VITE_MAINNET_CUSTODY", "on");
    seed({ network: "public" });
    render(<StellarMoveToAmmaCard />);
    fireEvent.click(await screen.findByRole("button", { name: "Move W-a1 to Amma" }));
    expect(screen.getAllByText(/real XLM/)).toHaveLength(2);
    expect(screen.queryByText(/Testnet only/)).toBeNull();
    vi.unstubAllEnvs();
  });
});
