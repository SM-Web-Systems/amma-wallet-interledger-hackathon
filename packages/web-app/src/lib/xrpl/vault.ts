import { Wallet, ECDSA, isValidClassicAddress } from "xrpl";
import { generateMnemonic, validateMnemonic } from "bip39";
import { readEncryptedRecord, readEncryptedRecords, removeEncryptedRecord, writeEncryptedRecord, VaultError } from "./storage";
import { assertPreparedPayment, type PaymentIntent } from "./payment";
export { VaultError } from "./storage";

type Algorithm = "ed25519" | "secp256k1";
/** "xrpl-family-seed": an `s…` seed. "bip39-mnemonic": 12 or 24 words at XRP_DERIVATION_PATH. */
export type KeyFormat = "xrpl-family-seed" | "bip39-mnemonic";
/** BIP-44 path for XRP (coin type 144), as used by Ledger, Xaman and most XRP wallets. */
export const XRP_DERIVATION_PATH = "m/44'/144'/0'/0/0";
export const XRP_RECOVERY_WORD_COUNTS = [12, 24] as const;
export interface LocalWallet { ownerId: string; address: string; name: string; algorithm: Algorithm }
interface EncryptedVault extends LocalWallet {
  id: string;
  version: 1;
  chain: "xrpl";
  network: "testnet";
  keyFormat: KeyFormat;
  backupVerified: true;
  kdf: { name: "PBKDF2"; hash: "SHA-256"; iterations: 600000; salt: string };
  cipher: { name: "AES-GCM"; iv: string; data: string };
}
const encoder = new TextEncoder();
function buffer(value: Uint8Array): ArrayBuffer { return new Uint8Array(value).buffer; }
function encode(value: Uint8Array) { return btoa(String.fromCharCode(...value)); }
function decode(value: unknown, size?: number, maxLength = 256): Uint8Array {
  if (typeof value !== "string" || value.length > maxLength || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) throw new VaultError("CORRUPT_VAULT");
  const result = Uint8Array.from(atob(value), (c) => c.charCodeAt(0));
  if ((size !== undefined && result.length !== size) || encode(result) !== value) throw new VaultError("CORRUPT_VAULT");
  return result;
}
function owner(value: string) {
  if (!/^[1-9][0-9]{0,14}$/.test(value)) throw new VaultError("INVALID_OWNER");
  return value;
}
export function vaultIdentity(ownerId: string, address: string) {
  if (!isValidClassicAddress(address)) throw new VaultError("INVALID_ADDRESS");
  return `xrpl:testnet:${owner(ownerId)}:${address}`;
}
export function validatePassphrase(passphrase: string) {
  if (passphrase.length < 12 || passphrase.length > 128 || !passphrase.trim() || /^\d+$/.test(passphrase)) throw new VaultError("WEAK_PASSPHRASE");
}
/** NFKD, lower case, single spaces: pasted phrases with capitals or line breaks still match. */
export function normalizeRecoveryPhrase(input: string) {
  return input.normalize("NFKD").toLowerCase().trim().split(/\s+/).join(" ");
}
function formatOf(input: string): KeyFormat {
  return /\s/.test(input.trim()) ? "bip39-mnemonic" : "xrpl-family-seed";
}
function walletFrom(secret: string, format: KeyFormat) {
  return format === "bip39-mnemonic" ? Wallet.fromMnemonic(secret, { derivationPath: XRP_DERIVATION_PATH }) : Wallet.fromSeed(secret);
}
function algorithmOf(wallet: Wallet): Algorithm { return wallet.publicKey.startsWith("ED") ? "ed25519" : "secp256k1"; }
/** The canonical secret text for a family seed or a recovery phrase. */
function canonical(input: string): { secret: string; keyFormat: KeyFormat } {
  const keyFormat = formatOf(input);
  return { keyFormat, secret: keyFormat === "bip39-mnemonic" ? normalizeRecoveryPhrase(input) : input.trim() };
}
function publicFromSeed(input: string) {
  const { secret, keyFormat } = canonical(input);
  if (keyFormat === "xrpl-family-seed" && (secret.length < 20 || secret.length > 64)) throw new VaultError("INVALID_SEED");
  if (keyFormat === "bip39-mnemonic" && (secret.length > 300 || !validateMnemonic(secret))) throw new VaultError("INVALID_SEED");
  try {
    const wallet = walletFrom(secret, keyFormat);
    return { seed: secret, keyFormat, address: wallet.classicAddress, algorithm: algorithmOf(wallet) };
  } catch { throw new VaultError("INVALID_SEED"); }
}
export function createRecoverySeed() {
  const wallet = Wallet.generate(ECDSA.ed25519);
  if (!wallet.seed) throw new VaultError("GENERATION_FAILED");
  return { seed: wallet.seed, address: wallet.classicAddress };
}
/** A new 12- or 24-word BIP-39 phrase and the address it controls on XRPL. */
export function createRecoveryPhrase(wordCount: (typeof XRP_RECOVERY_WORD_COUNTS)[number] = 24) {
  if (!XRP_RECOVERY_WORD_COUNTS.includes(wordCount)) throw new VaultError("INVALID_WORD_COUNT");
  const phrase = generateMnemonic(wordCount === 24 ? 256 : 128);
  return { phrase, address: walletFrom(phrase, "bip39-mnemonic").classicAddress };
}
// Family-seed records written before phrases existed keep the same AAD, so they still open.
function aad(record: LocalWallet & { keyFormat: KeyFormat }) {
  return encoder.encode(JSON.stringify([1, record.keyFormat, record.algorithm, record.ownerId, "xrpl", "testnet", record.address]));
}
function keys(value: unknown, expected: string[]): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value) && Object.keys(value).sort().join() === expected.sort().join();
}
function checked(value: unknown, ownerId: string): EncryptedVault {
  if (!keys(value, ["id", "version", "chain", "network", "keyFormat", "backupVerified", "ownerId", "address", "name", "algorithm", "kdf", "cipher"]) || value.version !== 1 || value.chain !== "xrpl" || value.network !== "testnet" || !["xrpl-family-seed", "bip39-mnemonic"].includes(String(value.keyFormat)) || value.backupVerified !== true || value.ownerId !== ownerId || typeof value.address !== "string" || typeof value.name !== "string" || value.name.length < 1 || value.name.length > 64 || !["ed25519", "secp256k1"].includes(String(value.algorithm))) throw new VaultError("CORRUPT_VAULT");
  if (value.id !== vaultIdentity(ownerId, value.address)) throw new VaultError("CORRUPT_VAULT");
  if (!keys(value.kdf, ["name", "hash", "iterations", "salt"]) || value.kdf.name !== "PBKDF2" || value.kdf.hash !== "SHA-256" || value.kdf.iterations !== 600000 || !keys(value.cipher, ["name", "iv", "data"]) || value.cipher.name !== "AES-GCM") throw new VaultError("CORRUPT_VAULT");
  decode(value.kdf.salt, 16); decode(value.cipher.iv, 12);
  const ciphertext = decode(value.cipher.data, undefined, 400);
  // 16-byte tag plus a 29–31 character seed, or a 12–24 word phrase.
  const [min, max] = value.keyFormat === "bip39-mnemonic" ? [60, 280] : [36, 80];
  if (ciphertext.length < min || ciphertext.length > max) throw new VaultError("CORRUPT_VAULT");
  if (value.keyFormat === "bip39-mnemonic" && value.algorithm !== "secp256k1") throw new VaultError("CORRUPT_VAULT");
  return value as unknown as EncryptedVault;
}
function metadata(record: LocalWallet): LocalWallet {
  return { ownerId: record.ownerId, address: record.address, name: record.name, algorithm: record.algorithm };
}
async function key(passphrase: string, salt: Uint8Array) {
  const raw = encoder.encode(passphrase);
  try {
    const material = await crypto.subtle.importKey("raw", buffer(raw), "PBKDF2", false, ["deriveKey"]);
    return await crypto.subtle.deriveKey({ name: "PBKDF2", hash: "SHA-256", iterations: 600000, salt: buffer(salt) }, material, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
  } finally { raw.fill(0); }
}

export async function listLocalWallets(ownerId: string): Promise<LocalWallet[]> {
  owner(ownerId);
  const records = await readEncryptedRecords();
  return records.filter((record) => !!record && typeof record === "object" && "ownerId" in record && record.ownerId === ownerId).map((record) => metadata(checked(record, ownerId)));
}

/** Decrypt, verify address/algorithm, then discard private material. No seed is returned or cached. */
async function withLocalWallet<T>(ownerId: string, address: string, passphrase: string, action: (wallet: Wallet, record: LocalWallet, secret: string) => T): Promise<T> {
  validatePassphrase(passphrase);
  const value = await readEncryptedRecord(vaultIdentity(ownerId, address));
  if (!value) throw new VaultError("RESTORE_REQUIRED");
  const record = checked(value, ownerId);
  const cryptoKey = await key(passphrase, decode(record.kdf.salt, 16));
  let plain: Uint8Array;
  try { plain = new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv: buffer(decode(record.cipher.iv, 12)), additionalData: buffer(aad(record)), tagLength: 128 }, cryptoKey, buffer(decode(record.cipher.data, undefined, 400)))); }
  catch { throw new VaultError("UNLOCK_FAILED"); }
  try {
    let wallet: Wallet;
    const secret = new TextDecoder().decode(plain);
    try { wallet = walletFrom(secret, record.keyFormat); } catch { throw new VaultError("CORRUPT_VAULT"); }
    const algorithm = algorithmOf(wallet);
    if (wallet.classicAddress !== address || algorithm !== record.algorithm) throw new VaultError("CORRUPT_VAULT");
    return action(wallet, record, secret);
  } finally { plain.fill(0); }
}

/** For "Move to Amma" only: the recovery phrase or family seed, after the device passphrase unlocks it. Use once, then drop it. */
export const revealLocalSecret = (ownerId: string, address: string, passphrase: string) =>
  withLocalWallet(ownerId, address, passphrase, (_wallet, _record, secret) => secret);

/** Deletes this device's encrypted copy of one wallet. */
export async function removeLocalWallet(ownerId: string, address: string): Promise<void> {
  await removeEncryptedRecord(vaultIdentity(ownerId, address));
}

export async function verifyLocalRecovery(ownerId: string, address: string, passphrase: string): Promise<LocalWallet> {
  return withLocalWallet(ownerId, address, passphrase, (_wallet, record) => metadata(record));
}

/**
 * Re-encrypts one local wallet under a new passphrase, with a fresh salt and IV. The seed is decrypted
 * only inside this call and wiped afterwards. If the new copy does not open, the old record is put back.
 */
export async function changeLocalPassphrase(ownerId: string, address: string, current: string, next: string): Promise<LocalWallet> {
  validatePassphrase(current);
  validatePassphrase(next);
  if (current === next) throw new VaultError("SAME_PASSPHRASE");
  const value = await readEncryptedRecord(vaultIdentity(ownerId, address));
  if (!value) throw new VaultError("RESTORE_REQUIRED");
  const record = checked(value, ownerId);
  const oldKey = await key(current, decode(record.kdf.salt, 16));
  let plain: Uint8Array;
  try { plain = new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv: buffer(decode(record.cipher.iv, 12)), additionalData: buffer(aad(record)), tagLength: 128 }, oldKey, buffer(decode(record.cipher.data, undefined, 400)))); }
  catch { throw new VaultError("UNLOCK_FAILED"); }
  try {
    let wallet: Wallet;
    try { wallet = walletFrom(new TextDecoder().decode(plain), record.keyFormat); } catch { throw new VaultError("CORRUPT_VAULT"); }
    if (wallet.classicAddress !== address || algorithmOf(wallet) !== record.algorithm) throw new VaultError("CORRUPT_VAULT");
    const salt = crypto.getRandomValues(new Uint8Array(16));
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const updated: EncryptedVault = { ...record, kdf: { ...record.kdf, salt: encode(salt) }, cipher: { ...record.cipher, iv: encode(iv), data: "" } };
    const newKey = await key(next, salt);
    updated.cipher.data = encode(new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: buffer(iv), additionalData: buffer(aad(updated)), tagLength: 128 }, newKey, buffer(plain))));
    await writeEncryptedRecord(updated);
  } finally { plain.fill(0); }
  try { return await verifyLocalRecovery(ownerId, address, next); }
  catch (error) { await writeEncryptedRecord(record); throw error; }
}

/** One explicitly approved native Testnet payment; never exposes a seed/key. */
export async function signApprovedPayment(ownerId: string, address: string, passphrase: string, intent: PaymentIntent, signal?: AbortSignal): Promise<{ blob: string; hash: string }> {
  const approved = structuredClone(intent);
  if (approved.ownerId !== ownerId || !approved.preparation) throw new VaultError("INVALID_PAYMENT");
  signal?.throwIfAborted();
  const transaction = await assertPreparedPayment(approved, approved.preparation, address);
  signal?.throwIfAborted();
  const result = await withLocalWallet(ownerId, address, passphrase, wallet => {
    signal?.throwIfAborted();
    const signed = wallet.sign(transaction);
    return { blob: signed.tx_blob, hash: signed.hash };
  });
  signal?.throwIfAborted();
  return result;
}

export async function saveLocalWallet(input: { ownerId: string; name: string; seed: string; seedConfirmation: string; passphrase: string; backupAcknowledged: boolean }): Promise<LocalWallet> {
  validatePassphrase(input.passphrase);
  if (!input.backupAcknowledged || canonical(input.seed).secret !== canonical(input.seedConfirmation).secret) throw new VaultError("BACKUP_REQUIRED");
  const name = input.name.trim();
  if (!name || name.length > 64) throw new VaultError("INVALID_NAME");
  const derived = publicFromSeed(input.seed);
  const identity = vaultIdentity(input.ownerId, derived.address);
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const record: EncryptedVault = { id: identity, version: 1, chain: "xrpl", network: "testnet", keyFormat: derived.keyFormat, backupVerified: true,
    ownerId: input.ownerId, name, address: derived.address, algorithm: derived.algorithm,
    kdf: { name: "PBKDF2", hash: "SHA-256", iterations: 600000, salt: encode(salt) }, cipher: { name: "AES-GCM", iv: encode(iv), data: "" } };
  const cryptoKey = await key(input.passphrase, salt);
  const plain = encoder.encode(derived.seed);
  try { record.cipher.data = encode(new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: buffer(iv), additionalData: buffer(aad(record)), tagLength: 128 }, cryptoKey, buffer(plain)))); }
  finally { plain.fill(0); }
  await writeEncryptedRecord(record);
  // A successful save includes a read/decrypt/address round-trip, not just put().
  return verifyLocalRecovery(input.ownerId, derived.address, input.passphrase);
}
