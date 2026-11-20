import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { MemoryRouter, Routes, Route } from "react-router-dom";
import "../i18n";

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn() } }));
vi.mock("../lib/stellar-keystore", () => ({
  saveStellarSecret: vi.fn(async () => {}), loadStellarSecret: vi.fn(async () => null),
  loadAllStellarSecrets: vi.fn(async () => new Map()), deleteStellarSecret: vi.fn(async () => {}),
}));

import { useWalletStore } from "../store/wallet";
import { encryptSecret } from "../lib/crypto";
import SecretKeyBackup from "./SecretKeyBackup";

const SECRET = "SBGWSG6BTNCKCOB3DIFBGCVMUPQFYPA2G4O34RMTB343OYPXU5DJDVMN";
const PASS = "lamp river garden 42";

async function seed(opts: { unlocked: boolean; storagePersisted?: boolean | null }) {
  const encryptedSecret = await encryptSecret(SECRET, PASS);
  useWalletStore.setState({
    accounts: [{ id: "a1", name: "New", publicKey: "GNEW", encryptedSecret, createdAt: 1, backupPending: true }],
    activeAccountId: "a1", isUnlocked: opts.unlocked, _secretKey: opts.unlocked ? SECRET : null,
    storagePersisted: opts.storagePersisted ?? true,
  } as never);
}
const ui = () => render(
  <MemoryRouter initialEntries={["/backup"]}>
    <Routes><Route path="/backup" element={<SecretKeyBackup />} /><Route path="/dashboard" element={<p>dashboard</p>} /></Routes>
  </MemoryRouter>,
);

describe("SecretKeyBackup", () => {
  beforeEach(() => vi.clearAllMocks());

  it("shows the secret key once revealed and keeps the wallet gated until the last characters are typed", async () => {
    await seed({ unlocked: true });
    ui();
    expect(screen.queryByText(SECRET)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /show secret key/i }));
    expect(screen.getByText(SECRET)).toBeTruthy();
    const confirm = screen.getByRole("button", { name: /i saved it/i }) as HTMLButtonElement;
    expect(confirm.disabled).toBe(true);
    fireEvent.change(screen.getByLabelText(/last 6 characters/i), { target: { value: "XXXXXX" } });
    expect(confirm.disabled).toBe(true);
    expect(useWalletStore.getState().accounts[0].backupPending).toBe(true);
    fireEvent.change(screen.getByLabelText(/last 6 characters/i), { target: { value: SECRET.slice(-6) } });
    fireEvent.click(confirm);
    await screen.findByText("dashboard");
    expect(useWalletStore.getState().accounts[0].backupPending).toBeUndefined();
  });

  it("asks for the passphrase first when the wallet is locked (resumed after a reload)", async () => {
    await seed({ unlocked: false });
    ui();
    fireEvent.change(screen.getByLabelText(/wallet passphrase/i), { target: { value: PASS } });
    fireEvent.click(screen.getByRole("button", { name: /unlock/i }));
    await waitFor(() => expect(screen.getByRole("button", { name: /show secret key/i })).toBeTruthy(), { timeout: 8000 });
  });

  it("warns that the browser may clear saved data when persistent storage was refused", async () => {
    await seed({ unlocked: true, storagePersisted: false });
    ui();
    expect(screen.getByRole("alert").textContent).toMatch(/may clear/i);
  });

  it("shows no storage warning when persistence was granted", async () => {
    await seed({ unlocked: true, storagePersisted: true });
    ui();
    expect(screen.queryByRole("alert")).toBeNull();
  });
});
