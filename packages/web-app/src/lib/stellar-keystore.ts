import { encryptedRecordStore } from "./xrpl/storage";

/**
 * Self-custody Stellar keys, encrypted in the browser with the person's
 * passphrase, kept in IndexedDB like the XRP and Ethereum vaults. localStorage
 * never holds them (P0-3-F9) and GET /wallets never returns them (P0-3-F1),
 * so without this a page reload left the wallet unable to unlock.
 */
export const STELLAR_KEYSTORE_DATABASE = "amma-stellar-keystore-v1";
const store = encryptedRecordStore(STELLAR_KEYSTORE_DATABASE);

/**
 * Records are filed as `ownerId:publicKey` so a public key alone cannot reach another user's key (H1).
 * With no owner yet (before the first claim) the old unprefixed layout is used.
 */
let owner: number | null = null;
export function setStellarKeystoreOwner(id: number | null): void { owner = id; }
const idOf = (publicKey: string) => (owner == null ? publicKey : `${owner}:${publicKey}`);

type Record = { id: string; encryptedSecret: string };
const isRecord = (r: unknown): r is Record =>
  !!r && typeof (r as Record).id === "string" && typeof (r as Record).encryptedSecret === "string" && (r as Record).encryptedSecret.length > 0;

export async function saveStellarSecret(publicKey: string, encryptedSecret: string): Promise<void> {
  await store.write({ id: idOf(publicKey), encryptedSecret } as Record);
}

export async function loadStellarSecret(publicKey: string): Promise<string | null> {
  try {
    const record = await store.read(idOf(publicKey));
    return isRecord(record) && record.id === idOf(publicKey) ? record.encryptedSecret : null;
  } catch {
    return null;
  }
}

export async function loadAllStellarSecrets(): Promise<Map<string, string>> {
  try {
    const records = await store.readAll();
    const prefix = owner == null ? "" : `${owner}:`;
    return new Map(records.filter(isRecord)
      .filter((r) => (owner == null ? !r.id.includes(":") : r.id.startsWith(prefix)))
      .map((r) => [r.id.slice(prefix.length), r.encryptedSecret]));
  } catch {
    return new Map();
  }
}

export async function deleteStellarSecret(publicKey: string): Promise<void> {
  await store.remove(idOf(publicKey));
}

/** Move records written before owner binding (unprefixed) under the current owner, for these claimed public keys only. */
export async function migrateLegacyStellarSecrets(publicKeys: string[]): Promise<void> {
  if (owner == null) return;
  for (const publicKey of publicKeys) {
    try {
      const legacy = await store.read(publicKey);
      if (!isRecord(legacy) || legacy.id !== publicKey) continue;
      if (isRecord(await store.read(idOf(publicKey)))) continue;
      // Copy, never move: if another account claims this public key first, the real owner must still find the old record.
      await store.write({ id: idOf(publicKey), encryptedSecret: legacy.encryptedSecret } as Record);
      const copy = await store.read(idOf(publicKey));
      if (!isRecord(copy) || copy.encryptedSecret !== legacy.encryptedSecret) throw new Error("keystore copy did not read back");
    } catch { /* the old record stays where it is */ }
  }
}
