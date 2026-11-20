import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const read = (f: string) => readFileSync(join(__dirname, "../../../../app", f), "utf8");

describe("Settings wallet rows", () => {
  const settings = read("settings.tsx");

  it("offers a restore when the active wallet has no keys on this phone", () => {
    expect(settings).toContain("activeWalletHasKeys");
    expect(settings).toContain('action: "import"');
  });

  it("only shows quick unlock on a phone that can use it", () => {
    expect(settings).toContain("biometricUnlockAvailable");
    expect(settings).toMatch(/if \(!available && !on\) return null/);
  });

  it("asks for the passphrase instead of failing when the wallet is locked", () => {
    expect(settings).toMatch(/!useWalletStore\.getState\(\)\._vaultKey/);
  });
});

describe("Revealing a secret key on a wallet with no keys here", () => {
  it("says the passphrase was right and points to Restore, not a bare failure", () => {
    const settings = read("settings.tsx");
    expect(settings).not.toContain('"Failed to retrieve secret key"');
    expect(settings).toContain("keysMissingReveal");
  });
});

describe("Restoring from the Amma backup", () => {
  it("is offered next to the 12 words option and uses the store's restore", () => {
    const settings = read("settings.tsx");
    expect(settings).toContain("restoreFromServerBackup");
    expect(settings).toContain("settings.restoreBackup");
  });
});
