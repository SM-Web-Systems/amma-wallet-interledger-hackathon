import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// Logic-level checks on the phone's recovery screen (the app has no rendering tests).
const screen = readFileSync(join(__dirname, "../../../../app/recover.tsx"), "utf8");
const settings = readFileSync(join(__dirname, "../../../../app/settings.tsx"), "utf8");
const lock = readFileSync(join(__dirname, "../../../../app/lock-screen.tsx"), "utf8");

describe("recover my wallet on the phone", () => {
  it("walks the same steps as the browser: code, start, wait, cancel, finish", () => {
    for (const call of ["keyRecoveryApi.status", "keyRecoveryApi.sendCode", "keyRecoveryApi.start", "keyRecoveryApi.cancel", "keyRecoveryApi.complete"]) expect(screen).toContain(call);
  });

  it("says the wait is 48 hours", () => {
    expect(screen).toContain("48 hours");
  });

  it("puts the recovered phrase straight onto the phone, and shows it once only if that fails", () => {
    expect(screen).toContain("importFromMnemonic");
    expect(screen.indexOf("keyRecoveryApi.complete")).toBeLessThan(screen.indexOf("importFromMnemonic"));
    expect(screen).toMatch(/rescue/i);
  });

  it("never logs, stores or sends the phrase anywhere else", () => {
    expect(screen).not.toMatch(/console\.(log|warn|error|info)/);
    expect(screen).not.toMatch(/AsyncStorage|SecureStore|analytics/i);
  });

  it("needs the phone unlocked before it releases the one-time phrase", () => {
    expect(screen).toContain("isUnlocked");
    expect(screen.indexOf("isUnlocked")).toBeLessThan(screen.indexOf("keyRecoveryApi.complete"));
  });

  it("checks this phone's passphrase before the one-time phrase is released, then refreshes Amma's copy with it", () => {
    expect(screen.indexOf(".unlock(")).toBeGreaterThan(-1);
    expect(screen.indexOf(".unlock(")).toBeLessThan(screen.indexOf("keyRecoveryApi.complete"));
    expect(screen.indexOf("importFromMnemonic")).toBeLessThan(screen.indexOf("uploadKeysForBackup"));
  });

  it("is reachable from Settings and from the forgotten-passphrase prompt", () => {
    expect(settings).toContain('"/recover"');
    expect(lock).toContain("Recover my wallet");
  });
});
