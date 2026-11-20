// @vitest-environment node
import { describe, it, expect, beforeEach } from "vitest";

import { useWalletStore } from "./wallet";
import { useAuthStore } from "./auth";
import { encryptSecret } from "../lib/crypto";

// Legacy short wallet passphrases (PINs) are retired: a correct one never opens the wallet for signing.
// It may only move the wallet into the Amma account (components/PinRetiredPrompt.tsx, lib/pin-retire.ts).
const SECRET = "SBGWSG6BTNCKCOB3DIFBGCVMUPQFYPA2G4O34RMTB343OYPXU5DJDVMN";
const STRONG = "lamp river garden 42";

async function seed(pin: string) {
  useWalletStore.setState({
    accounts: [{ id: "a1", serverId: 9, name: "Main", publicKey: "GPUB", encryptedSecret: await encryptSecret(SECRET, pin), createdAt: 1 }],
    activeAccountId: "a1", isUnlocked: false, _secretKey: null, _mnemonic: null, needsPassphraseUpgrade: false,
  } as never);
}

describe("retired short wallet passphrases", () => {
  beforeEach(() => { useAuthStore.setState({ signingMode: "self" }); });

  it("a correct old 6-character PIN does not unlock; it flags the move to Amma", async () => {
    await seed("123456");
    await expect(useWalletStore.getState().unlock("123456")).rejects.toMatchObject({ code: "pin-retired" });
    expect(useWalletStore.getState().isUnlocked).toBe(false);
    expect(useWalletStore.getState()._secretKey).toBeNull();
    expect(useWalletStore.getState().needsPassphraseUpgrade).toBe(true);
  });

  it("a wrong old PIN is still just wrong, and flags nothing", async () => {
    await seed("123456");
    await expect(useWalletStore.getState().unlock("654321")).rejects.not.toMatchObject({ code: "pin-retired" });
    expect(useWalletStore.getState().needsPassphraseUpgrade).toBe(false);
  });

  it("a wallet on a strong passphrase unlocks as before", async () => {
    await seed(STRONG);
    await useWalletStore.getState().unlock(STRONG);
    expect(useWalletStore.getState().isUnlocked).toBe(true);
    expect(useWalletStore.getState().needsPassphraseUpgrade).toBe(false);
  });

  it("switching wallet clears the prompt", async () => {
    await seed("123456");
    await useWalletStore.getState().unlock("123456").catch(() => undefined);
    useWalletStore.getState().switchAccount("a1");
    expect(useWalletStore.getState().needsPassphraseUpgrade).toBe(false);
  });
});
