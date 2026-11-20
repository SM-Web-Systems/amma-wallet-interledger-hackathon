import { describe, it, expect } from "vitest";
import crypto from "node:crypto";
import { openBackupSecret, sealBackupSecret } from "../backup-secret";

// Builds a copy exactly the way the web app and the server do:
// base64(salt 16 + iv 12 + AES-256-GCM ciphertext + tag), key = PBKDF2-SHA256(passphrase, salt, 600000).
function makeCopy(secret: string, passphrase: string, iterations = 600_000): string {
  const salt = crypto.randomBytes(16);
  const iv = crypto.randomBytes(12);
  const key = crypto.pbkdf2Sync(passphrase, salt, iterations, 32, "sha256");
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const ct = Buffer.concat([cipher.update(secret, "utf8"), cipher.final()]);
  return Buffer.concat([salt, iv, ct, cipher.getAuthTag()]).toString("base64");
}

// Public test secret, not a real wallet.
const SECRET = "SBGWSG6BTNCKCOB3DIFBGCVMUPQFYPA2G4O34RMTB343OYPXU5DJDVMN";
const PASS = "laptop passphrase here";

describe("openBackupSecret", () => {
  it("opens a copy made by the web app and the server", async () => {
    expect(await openBackupSecret(makeCopy(SECRET, PASS), PASS)).toBe(SECRET);
  }, 60000);

  it("says the passphrase is wrong, without leaking anything else", async () => {
    const blob = makeCopy(SECRET, PASS, 1000);
    await expect(openBackupSecret(blob, "some other passphrase", 1000)).rejects.toThrow(/passphrase/i);
    await expect(openBackupSecret(blob, "some other passphrase", 1000)).rejects.not.toThrow(SECRET);
  });

  it("refuses a copy that is too short or not base64", async () => {
    await expect(openBackupSecret("", PASS)).rejects.toThrow(/copy/i);
    await expect(openBackupSecret("not base64 !!", PASS)).rejects.toThrow(/copy/i);
    await expect(openBackupSecret(Buffer.alloc(20).toString("base64"), PASS)).rejects.toThrow(/copy/i);
  });

  it("only returns a Stellar secret key", async () => {
    const blob = makeCopy("not a secret key", PASS, 1000);
    await expect(openBackupSecret(blob, PASS, 1000)).rejects.toThrow(/copy/i);
  });
});

describe("sealBackupSecret", () => {
  it("makes a copy that the server and the web app can open (same format)", async () => {
    const blob = await sealBackupSecret(SECRET, PASS, 1000);
    const raw = Buffer.from(blob, "base64");
    expect(raw.length).toBe(16 + 12 + SECRET.length + 16);
    const key = crypto.pbkdf2Sync(PASS, raw.subarray(0, 16), 1000, 32, "sha256");
    const decipher = crypto.createDecipheriv("aes-256-gcm", key, raw.subarray(16, 28));
    decipher.setAuthTag(raw.subarray(raw.length - 16));
    const out = Buffer.concat([decipher.update(raw.subarray(28, raw.length - 16)), decipher.final()]).toString("utf8");
    expect(out).toBe(SECRET);
  });

  it("round-trips with openBackupSecret and uses fresh salt and iv each time", async () => {
    const a = await sealBackupSecret(SECRET, PASS, 1000);
    const b = await sealBackupSecret(SECRET, PASS, 1000);
    expect(a).not.toBe(b);
    expect(await openBackupSecret(a, PASS, 1000)).toBe(SECRET);
  });

  it("fits what the server accepts for a stored copy (96 to 512 base64 characters)", async () => {
    const blob = await sealBackupSecret(SECRET, PASS, 1000);
    expect(blob.length).toBeGreaterThanOrEqual(96);
    expect(blob.length).toBeLessThanOrEqual(512);
    expect(blob).toMatch(/^[A-Za-z0-9+/]+={0,2}$/);
  });

  it("refuses to seal something that is not a Stellar secret key", async () => {
    await expect(sealBackupSecret("not a key", PASS, 1000)).rejects.toThrow(/secret key/i);
  });

  it("never contains the secret in readable form", async () => {
    const blob = await sealBackupSecret(SECRET, PASS, 1000);
    expect(blob).not.toContain(SECRET);
    expect(Buffer.from(blob, "base64").toString("latin1")).not.toContain(SECRET.slice(0, 12));
  });
});
