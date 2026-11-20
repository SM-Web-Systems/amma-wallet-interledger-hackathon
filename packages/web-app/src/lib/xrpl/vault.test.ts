// @vitest-environment node
// Crypto/IndexedDB library test: jsdom's realm breaks Uint8Array identity checks in @noble and Stellar SDKs.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { IDBFactory } from "fake-indexeddb";
import { webcrypto } from "node:crypto";
import { Wallet, ECDSA } from "xrpl";
import { changeLocalPassphrase, createRecoveryPhrase, createRecoverySeed, listLocalWallets, saveLocalWallet, verifyLocalRecovery, vaultIdentity, XRP_DERIVATION_PATH } from "./vault";
import { readEncryptedRecord, writeEncryptedRecord } from "./storage";

const passphrase = "test vault phrase with spaces";
beforeEach(() => { vi.stubGlobal("indexedDB", new IDBFactory()); vi.stubGlobal("crypto", webcrypto); });
function input(seed = createRecoverySeed().seed) {
  return { ownerId: "1", name: "Test wallet", seed, seedConfirmation: seed, passphrase, backupAcknowledged: true };
}

// Real 600k-iteration WebCrypto work can contend with the backend suite on CI.
describe("XRP browser-local vault", { timeout: 20000 }, () => {
  it("round-trips a generated Ed25519 seed after reopening IndexedDB, without returning or persisting plaintext", async () => {
    const value = input(); const saved = await saveLocalWallet(value);
    expect(saved.algorithm).toBe("ed25519");
    expect(await verifyLocalRecovery("1", saved.address, passphrase)).toEqual(saved);
    expect(await listLocalWallets("1")).toEqual([saved]);
    const serialized = JSON.stringify(await readEncryptedRecord(vaultIdentity("1", saved.address)));
    expect(serialized).not.toContain(value.seed); expect(serialized).not.toContain(passphrase);
    expect(JSON.stringify(saved)).not.toContain(value.seed);
    expect(serialized).toContain('"iterations":600000');
  });
  it.each([ECDSA.ed25519, ECDSA.secp256k1])("restores %s family seeds and can reset a lost local passphrase", async (algorithm) => {
      const source = Wallet.generate(algorithm); const saved = await saveLocalWallet(input(source.seed!));
      expect(saved.address).toBe(source.classicAddress); expect(saved.algorithm).toBe(algorithm === ECDSA.ed25519 ? "ed25519" : "secp256k1");
      const replacement = "replacement local phrase";
      await saveLocalWallet({ ...input(source.seed!), passphrase: replacement });
      await expect(verifyLocalRecovery("1", saved.address, passphrase)).rejects.toThrow("UNLOCK_FAILED");
      expect((await verifyLocalRecovery("1", saved.address, replacement)).address).toBe(saved.address);
  }, 15000);
  it("rejects mismatched/unacknowledged backups and numeric PINs before saving", async () => {
    const value = input();
    for (const change of [{ seedConfirmation: "wrong" }, { backupAcknowledged: false }, { passphrase: "123456789012" }, { passphrase: "            " }]) {
      await expect(saveLocalWallet({ ...value, ...change })).rejects.toThrow();
    }
    expect(await listLocalWallets("1")).toEqual([]);
    await expect(saveLocalWallet(input("not a family seed at all"))).rejects.toThrow("INVALID_SEED");
  });
  it("wrong-passphrase failure leaves the recoverable ciphertext unchanged", async () => {
    const saved = await saveLocalWallet(input()); const id = vaultIdentity("1", saved.address);
    const before = JSON.stringify(await readEncryptedRecord(id));
    await expect(verifyLocalRecovery("1", saved.address, "an incorrect long phrase")).rejects.toThrow("UNLOCK_FAILED");
    expect(JSON.stringify(await readEncryptedRecord(id))).toBe(before);
    expect((await verifyLocalRecovery("1", saved.address, passphrase)).address).toBe(saved.address);
  });
  it("separates user namespaces and authenticates owner/address identity", async () => {
    const saved = await saveLocalWallet(input());
    expect(await listLocalWallets("2")).toEqual([]);
    await expect(verifyLocalRecovery("2", saved.address, passphrase)).rejects.toThrow("RESTORE_REQUIRED");
    const record = await readEncryptedRecord(vaultIdentity("1", saved.address)) as any;
    await writeEncryptedRecord({ ...record, ownerId: "2", id: vaultIdentity("2", saved.address) });
    await expect(verifyLocalRecovery("2", saved.address, passphrase)).rejects.toThrow("UNLOCK_FAILED");
    const different = createRecoverySeed().address;
    await writeEncryptedRecord({ ...record, address: different, id: vaultIdentity("1", different) });
    await expect(verifyLocalRecovery("1", different, passphrase)).rejects.toThrow("UNLOCK_FAILED");
  });
  it("rejects tampered formats/KDF parameters instead of running attacker-selected crypto", async () => {
    const saved = await saveLocalWallet(input()); const id = vaultIdentity("1", saved.address);
    const record = await readEncryptedRecord(id) as any;
    for (const change of [{ version: 2 }, { network: "mainnet" }, { backupVerified: false }, { kdf: { ...record.kdf, iterations: 999999999 } }, { cipher: { ...record.cipher, iv: "a" } }, { unexpected: "field" }]) {
      await writeEncryptedRecord({ ...record, ...change });
      await expect(verifyLocalRecovery("1", saved.address, passphrase)).rejects.toThrow("CORRUPT_VAULT");
    }
    await writeEncryptedRecord(record);
    const ciphertext = atob(record.cipher.data); const changed = String.fromCharCode(ciphertext.charCodeAt(0) ^ 1) + ciphertext.slice(1);
    await writeEncryptedRecord({ ...record, cipher: { ...record.cipher, data: btoa(changed) } });
    await expect(verifyLocalRecovery("1", saved.address, passphrase)).rejects.toThrow("UNLOCK_FAILED");
  });
  it("uses fresh salts and IVs, never a deterministic encrypted blob", async () => {
    const value = input(); const saved = await saveLocalWallet(value); const id = vaultIdentity("1", saved.address);
    const first = await readEncryptedRecord(id) as any; await saveLocalWallet(value); const second = await readEncryptedRecord(id) as any;
    expect(second.kdf.salt).not.toBe(first.kdf.salt); expect(second.cipher.iv).not.toBe(first.cipher.iv); expect(second.cipher.data).not.toBe(first.cipher.data);
  });
  it("does not fall back to plaintext/localStorage when IndexedDB is unavailable", async () => {
    vi.stubGlobal("indexedDB", undefined);
    await expect(saveLocalWallet(input())).rejects.toThrow("STORAGE_UNAVAILABLE");
    vi.stubGlobal("indexedDB", { open() { throw new DOMException("quota", "QuotaExceededError"); } });
    await expect(listLocalWallets("1")).rejects.toThrow("STORAGE_UNAVAILABLE");
  });
});

// BIP-39 vector "abandon ×11 about" at m/44'/144'/0'/0/0 (the path Ledger and most XRP wallets use);
// cross-checked against @scure/bip32 + ripple-keypairs.
const ABANDON_12 = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
const ABANDON_12_ADDRESS = "rHsMGQEkVNJmpGWs8XUBoTBiAAbwxZN5v3";
const ABANDON_24 = `${"abandon ".repeat(23)}art`;
const ABANDON_24_ADDRESS = "rKxpJQ6hLWYbo7p1oo7WHjrcrRFv1TUQeC";

describe("XRP recovery phrases (12 or 24 words)", { timeout: 20000 }, () => {
  it("uses the standard XRP derivation path", () => {
    expect(XRP_DERIVATION_PATH).toBe("m/44'/144'/0'/0/0");
  });
  it.each([[ABANDON_12, ABANDON_12_ADDRESS], [ABANDON_24, ABANDON_24_ADDRESS]])("restores the published vector to the same address as other XRP wallets", async (phrase, address) => {
    const saved = await saveLocalWallet(input(phrase));
    expect(saved.address).toBe(address);
    expect(saved.algorithm).toBe("secp256k1");
    const record = await readEncryptedRecord(vaultIdentity("1", address)) as any;
    expect(record.keyFormat).toBe("bip39-mnemonic");
    expect(JSON.stringify(record)).not.toContain("abandon");
    expect((await verifyLocalRecovery("1", address, passphrase)).address).toBe(address);
  });
  it.each([12, 24] as const)("creates a valid %i-word phrase whose shown address is the saved one", async (count) => {
    const created = createRecoveryPhrase(count);
    expect(created.phrase.split(" ")).toHaveLength(count);
    const saved = await saveLocalWallet(input(created.phrase));
    expect(saved.address).toBe(created.address);
  });
  it("refuses other word counts when creating", () => {
    expect(() => createRecoveryPhrase(18 as never)).toThrow("INVALID_WORD_COUNT");
  });
  it("accepts pasted phrases with capitals, extra spaces and line breaks", async () => {
    const messy = `  ${ABANDON_12.toUpperCase().replace(/ /g, "  ").replace("ABOUT", "\nABOUT")} `;
    const saved = await saveLocalWallet({ ...input(messy), seedConfirmation: ABANDON_12 });
    expect(saved.address).toBe(ABANDON_12_ADDRESS);
  });
  it("rejects a phrase with a bad checksum or a mismatched confirmation", async () => {
    await expect(saveLocalWallet(input(ABANDON_12.replace(/about$/, "abandon")))).rejects.toThrow("INVALID_SEED");
    await expect(saveLocalWallet({ ...input(ABANDON_12), seedConfirmation: ABANDON_24 })).rejects.toThrow("BACKUP_REQUIRED");
  });
  it("binds the key format so a record cannot be relabelled", async () => {
    const saved = await saveLocalWallet(input(ABANDON_12)); const id = vaultIdentity("1", saved.address);
    const record = await readEncryptedRecord(id) as any;
    await writeEncryptedRecord({ ...record, keyFormat: "xrpl-family-seed" });
    await expect(verifyLocalRecovery("1", saved.address, passphrase)).rejects.toThrow(/CORRUPT_VAULT|UNLOCK_FAILED/);
    await writeEncryptedRecord({ ...record, keyFormat: "other" });
    await expect(verifyLocalRecovery("1", saved.address, passphrase)).rejects.toThrow("CORRUPT_VAULT");
  });
  it("keeps family seeds working: the same seed gives the same address and format", async () => {
    const source = Wallet.generate(ECDSA.secp256k1);
    const saved = await saveLocalWallet(input(source.seed!));
    expect(saved.address).toBe(source.classicAddress);
    expect((await readEncryptedRecord(vaultIdentity("1", saved.address)) as any).keyFormat).toBe("xrpl-family-seed");
  });
});

describe("changing the XRP local passphrase", { timeout: 30000 }, () => {
  const next = "a brand new vault phrase";

  it.each(["seed", "phrase"] as const)("re-encrypts a %s wallet: the new passphrase opens it, the old one does not, the address is unchanged", async (kind) => {
    const source = kind === "seed" ? createRecoverySeed().seed : createRecoveryPhrase(12).phrase;
    const saved = await saveLocalWallet(input(source));
    const id = vaultIdentity("1", saved.address);
    const before = (await readEncryptedRecord(id)) as { kdf: { salt: string }; cipher: { iv: string; data: string } };
    expect(await changeLocalPassphrase("1", saved.address, passphrase, next)).toEqual(saved);
    expect((await verifyLocalRecovery("1", saved.address, next)).address).toBe(saved.address);
    await expect(verifyLocalRecovery("1", saved.address, passphrase)).rejects.toThrow("UNLOCK_FAILED");
    const after = (await readEncryptedRecord(id)) as typeof before;
    expect(after.kdf.salt).not.toBe(before.kdf.salt);
    expect(after.cipher.iv).not.toBe(before.cipher.iv);
    expect(after.cipher.data).not.toBe(before.cipher.data);
    expect(JSON.stringify(after)).not.toContain(source);
  });

  it("refuses a wrong current passphrase and leaves the stored record exactly as it was", async () => {
    const saved = await saveLocalWallet(input()); const id = vaultIdentity("1", saved.address);
    const before = JSON.stringify(await readEncryptedRecord(id));
    await expect(changeLocalPassphrase("1", saved.address, "an incorrect long phrase", next)).rejects.toThrow("UNLOCK_FAILED");
    expect(JSON.stringify(await readEncryptedRecord(id))).toBe(before);
  });

  it("refuses a weak or unchanged new passphrase before touching anything", async () => {
    const saved = await saveLocalWallet(input()); const id = vaultIdentity("1", saved.address);
    const before = JSON.stringify(await readEncryptedRecord(id));
    for (const weak of ["short", "123456789012", "            "]) {
      await expect(changeLocalPassphrase("1", saved.address, passphrase, weak)).rejects.toThrow("WEAK_PASSPHRASE");
    }
    await expect(changeLocalPassphrase("1", saved.address, passphrase, passphrase)).rejects.toThrow("SAME_PASSPHRASE");
    expect(JSON.stringify(await readEncryptedRecord(id))).toBe(before);
  });

  it("needs a stored wallet for that owner", async () => {
    const saved = await saveLocalWallet(input());
    await expect(changeLocalPassphrase("2", saved.address, passphrase, next)).rejects.toThrow("RESTORE_REQUIRED");
  });
});
