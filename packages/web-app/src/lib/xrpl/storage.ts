export class VaultError extends Error {
  constructor(code: string) { super(code); this.name = "VaultError"; }
}

export const VAULT_DATABASE = "amma-xrpl-vault-v1";
export const VAULT_STORE = "wallets";

/** An IndexedDB object store of encrypted records keyed by `id`. One database per chain family. */
export function encryptedRecordStore(databaseName: string) {
  async function openDatabase(): Promise<IDBDatabase> {
    if (typeof indexedDB === "undefined") throw new VaultError("STORAGE_UNAVAILABLE");
    return new Promise<IDBDatabase>((resolve, reject) => {
      let failed = false;
      const request = indexedDB.open(databaseName, 1);
      request.onupgradeneeded = () => {
        if (!request.result.objectStoreNames.contains(VAULT_STORE)) request.result.createObjectStore(VAULT_STORE, { keyPath: "id" });
      };
      const fail = () => { failed = true; reject(new VaultError("STORAGE_UNAVAILABLE")); };
      request.onerror = fail; request.onblocked = fail;
      request.onsuccess = () => {
        if (failed) { request.result.close(); return; }
        request.result.onversionchange = () => request.result.close();
        resolve(request.result);
      };
    }).catch(() => { throw new VaultError("STORAGE_UNAVAILABLE"); });
  }

  async function operation<T>(mode: IDBTransactionMode, callback: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
    const database = await openDatabase();
    try {
      return await new Promise<T>((resolve, reject) => {
        const transaction = database.transaction(VAULT_STORE, mode);
        const request = callback(transaction.objectStore(VAULT_STORE));
        // A request succeeding is not enough: quota/transaction abort may follow.
        transaction.oncomplete = () => resolve(request.result);
        transaction.onabort = transaction.onerror = () => reject(new VaultError("STORAGE_UNAVAILABLE"));
      });
    } catch { throw new VaultError("STORAGE_UNAVAILABLE"); }
    finally { database.close(); }
  }

  return {
    read: (id: string) => operation<unknown>("readonly", (store) => store.get(id)),
    readAll: () => operation<unknown[]>("readonly", (store) => store.getAll()),
    async write(record: { id: string }): Promise<void> { await operation("readwrite", (store) => store.put(record)); },
    async remove(id: string): Promise<void> { await operation("readwrite", (store) => store.delete(id)); },
  };
}

const xrplStore = encryptedRecordStore(VAULT_DATABASE);
export const readEncryptedRecord = xrplStore.read;
export const readEncryptedRecords = xrplStore.readAll;
export const writeEncryptedRecord = xrplStore.write;
export const removeEncryptedRecord = xrplStore.remove;
