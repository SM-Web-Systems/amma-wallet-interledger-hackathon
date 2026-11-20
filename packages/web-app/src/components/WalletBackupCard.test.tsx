// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { useWalletStore } from "../store/wallet";
import { useAuthStore } from "../store/auth";

const api = vi.hoisted(() => ({
  setMode: vi.fn(async (_m: string) => ({ ok: true })),
  escrow: vi.fn<() => Promise<{ enabled: boolean; hasPhrase: boolean }>>(),
}));
vi.mock("../lib/api", async (orig) => ({
  ...(await orig<typeof import("../lib/api")>()),
  signingApi: { ...(await orig<typeof import("../lib/api")>()).signingApi, setMode: api.setMode },
  keyEscrowApi: { status: api.escrow, savePhrase: vi.fn(), openPhrase: vi.fn() },
}));
const keystore = vi.hoisted(() => ({ has: false }));
vi.mock("../lib/stellar-keystore", async (orig) => ({
  ...(await orig<typeof import("../lib/stellar-keystore")>()),
  loadStellarSecret: vi.fn(async () => (keystore.has ? "cipher" : null)),
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

import WalletBackupCard from "./WalletBackupCard";

const restore = vi.fn(async (_p: string) => {});
const upload = vi.fn(async () => {});
const backupPhrase = vi.fn(async (_p: string) => "saved" as const);

function setup(opts: { mode?: "self" | "delegated"; hasKey?: boolean; serverKey?: boolean; phrase?: string | null } = {}) {
  keystore.has = opts.hasKey ?? true;
  useAuthStore.setState({ signingMode: opts.mode ?? "delegated" } as never);
  useWalletStore.setState({
    accounts: [{ id: "a1", serverId: 7, name: "wallet", publicKey: "GA", encryptedSecret: "", createdAt: 1, hasServerKey: opts.serverKey ?? true }],
    activeAccountId: "a1",
    restoreFromServerBackup: restore,
    uploadKeysForDelegatedSigning: upload,
    backupRecoveryPhrase: backupPhrase,
    _mnemonic: opts.phrase ?? null,
    getMnemonic: () => opts.phrase ?? null,
  } as never);
  render(<WalletBackupCard />);
}

beforeEach(() => {
  api.setMode.mockClear();
  restore.mockClear();
  upload.mockClear();
  backupPhrase.mockClear();
  api.escrow.mockReset().mockResolvedValue({ enabled: false, hasPhrase: false });
  vi.stubGlobal("confirm", vi.fn(() => true));
});

describe("Wallet backup and recovery card", () => {
  it("shows the Amma backup switch on by default for a managed wallet", () => {
    setup({ mode: "delegated" });
    expect(screen.getByRole("switch", { name: /amma keeps an encrypted backup/i })).toBeChecked();
  });

  it("shows it off for a self-custody wallet", () => {
    setup({ mode: "self" });
    expect(screen.getByRole("switch", { name: /amma keeps an encrypted backup/i })).not.toBeChecked();
  });

  it("warns, then switches to keeping your own keys", async () => {
    setup({ mode: "delegated" });
    fireEvent.click(screen.getByRole("switch", { name: /amma keeps an encrypted backup/i }));
    expect(confirm).toHaveBeenCalledWith(expect.stringMatching(/recovery phrase|secret key/i));
    await waitFor(() => expect(api.setMode).toHaveBeenCalledWith("self"));
  });

  it("changes nothing when the warning is declined", () => {
    vi.stubGlobal("confirm", vi.fn(() => false));
    setup({ mode: "delegated" });
    fireEvent.click(screen.getByRole("switch", { name: /amma keeps an encrypted backup/i }));
    expect(api.setMode).not.toHaveBeenCalled();
  });

  it("uploads this browser's encrypted copy before turning the backup on", async () => {
    setup({ mode: "self" });
    fireEvent.click(screen.getByRole("switch", { name: /amma keeps an encrypted backup/i }));
    await waitFor(() => expect(api.setMode).toHaveBeenCalledWith("delegated"));
    expect(upload).toHaveBeenCalled();
  });

  it("offers a restore from the Amma backup when this browser has no key and Amma holds a copy", async () => {
    setup({ hasKey: false, serverKey: true });
    fireEvent.click(await screen.findByRole("button", { name: /restore from amma backup/i }));
    fireEvent.change(screen.getByLabelText(/wallet passphrase/i), { target: { value: "phone passphrase here 1" } });
    fireEvent.click(screen.getByRole("button", { name: /confirm/i }));
    await waitFor(() => expect(restore).toHaveBeenCalledWith("phone passphrase here 1"));
  });

  it("does not offer a restore when this browser already has the key", async () => {
    setup({ hasKey: true });
    await waitFor(() => expect(screen.queryByText(/not stored in this browser/i)).toBeNull());
    expect(screen.queryByRole("button", { name: /restore from amma backup/i })).toBeNull();
  });

  it("says nothing about a phrase backup while the server has it switched off", async () => {
    setup();
    await waitFor(() => expect(api.escrow).toHaveBeenCalled());
    expect(screen.queryByText(/recovery phrase backup/i)).toBeNull();
  });

  it("shows that Amma holds a sealed backup of the recovery phrase", async () => {
    api.escrow.mockResolvedValue({ enabled: true, hasPhrase: true });
    setup();
    expect(await screen.findByText(/amma has a sealed backup of your recovery phrase/i)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /back up my recovery phrase/i })).toBeNull();
  });

  it("offers to back the phrase up when this browser holds it and Amma has none", async () => {
    api.escrow.mockResolvedValue({ enabled: true, hasPhrase: false });
    setup({ phrase: "illness spike retreat truth genius clock brain pass fit cave bargain toe" });
    fireEvent.click(await screen.findByRole("button", { name: /back up my recovery phrase/i }));
    await waitFor(() => expect(backupPhrase).toHaveBeenCalledWith("illness spike retreat truth genius clock brain pass fit cave bargain toe"));
    expect(await screen.findByText(/amma has a sealed backup of your recovery phrase/i)).toBeInTheDocument();
  });

  it("explains how to back up when the phrase is not held in this browser", async () => {
    api.escrow.mockResolvedValue({ enabled: true, hasPhrase: false });
    setup({ phrase: null });
    expect(await screen.findByText(/not backed up yet/i)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /back up my recovery phrase/i })).toBeNull();
  });

  it("does not talk about a phrase backup for a user who keeps their own keys", async () => {
    api.escrow.mockResolvedValue({ enabled: true, hasPhrase: false });
    setup({ mode: "self" });
    await waitFor(() => expect(api.escrow).toHaveBeenCalled());
    expect(screen.queryByText(/not backed up yet/i)).toBeNull();
  });

  it("points to the recovery phrase when there is no key here and no Amma copy", async () => {
    setup({ hasKey: false, serverKey: false });
    expect(await screen.findByText(/recovery phrase or secret key/i)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /restore from amma backup/i })).toBeNull();
  });
});
