import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";

const api = vi.hoisted(() => ({ removeSecret: vi.fn<(id: number) => Promise<{ ok: boolean }>>(async () => ({ ok: true })), getMode: vi.fn(async () => "self" as const) }));
vi.mock("../lib/api", async (orig) => {
  const real = await orig<typeof import("../lib/api")>();
  return { ...real, userWalletApi: { ...real.userWalletApi, removeSecret: api.removeSecret }, signingApi: { ...real.signingApi, getMode: api.getMode } };
});

import ServerKeyCleanupPrompt from "./ServerKeyCleanupPrompt";
import { useWalletStore } from "../store/wallet";
import { useAuthStore } from "../store/auth";

function seed(over: Record<string, unknown> = {}) {
  useWalletStore.setState({
    accounts: [{ id: "a1", serverId: 9, name: "Main", publicKey: "GPUB", encryptedSecret: "ciphertext", createdAt: 1, hasServerKey: true }],
    activeAccountId: "a1", isUnlocked: true, _secretKey: "SKEY", needsPassphraseUpgrade: false, ...over,
  } as never);
}

beforeEach(() => {
  api.removeSecret.mockClear();
  api.getMode.mockResolvedValue("self");
  useAuthStore.setState({ signingMode: "self" });
});

describe("ServerKeyCleanupPrompt", () => {
  it("asks before removing, and removes only on the person's click", async () => {
    seed();
    render(<ServerKeyCleanupPrompt />);
    expect(screen.getByText(/recovery phrase or secret key/)).toBeTruthy();
    expect(api.removeSecret).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Remove server copy" }));
    await waitFor(() => expect(api.removeSecret).toHaveBeenCalledWith(9));
    await waitFor(() => expect(screen.queryByText(/Remove the copy/)).toBeNull());
    expect(useWalletStore.getState().accounts[0].hasServerKey).toBe(false);
  });

  it("'Not now' hides it and removes nothing", () => {
    seed();
    render(<ServerKeyCleanupPrompt />);
    fireEvent.click(screen.getByRole("button", { name: "Not now" }));
    expect(screen.queryByText(/Remove the copy/)).toBeNull();
    expect(api.removeSecret).not.toHaveBeenCalled();
  });

  it.each([
    ["locked", { isUnlocked: false, _secretKey: null }],
    ["no server copy", { accounts: [{ id: "a1", serverId: 9, name: "Main", publicKey: "GPUB", encryptedSecret: "c", createdAt: 1, hasServerKey: false }] }],
    ["passphrase upgrade pending", { needsPassphraseUpgrade: true }],
  ])("stays hidden when %s", (_label, over) => {
    seed(over);
    render(<ServerKeyCleanupPrompt />);
    expect(screen.queryByText(/Remove the copy/)).toBeNull();
  });

  it("stays hidden with delegated signing", () => {
    useAuthStore.setState({ signingMode: "delegated" });
    seed();
    render(<ServerKeyCleanupPrompt />);
    expect(screen.queryByText(/Remove the copy/)).toBeNull();
  });

  it("the store refuses when the server says delegated", async () => {
    seed();
    api.getMode.mockResolvedValue("delegated" as never);
    await expect(useWalletStore.getState().removeServerKeyCopy()).rejects.toThrow(/delegated/i);
    expect(api.removeSecret).not.toHaveBeenCalled();
  });
});
