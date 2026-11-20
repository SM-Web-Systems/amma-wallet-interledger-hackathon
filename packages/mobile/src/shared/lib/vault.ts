/**
 * Mobile key vault (audit D8 / F-16).
 *
 * A random 256-bit vault key encrypts every wallet secret and recovery phrase with
 * AES-256-GCM before it goes into SecureStore. The vault key itself is stored only
 * wrapped (AES-GCM) under a key derived from the user's passphrase with
 * PBKDF2-SHA256. Changing the passphrase or adding biometric unlock re-wraps the
 * vault key; the sealed secrets do not change.
 *
 * AES-GCM is pure JS (@noble) because Hermes has no WebCrypto; PBKDF2 runs natively when available (see ./pbkdf2). Nothing here logs or returns
 * plaintext except openSecret / unwrapVaultKey to their caller.
 */
import { gcm } from "@noble/ciphers/aes";
import { randomBytes } from "@noble/ciphers/webcrypto";
import { pbkdf2Sha256 } from "./pbkdf2";
import { utf8ToBytes, bytesToUtf8 } from "@noble/ciphers/utils";

export const VAULT_ITERATIONS = 150_000;
const SEALED_PREFIX = "v1:";

export interface KdfOptions {
  iterations?: number;
}

interface WrappedKey {
  v: 1;
  kdf: "pbkdf2-sha256";
  iterations: number;
  salt: string;
  iv: string;
  ct: string;
}

function b64(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

function unb64(text: string): Uint8Array {
  const s = atob(text);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

export function createVaultKey(): Uint8Array {
  return randomBytes(32);
}

async function kek(passphrase: string, salt: Uint8Array, iterations: number): Promise<Uint8Array> {
  return pbkdf2Sha256(utf8ToBytes(passphrase.normalize("NFKC")), salt, iterations);
}

/** Wraps the vault key under the passphrase. The result is safe to store. */
export async function wrapVaultKey(vaultKey: Uint8Array, passphrase: string, opts: KdfOptions = {}): Promise<string> {
  const iterations = opts.iterations ?? VAULT_ITERATIONS;
  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const ct = gcm(await kek(passphrase, salt, iterations), iv).encrypt(vaultKey);
  const wrapped: WrappedKey = { v: 1, kdf: "pbkdf2-sha256", iterations, salt: b64(salt), iv: b64(iv), ct: b64(ct) };
  return JSON.stringify(wrapped);
}

/** Returns the vault key, or throws "Wrong passphrase" when the passphrase does not open it. */
export async function unwrapVaultKey(wrapped: string, passphrase: string): Promise<Uint8Array> {
  const w = JSON.parse(wrapped) as WrappedKey;
  if (w.v !== 1 || w.kdf !== "pbkdf2-sha256") throw new Error("Unsupported vault format");
  const key = await kek(passphrase, unb64(w.salt), w.iterations);
  try {
    return gcm(key, unb64(w.iv)).decrypt(unb64(w.ct));
  } catch {
    throw new Error("Wrong passphrase");
  }
}

/** True for a value written by sealSecret (as opposed to an older plaintext entry). */
export function isSealed(value: string | null | undefined): boolean {
  return typeof value === "string" && value.startsWith(SEALED_PREFIX);
}

export function sealSecret(vaultKey: Uint8Array, plaintext: string): string {
  const iv = randomBytes(12);
  const ct = gcm(vaultKey, iv).encrypt(utf8ToBytes(plaintext));
  const both = new Uint8Array(iv.length + ct.length);
  both.set(iv);
  both.set(ct, iv.length);
  return SEALED_PREFIX + b64(both);
}

export function openSecret(vaultKey: Uint8Array, sealed: string): string {
  if (!isSealed(sealed)) throw new Error("Not a sealed secret");
  const both = unb64(sealed.slice(SEALED_PREFIX.length));
  return bytesToUtf8(gcm(vaultKey, both.slice(0, 12)).decrypt(both.slice(12)));
}

export const vaultEncoding = { b64, unb64 };
