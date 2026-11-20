import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const settings = readFileSync(join(__dirname, "../../../../app/settings.tsx"), "utf8");
const web = readFileSync(join(__dirname, "../../../../../web-app/src/components/WalletBackupCard.tsx"), "utf8");

/** Every `t("key", "Default text")` default in the web card, by key. */
function webDefaults(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of web.matchAll(/t\(\s*"(settings\.[A-Za-z]+)",\s*"((?:[^"\\]|\\.)*)"/g)) out[m[1]] = m[2];
  return out;
}

describe("Wallet backup and recovery on the phone", () => {
  it("replaces the old Signing Mode tiles", () => {
    expect(settings).not.toContain("Enable Delegated Signing?");
    expect(settings).not.toContain('"settings.selfCustody"');
    expect(settings).toContain("WalletBackupSection");
  });

  it("uses the same wording as the browser card", () => {
    const keys = [
      "settings.backupTitle", "settings.backupSwitch", "settings.backupOnDesc", "settings.backupOffDesc",
      "settings.backupOffWarning", "settings.backupOnWarning", "settings.backupOnDone", "settings.backupOffDone",
      "settings.phraseBackupSaved", "settings.phraseBackupMissing", "settings.phraseBackupMissingHere",
      "settings.backUpPhrase", "settings.phraseBackedUp", "settings.phraseBackupFailed",
    ];
    const defaults = webDefaults();
    for (const key of keys) {
      expect(defaults[key], `web default for ${key}`).toBeTruthy();
      expect(settings, `phone wording for ${key}`).toContain(defaults[key]);
    }
  });

  it("turns the backup on by sending the sealed key copy before switching the mode", () => {
    expect(settings).toContain("uploadKeysForBackup");
    expect(settings.indexOf("uploadKeysForBackup")).toBeLessThan(settings.indexOf('signingApi.setMode("delegated")'));
  });

  it("asks before switching either way", () => {
    expect(settings).toContain("settings.backupOffWarning");
    expect(settings).toContain("settings.backupOnWarning");
  });

  it("shows the phrase backup state only when the server offers it and the user is not in self-custody", () => {
    expect(settings).toContain("keyEscrowApi.status");
    expect(settings).toMatch(/backupOn && phraseBackup/);
  });

  it("backs the phrase up from a passphrase prompt, never from stored plain text", () => {
    expect(settings).toContain("revealMnemonic");
    expect(settings).toContain("backupRecoveryPhrase");
  });
});
