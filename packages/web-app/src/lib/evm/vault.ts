import {
  createMnemonic, deriveEvmAccount, normalizeAddress, normalizeMnemonic, signApprovedTransfer as signTransfer,
  signApprovedCancel as signCancel, type CancelIntent, type PreparedCancel, type PreparedTransfer, type SignedTransfer, type TransferIntent,
} from "@amma-wallet/evm-core";
import { encryptedRecordStore, VaultError } from "../xrpl/storage";
export { VaultError } from "../xrpl/storage";

/**
 * Browser-local Ethereum Sepolia vault. Same protection as the XRP vault:
 * PBKDF2-SHA256 (600k) -> AES-256-GCM, fresh salt and IV per save, and the
 * ciphertext bound (AAD) to version, key format, path, owner, network and
 * address. The mnemonic never leaves this module and is never sent anywhere.
 *
 * Each Sepolia wallet has its own new mnemonic: reusing the Stellar mnemonic is
 * an open owner decision (docs/evm/DESIGN.md), so it is not done here.
 */
export const EVM_VAULT_DATABASE = "amma-evm-vault-v1";
const store = encryptedRecordStore(EVM_VAULT_DATABASE);
const NETWORK = "ethereum-sepolia";
const PATH = "m/44'/60'/0'/0/0";

export interface LocalEvmWallet { ownerId: string; address: `0x${string}`; name: string }
interface EncryptedEvmVault extends LocalEvmWallet {
  id: string; version: 1; chain: "ethereum"; network: typeof NETWORK; keyFormat: "bip39-mnemonic"; derivationPath: typeof PATH; backupVerified: true;
  kdf: { name: "PBKDF2"; hash: "SHA-256"; iterations: 600000; salt: string };
  cipher: { name: "AES-GCM"; iv: string; data: string };
}

const encoder = new TextEncoder();
const buffer = (value: Uint8Array): ArrayBuffer => new Uint8Array(value).buffer;
const encode = (value: Uint8Array) => btoa(String.fromCharCode(...value));
function decode(value: unknown, size?: number): Uint8Array {
  if (typeof value !== "string" || value.length > 512 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) throw new VaultError("CORRUPT_VAULT");
  const result = Uint8Array.from(atob(value), (c) => c.charCodeAt(0));
  if ((size !== undefined && result.length !== size) || encode(result) !== value) throw new VaultError("CORRUPT_VAULT");
  return result;
}
function owner(value: string) { if (!/^[1-9][0-9]{0,14}$/.test(value)) throw new VaultError("INVALID_OWNER"); return value; }
function address(value: string) { try { return normalizeAddress(value); } catch { throw new VaultError("INVALID_ADDRESS"); } }
export const evmVaultIdentity = (ownerId: string, wallet: string) => `evm:${NETWORK}:${owner(ownerId)}:${address(wallet)}`;
export function validatePassphrase(passphrase: string) {
  if (passphrase.length < 12 || passphrase.length > 128 || !passphrase.trim() || /^\d+$/.test(passphrase)) throw new VaultError("WEAK_PASSPHRASE");
}
const aad = (r: LocalEvmWallet) => encoder.encode(JSON.stringify([1, "bip39-mnemonic", PATH, r.ownerId, "ethereum", NETWORK, r.address]));
function exactKeys(value: unknown, expected: string[]): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value) && Object.keys(value).sort().join() === [...expected].sort().join();
}
function checked(value: unknown, ownerId: string): EncryptedEvmVault {
  if (!exactKeys(value, ["id", "version", "chain", "network", "keyFormat", "derivationPath", "backupVerified", "ownerId", "address", "name", "kdf", "cipher"])
    || value.version !== 1 || value.chain !== "ethereum" || value.network !== NETWORK || value.keyFormat !== "bip39-mnemonic" || value.derivationPath !== PATH
    || value.backupVerified !== true || value.ownerId !== ownerId || typeof value.address !== "string" || typeof value.name !== "string") throw new VaultError("CORRUPT_VAULT");
  if (value.id !== evmVaultIdentity(ownerId, value.address) || address(value.address) !== value.address) throw new VaultError("CORRUPT_VAULT");
  if (!exactKeys(value.kdf, ["name", "hash", "iterations", "salt"]) || value.kdf.name !== "PBKDF2" || value.kdf.hash !== "SHA-256" || value.kdf.iterations !== 600000
    || !exactKeys(value.cipher, ["name", "iv", "data"]) || value.cipher.name !== "AES-GCM") throw new VaultError("CORRUPT_VAULT");
  decode(value.kdf.salt, 16); decode(value.cipher.iv, 12);
  const ciphertext = decode(value.cipher.data);
  if (ciphertext.length < 16 + 20 || ciphertext.length > 16 + 300) throw new VaultError("CORRUPT_VAULT");
  return value as unknown as EncryptedEvmVault;
}
const metadata = (r: LocalEvmWallet): LocalEvmWallet => ({ ownerId: r.ownerId, address: r.address, name: r.name });
async function key(passphrase: string, salt: Uint8Array) {
  const raw = encoder.encode(passphrase);
  try {
    const material = await crypto.subtle.importKey("raw", buffer(raw), "PBKDF2", false, ["deriveKey"]);
    return await crypto.subtle.deriveKey({ name: "PBKDF2", hash: "SHA-256", iterations: 600000, salt: buffer(salt) }, material, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
  } finally { raw.fill(0); }
}

/** A fresh recovery phrase and the address it controls, for the backup step. */
export function createRecoveryPhrase(wordCount: 12 | 24 = 12): { mnemonic: string; address: `0x${string}` } {
  const mnemonic = createMnemonic(wordCount);
  return { mnemonic, address: deriveEvmAccount(mnemonic).address };
}

export async function listEvmWallets(ownerId: string): Promise<LocalEvmWallet[]> {
  owner(ownerId);
  const records = await store.readAll();
  return records.filter((r) => !!r && typeof r === "object" && "ownerId" in r && (r as { ownerId: unknown }).ownerId === ownerId).map((r) => metadata(checked(r, ownerId)));
}

async function withMnemonic<T>(ownerId: string, wallet: string, passphrase: string, action: (mnemonic: string) => Promise<T> | T): Promise<T> {
  validatePassphrase(passphrase);
  const value = await store.read(evmVaultIdentity(ownerId, wallet));
  if (!value) throw new VaultError("RESTORE_REQUIRED");
  const record = checked(value, ownerId);
  const cryptoKey = await key(passphrase, decode(record.kdf.salt, 16));
  let plain: Uint8Array;
  try { plain = new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv: buffer(decode(record.cipher.iv, 12)), additionalData: buffer(aad(record)), tagLength: 128 }, cryptoKey, buffer(decode(record.cipher.data)))); }
  catch { throw new VaultError("UNLOCK_FAILED"); }
  try {
    const mnemonic = new TextDecoder().decode(plain);
    if (deriveEvmAccount(mnemonic).address !== record.address) throw new VaultError("CORRUPT_VAULT");
    return await action(mnemonic);
  } finally { plain.fill(0); }
}

/**
 * For "Move to Amma" only: the recovery phrase, after the device passphrase unlocks it and it derives the stored address.
 * The caller must use it once and drop it; it is never stored or logged.
 */
export const revealEvmMnemonic = (ownerId: string, wallet: string, passphrase: string) =>
  withMnemonic(ownerId, wallet, passphrase, (mnemonic) => mnemonic);

/** Deletes this device's encrypted copy of one wallet. The wallet is not touched anywhere else. */
export async function removeEvmWallet(ownerId: string, wallet: string): Promise<void> {
  await store.remove(evmVaultIdentity(ownerId, wallet));
}

export const verifyEvmRecovery = (ownerId: string, wallet: string, passphrase: string) =>
  withMnemonic(ownerId, wallet, passphrase, async () => metadata(checked(await store.read(evmVaultIdentity(ownerId, wallet)), ownerId)));

export async function saveEvmWallet(input: { ownerId: string; name: string; mnemonic: string; confirmation: string; passphrase: string; backupAcknowledged: boolean }): Promise<LocalEvmWallet> {
  validatePassphrase(input.passphrase);
  let mnemonic: string;
  try { mnemonic = normalizeMnemonic(input.mnemonic); } catch { throw new VaultError("INVALID_MNEMONIC"); }
  let confirmation = "";
  try { confirmation = normalizeMnemonic(input.confirmation); } catch { /* compared below */ }
  if (!input.backupAcknowledged || mnemonic !== confirmation) throw new VaultError("BACKUP_REQUIRED");
  const name = input.name.trim();
  if (!name || name.length > 64) throw new VaultError("INVALID_NAME");
  const wallet = deriveEvmAccount(mnemonic).address;
  const salt = crypto.getRandomValues(new Uint8Array(16)), iv = crypto.getRandomValues(new Uint8Array(12));
  const record: EncryptedEvmVault = { id: evmVaultIdentity(input.ownerId, wallet), version: 1, chain: "ethereum", network: NETWORK, keyFormat: "bip39-mnemonic",
    derivationPath: PATH, backupVerified: true, ownerId: input.ownerId, address: wallet, name,
    kdf: { name: "PBKDF2", hash: "SHA-256", iterations: 600000, salt: encode(salt) }, cipher: { name: "AES-GCM", iv: encode(iv), data: "" } };
  const cryptoKey = await key(input.passphrase, salt);
  const plain = encoder.encode(mnemonic);
  try { record.cipher.data = encode(new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: buffer(iv), additionalData: buffer(aad(record)), tagLength: 128 }, cryptoKey, buffer(plain)))); }
  finally { plain.fill(0); }
  await store.write(record);
  // A save is only successful once the record reads back, decrypts and derives the same address.
  return verifyEvmRecovery(input.ownerId, wallet, input.passphrase);
}

/** Sign exactly the approved transfer; evm-core re-checks the prepared transaction against the intent first. */
export async function signApprovedEvmTransfer(ownerId: string, passphrase: string, intent: TransferIntent, prepared: PreparedTransfer): Promise<SignedTransfer> {
  const approved = structuredClone(intent), frozen = structuredClone(prepared);
  return withMnemonic(ownerId, approved.from, passphrase, (mnemonic) => signTransfer(deriveEvmAccount(mnemonic), approved, frozen));
}

/** Sign exactly the approved cancel (same nonce, zero value, to self, bumped fees); evm-core re-checks it first. */
export async function signApprovedEvmCancel(ownerId: string, passphrase: string, intent: CancelIntent, prepared: PreparedCancel): Promise<SignedTransfer> {
  const approved = structuredClone(intent), frozen = structuredClone(prepared);
  return withMnemonic(ownerId, approved.from, passphrase, (mnemonic) => signCancel(deriveEvmAccount(mnemonic), approved, frozen));
}
