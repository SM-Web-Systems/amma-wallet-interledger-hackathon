import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent, waitFor, act } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import "../i18n";

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn() } }));
vi.mock("../lib/api", async (orig) => {
  const real = await orig<typeof import("../lib/api")>();
  const offline = async () => { throw new Error("offline"); };
  return {
    ...real,
    signingApi: { ...real.signingApi, getMode: vi.fn(offline) },
    keyEscrowApi: { ...real.keyEscrowApi, status: vi.fn(offline) },
    userWalletApi: { ...real.userWalletApi, list: vi.fn(async () => []) },
  };
});
vi.mock("../lib/stellar-keystore", () => ({
  saveStellarSecret: vi.fn(async () => {}), loadStellarSecret: vi.fn(async () => null),
  loadAllStellarSecrets: vi.fn(async () => new Map()), deleteStellarSecret: vi.fn(async () => {}),
}));

import SettingsPage from "./Settings";
import { useWalletStore } from "../store/wallet";
import { encryptSecret } from "../lib/crypto";

const SECRET = "SBGWSG6BTNCKCOB3DIFBGCVMUPQFYPA2G4O34RMTB343OYPXU5DJDVMN";
const PASS = "lamp river garden 42";

describe("Settings and the wallet lock", () => {
  it("hides a revealed secret key as soon as the wallet locks", async () => {
    const encryptedSecret = await encryptSecret(SECRET, PASS);
    useWalletStore.setState({ accounts: [{ id: "a1", name: "Main", publicKey: "GAAA", encryptedSecret, createdAt: 1 }], activeAccountId: "a1", isUnlocked: false, _secretKey: null } as never);
    render(<MemoryRouter><SettingsPage /></MemoryRouter>);
    fireEvent.click(await screen.findByRole("button", { name: /reveal secret key/i }));
    fireEvent.change(screen.getByLabelText(/wallet passphrase/i), { target: { value: PASS } });
    fireEvent.click(screen.getByRole("button", { name: /^(unlock|confirm|submit|continue)/i }));
    expect(await screen.findByText(SECRET, {}, { timeout: 8000 })).toBeTruthy();
    act(() => useWalletStore.getState().lock());
    await waitFor(() => expect(screen.queryByText(SECRET)).toBeNull());
  }, 20000);
});
