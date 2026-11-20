// H1-b: stored Stellar keys are filed under the signed-in owner, so a public key alone cannot reach them.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { IDBFactory } from "fake-indexeddb";
import {
  STELLAR_KEYSTORE_DATABASE, deleteStellarSecret, loadAllStellarSecrets, loadStellarSecret,
  migrateLegacyStellarSecrets, saveStellarSecret, setStellarKeystoreOwner,
} from "./stellar-keystore";
import { encryptedRecordStore } from "./xrpl/storage";

const raw = () => encryptedRecordStore(STELLAR_KEYSTORE_DATABASE);

beforeEach(() => {
  vi.stubGlobal("indexedDB", new IDBFactory());
  setStellarKeystoreOwner(null);
});

describe("keystore ids carry the owner", () => {
  it("files a key as ownerId:publicKey", async () => {
    setStellarKeystoreOwner(1);
    await saveStellarSecret("GAAA", "enc-A");
    expect(((await raw().read("1:GAAA")) as { encryptedSecret: string }).encryptedSecret).toBe("enc-A");
    expect(await raw().read("GAAA")).toBeUndefined();
  });

  it("another owner cannot load, list or delete it by public key", async () => {
    setStellarKeystoreOwner(1);
    await saveStellarSecret("GAAA", "enc-A");
    setStellarKeystoreOwner(2);
    expect(await loadStellarSecret("GAAA")).toBeNull();
    expect((await loadAllStellarSecrets()).size).toBe(0);
    await deleteStellarSecret("GAAA");
    setStellarKeystoreOwner(1);
    expect(await loadStellarSecret("GAAA")).toBe("enc-A");
    expect([...(await loadAllStellarSecrets()).keys()]).toEqual(["GAAA"]);
  });
});

describe("migration of records written before owner binding", () => {
  it("copies a claimed public key's record under the owner and keeps the unprefixed one", async () => {
    await saveStellarSecret("GAAA", "enc-A"); // owner null: the old, unprefixed layout
    await saveStellarSecret("GBBB", "enc-B");
    setStellarKeystoreOwner(1);
    await migrateLegacyStellarSecrets(["GAAA"]);
    expect(await loadStellarSecret("GAAA")).toBe("enc-A");
    expect(await raw().read("GAAA")).toBeDefined(); // never deleted: a wrong first claimant cannot strand the real owner
    expect(await raw().read("GBBB")).toBeDefined(); // not claimed: stays unreachable for owners
    expect(await loadStellarSecret("GBBB")).toBeNull();
  });

  it("a second account claiming the same old record still gets its own copy", async () => {
    await saveStellarSecret("GAAA", "enc-A");
    setStellarKeystoreOwner(1);
    await migrateLegacyStellarSecrets(["GAAA"]);
    setStellarKeystoreOwner(2);
    await migrateLegacyStellarSecrets(["GAAA"]);
    expect(await loadStellarSecret("GAAA")).toBe("enc-A");
  });

  it("never overwrites a record the owner already has", async () => {
    setStellarKeystoreOwner(1);
    await saveStellarSecret("GAAA", "new");
    setStellarKeystoreOwner(null);
    await saveStellarSecret("GAAA", "old");
    setStellarKeystoreOwner(1);
    await migrateLegacyStellarSecrets(["GAAA"]);
    expect(await loadStellarSecret("GAAA")).toBe("new");
  });
});
