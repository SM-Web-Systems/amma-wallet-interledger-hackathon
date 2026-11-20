/**
 * Device side of the mobile vault (audit D8): where the wrapped vault key, the
 * sealed secrets, the biometric copy and the wrong-guess counter live.
 * Crypto is in ./vault; this file only moves sealed bytes in and out of storage.
 */
import * as SecureStore from "expo-secure-store";
import AsyncStorage from "@react-native-async-storage/async-storage";
import * as LocalAuthentication from "expo-local-authentication";
import { openSecret, sealSecret, unwrapVaultKey, wrapVaultKey, vaultEncoding, isSealed } from "./vault";

const WRAPPED_KEY_ITEM = "vault_key_wrapped";
const BIO_KEY_ITEM = "vault_key_biometric";
const ATTEMPTS_ITEM = "amma-unlock-attempts";

/** Tests lower the KDF cost; the app always uses the default from ./vault. */
export const vaultConfig: { iterations?: number } = {};

export async function hasVault(): Promise<boolean> {
  return (await SecureStore.getItemAsync(WRAPPED_KEY_ITEM)) !== null;
}

export async function deleteVault(): Promise<void> {
  await SecureStore.deleteItemAsync(WRAPPED_KEY_ITEM);
}

export async function deleteSecretItem(item: string): Promise<void> {
  await SecureStore.deleteItemAsync(item);
}

export async function saveWrappedKey(vaultKey: Uint8Array, passphrase: string): Promise<void> {
  await SecureStore.setItemAsync(WRAPPED_KEY_ITEM, await wrapVaultKey(vaultKey, passphrase, { iterations: vaultConfig.iterations }));
}

export async function openVaultKey(passphrase: string): Promise<Uint8Array> {
  const wrapped = await SecureStore.getItemAsync(WRAPPED_KEY_ITEM);
  if (!wrapped) throw new Error("This device has no wallet passphrase yet.");
  return unwrapVaultKey(wrapped, passphrase);
}

/** Seals and stores a secret, then reads it back to prove it opens before the caller drops the plaintext. */
export async function storeSecret(vaultKey: Uint8Array, item: string, plaintext: string): Promise<void> {
  await SecureStore.setItemAsync(item, sealSecret(vaultKey, plaintext));
  const check = await SecureStore.getItemAsync(item);
  if (!check || openSecret(vaultKey, check) !== plaintext) {
    throw new Error("Could not save the key securely on this device.");
  }
}

export async function readSecret(vaultKey: Uint8Array, item: string): Promise<string | null> {
  const value = await SecureStore.getItemAsync(item);
  if (value === null) return null;
  return isSealed(value) ? openSecret(vaultKey, value) : value;
}

export async function hasPlainSecret(item: string): Promise<boolean> {
  const value = await SecureStore.getItemAsync(item);
  return value !== null && !isSealed(value);
}

/** Replaces a plain-text entry from an older install with a sealed one. No-op if missing or already sealed. */
export async function sealInPlace(vaultKey: Uint8Array, item: string): Promise<void> {
  const value = await SecureStore.getItemAsync(item);
  if (value === null || isSealed(value)) return;
  try {
    await storeSecret(vaultKey, item, value);
  } catch (err) {
    await SecureStore.setItemAsync(item, value); // never lose the only copy
    throw err;
  }
}

// ── Biometric quick unlock ────────────────────────────────────────────

/**
 * True only for a STRONG biometric (a fingerprint, or secure 3D face). A weak one, such as 2D camera face
 * unlock, passes "has hardware and is enrolled" but Android will not let it open a protected key, so quick
 * unlock would be offered and then never work.
 */
export async function biometricsAvailable(): Promise<boolean> {
  if (!(await LocalAuthentication.hasHardwareAsync()) || !(await LocalAuthentication.isEnrolledAsync())) return false;
  return (await LocalAuthentication.getEnrolledLevelAsync()) === LocalAuthentication.SecurityLevel.BIOMETRIC_STRONG;
}

export async function saveBiometricKey(vaultKey: Uint8Array): Promise<void> {
  await SecureStore.setItemAsync(BIO_KEY_ITEM, vaultEncoding.b64(vaultKey), {
    requireAuthentication: true,
    authenticationPrompt: "Unlock Amma Wallet",
  });
}

/** The biometric copy of the vault key. "cancelled" leaves it alone; "invalid" means the OS dropped it. */
export async function readBiometricKey(): Promise<{ key: Uint8Array } | { key: null; reason: "cancelled" | "invalid" }> {
  try {
    const value = await SecureStore.getItemAsync(BIO_KEY_ITEM, {
      requireAuthentication: true,
      authenticationPrompt: "Unlock Amma Wallet",
    });
    return value ? { key: vaultEncoding.unb64(value) } : { key: null, reason: "invalid" };
  } catch (err) {
    // Cancelled by the user, or invalidated by the OS (new fingerprint or face, passcode removed).
    return { key: null, reason: /cancel/i.test(String((err as Error)?.message)) ? "cancelled" : "invalid" };
  }
}

export async function deleteBiometricKey(): Promise<void> {
  await SecureStore.deleteItemAsync(BIO_KEY_ITEM);
  await AsyncStorage.removeItem("amma-biometric-unlock");
}

export async function biometricEnabled(): Promise<boolean> {
  return (await AsyncStorage.getItem("amma-biometric-unlock")) === "on";
}

export async function setBiometricFlag(on: boolean): Promise<void> {
  if (on) await AsyncStorage.setItem("amma-biometric-unlock", "on");
  else await AsyncStorage.removeItem("amma-biometric-unlock");
}

// ── Wrong-guess delays ────────────────────────────────────────────────

export const attemptPolicy = {
  /** No delay for the first 4 mistakes, then 30 s, 1 min, 5 min, 15 min, and 1 h from the 9th on. */
  delayAfter(failures: number): number {
    if (failures < 5) return 0;
    const steps = [30_000, 60_000, 300_000, 900_000];
    return steps[failures - 5] ?? 3_600_000;
  },
};

interface Attempts {
  failures: number;
  lockedUntil: number;
}

async function readAttempts(): Promise<Attempts> {
  try {
    const raw = await AsyncStorage.getItem(ATTEMPTS_ITEM);
    if (raw) return { failures: 0, lockedUntil: 0, ...JSON.parse(raw) };
  } catch {}
  return { failures: 0, lockedUntil: 0 };
}

/** Milliseconds until another try is allowed (0 when allowed now). */
export async function unlockWait(): Promise<number> {
  return Math.max(0, (await readAttempts()).lockedUntil - Date.now());
}

export async function recordFailedUnlock(): Promise<void> {
  const a = await readAttempts();
  const failures = a.failures + 1;
  await AsyncStorage.setItem(ATTEMPTS_ITEM, JSON.stringify({ failures, lockedUntil: Date.now() + attemptPolicy.delayAfter(failures) }));
}

export async function recordGoodUnlock(): Promise<void> {
  await AsyncStorage.setItem(ATTEMPTS_ITEM, JSON.stringify({ failures: 0, lockedUntil: 0 }));
}

export function waitMessage(ms: number): string {
  const s = Math.ceil(ms / 1000);
  return s < 120 ? `Too many wrong tries. Try again in ${s} seconds.` : `Too many wrong tries. Try again in ${Math.ceil(s / 60)} minutes.`;
}
