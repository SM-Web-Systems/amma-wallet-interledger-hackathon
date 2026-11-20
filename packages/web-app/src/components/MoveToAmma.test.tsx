import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { IDBFactory } from "fake-indexeddb";

const req = vi.hoisted(() => ({ request: vi.fn() }));
vi.mock("../lib/api", async (orig) => ({ ...(await orig<typeof import("../lib/api")>()), request: req.request }));
import { DeviceWalletCards } from "./CustodyWalletCards";
import { createRecoveryPhrase, removeEvmWallet, revealEvmMnemonic, saveEvmWallet, listEvmWallets } from "../lib/evm/vault";
import { createRecoveryPhrase as xrpPhrase, removeLocalWallet, revealLocalSecret, saveLocalWallet, listLocalWallets } from "../lib/xrpl/vault";

const SECRET = "correct horse battery staple wallet secret words here now";
const ADDR = "0xDEVICE0000000000000000000000000000000001";
const DEVICE_PASS = "device passphrase 123", AMMA_PASS = "my amma password";

function setup(chain: "evm" | "xrpl" | "stellar", opts: { reveal?: () => Promise<string>; removeLocal?: () => Promise<void> } = {}) {
  const reveal = vi.fn(opts.reveal ?? (async () => SECRET));
  const removeLocal = vi.fn(opts.removeLocal ?? (async () => undefined));
  render(<DeviceWalletCards items={[{ address: ADDR, name: "Phone key" }]} selected={undefined} onSelect={() => undefined}
    move={{ chain: chain as "evm", has: () => true, reveal: (_a, p) => reveal(p), removeLocal }} />);
  return { reveal, removeLocal };
}
const ok = (chain: string, over: Record<string, unknown> = {}) => ({ imported: true, verified: true, wallet: { chain, address: ADDR }, ...over });
const fill = (device = DEVICE_PASS, password = AMMA_PASS) => {
  fireEvent.click(screen.getByRole("button", { name: "Move Phone key to Amma" }));
  fireEvent.change(screen.getByLabelText("Device passphrase"), { target: { value: device } });
  fireEvent.change(screen.getByLabelText("Your Amma password"), { target: { value: password } });
  fireEvent.click(screen.getByRole("button", { name: "Move to Amma" }));
};

beforeEach(() => { req.request.mockReset(); vi.stubGlobal("indexedDB", new IDBFactory()); });

describe("Move to Amma", () => {
  it.each(["evm", "xrpl", "stellar"] as const)("happy path for %s: posts once, refreshes, then offers local removal", async (chain) => {
    req.request.mockResolvedValue(ok(chain));
    const changed = vi.fn(); window.addEventListener("amma:custody:changed", changed);
    const { removeLocal, reveal } = setup(chain);
    expect(screen.queryByRole("button", { name: /Remove the copy on this device/ })).toBeNull();
    fill();
    expect(await screen.findByText(/Amma now holds this wallet/)).toBeInTheDocument();
    expect(reveal).toHaveBeenCalledWith(DEVICE_PASS);
    expect(req.request).toHaveBeenCalledTimes(1);
    const [path, init] = req.request.mock.calls[0];
    expect(path).toBe("/api/v1/custody/import");
    expect(JSON.parse(init.body)).toEqual({ chain, address: ADDR, secret: SECRET, password: AMMA_PASS, name: "Phone key" });
    expect(changed).toHaveBeenCalled();
    expect(removeLocal).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Remove the copy on this device" }));
    expect(removeLocal).not.toHaveBeenCalled();
    expect(screen.getByRole("alert")).toHaveTextContent(/cannot be undone/);
    fireEvent.click(screen.getByRole("button", { name: "Yes, delete the copy on this device" }));
    await waitFor(() => expect(removeLocal).toHaveBeenCalledOnce());
    expect(await screen.findByText(/copy on this device is removed/)).toBeInTheDocument();
    window.removeEventListener("amma:custody:changed", changed);
  });

  it("shows the mismatch message and offers no local removal", async () => {
    req.request.mockRejectedValue(new Error("That phrase doesn't match this wallet."));
    const { removeLocal } = setup("evm");
    fill();
    expect(await screen.findByRole("alert")).toHaveTextContent("That phrase doesn't match this wallet.");
    expect(screen.queryByRole("button", { name: /Remove the copy on this device/ })).toBeNull();
    expect(removeLocal).not.toHaveBeenCalled();
  });

  it("wrong Amma password: inline error, no local removal, secret not rendered", async () => {
    req.request.mockRejectedValue(new Error("Wrong password"));
    const { container } = { container: document.body };
    setup("xrpl");
    fill();
    expect(await screen.findByRole("alert")).toHaveTextContent("Wrong password");
    expect(screen.queryByRole("button", { name: /Remove the copy on this device/ })).toBeNull();
    expect(container.textContent).not.toContain(SECRET);
    expect((screen.getByLabelText("Your Amma password") as HTMLInputElement).value).toBe("");
  });

  it("a wrong device passphrase never reaches the server", async () => {
    setup("evm", { reveal: async () => { throw new Error("The passphrase is incorrect or the vault was changed."); } });
    fill();
    expect(await screen.findByRole("alert")).toHaveTextContent("passphrase is incorrect");
    expect(req.request).not.toHaveBeenCalled();
  });

  it("never renders the secret or passwords, even on success", async () => {
    req.request.mockResolvedValue(ok("stellar", { imported: false, alreadyHeld: true }));
    setup("stellar");
    fill();
    expect(await screen.findByText("Amma already holds this wallet.")).toBeInTheDocument();
    for (const text of [SECRET, DEVICE_PASS, AMMA_PASS]) expect(document.body.textContent).not.toContain(text);
    expect(document.body.innerHTML).not.toContain(SECRET);
  });

  it("keeps the removal offer after the card leaves the device list", async () => {
    req.request.mockResolvedValue(ok("evm"));
    const removeLocal = vi.fn(async () => undefined);
    const move = { chain: "evm" as const, has: () => true, reveal: async () => SECRET, removeLocal };
    const { rerender } = render(<DeviceWalletCards items={[{ address: ADDR, name: "Phone key" }]} selected={undefined} onSelect={() => undefined} move={move} />);
    fill();
    await screen.findByText(/Amma now holds this wallet/);
    rerender(<DeviceWalletCards items={[]} selected={undefined} onSelect={() => undefined} move={move} />);
    expect(screen.getByRole("button", { name: "Remove the copy on this device" })).toBeInTheDocument();
  });
});

describe("local copy is only offered for a verified, matching response", () => {
  it.each([
    ["unverified", (c: string) => ok(c, { verified: false })],
    ["verified missing", (c: string) => ({ imported: true, wallet: { chain: c, address: ADDR } })],
    ["empty", () => ({})],
    ["neither imported nor already held", (c: string) => ok(c, { imported: false })],
    ["wrong chain", () => ok("xrpl")],
    ["wrong address", (c: string) => ok(c, { wallet: { chain: c, address: "0xSOMEONEELSE" } })],
    ["no wallet", () => ({ imported: true, verified: true })],
  ])("%s: keeps the device copy and says why", async (_label, response) => {
    req.request.mockResolvedValue(response("evm"));
    const { removeLocal } = setup("evm");
    fill();
    expect(await screen.findByRole("status")).toHaveTextContent("Amma stored the wallet but couldn't verify it yet. Keep the copy on your device.");
    expect(screen.queryByRole("button", { name: /Remove the copy on this device/ })).toBeNull();
    expect(removeLocal).not.toHaveBeenCalled();
  });
  it("matches an ETH address case-insensitively", async () => {
    req.request.mockResolvedValue(ok("evm", { wallet: { chain: "evm", address: ADDR.toLowerCase() } }));
    setup("evm");
    fill();
    expect(await screen.findByRole("button", { name: "Remove the copy on this device" })).toBeInTheDocument();
  });
  it("moves focus to the result and does not close on Escape while working", async () => {
    let release: (v: unknown) => void = () => undefined;
    req.request.mockReturnValue(new Promise((r) => { release = r; }));
    setup("evm");
    fill();
    const cancel = await screen.findByRole("button", { name: "Cancel" });
    expect(cancel).toBeDisabled();
    fireEvent.keyDown(screen.getByRole("region", { name: /Move Phone key to Amma/ }), { key: "Escape" });
    expect(screen.getByRole("region", { name: /Move Phone key to Amma/ })).toBeInTheDocument();
    release(ok("evm"));
    const status = await screen.findByRole("status");
    await waitFor(() => expect(status).toHaveFocus());
  });
});

describe("device vault helpers", () => {
  it("ETH: reveals the phrase only with the right passphrase, and removes the local copy", async () => {
    const { mnemonic } = createRecoveryPhrase(12);
    const saved = await saveEvmWallet({ ownerId: "7", name: "E", mnemonic, confirmation: mnemonic, passphrase: DEVICE_PASS, backupAcknowledged: true });
    await expect(revealEvmMnemonic("7", saved.address, "wrong passphrase 1234")).rejects.toThrow();
    expect(await revealEvmMnemonic("7", saved.address, DEVICE_PASS)).toBe(mnemonic);
    await removeEvmWallet("7", saved.address);
    expect(await listEvmWallets("7")).toEqual([]);
  });
  it("XRP: reveals the phrase and removes the local copy", async () => {
    const { phrase } = xrpPhrase(12);
    const saved = await saveLocalWallet({ ownerId: "7", name: "X", seed: phrase, seedConfirmation: phrase, passphrase: DEVICE_PASS, backupAcknowledged: true });
    await expect(revealLocalSecret("7", saved.address, "wrong passphrase 1234")).rejects.toThrow();
    expect(await revealLocalSecret("7", saved.address, DEVICE_PASS)).toBe(phrase);
    await removeLocalWallet("7", saved.address);
    expect(await listLocalWallets("7")).toEqual([]);
  });
});

describe("Move to Amma network wording", () => {
  afterEach(() => vi.unstubAllEnvs());
  const open = (chain: "evm" | "xrpl" | "stellar") => { setup(chain); fireEvent.click(screen.getByRole("button", { name: "Move Phone key to Amma" })); };
  it.each(["evm", "xrpl", "stellar"] as const)("says Testnet only for %s on a testnet build", (chain) => {
    open(chain);
    expect(screen.getByText(/Testnet only\.$/)).toBeInTheDocument();
  });
  it("tells an Ethereum mover about real ETH on a mainnet build", () => {
    vi.stubEnv("VITE_MAINNET_CUSTODY", "on");
    open("evm");
    expect(screen.getByText(/hold real ETH/)).toBeInTheDocument();
    expect(screen.queryByText(/Testnet only/)).toBeNull();
  });
  it("keeps the xrpl note honest on a mainnet build", () => {
    vi.stubEnv("VITE_MAINNET_CUSTODY", "on");
    open("xrpl");
    expect(screen.getByText(/XRP cannot be moved to Amma on this build\./)).toBeInTheDocument();
  });
});
