// @vitest-environment node
// Crypto/IndexedDB library test: jsdom's realm breaks Uint8Array identity checks in @noble.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { IDBFactory } from "fake-indexeddb";
import { webcrypto } from "node:crypto";
import { parseTransaction } from "viem";
import { cancelIntentFor, prepareCancel, prepareNativeTransfer } from "@amma-wallet/evm-core";
import { createRecoveryPhrase, evmVaultIdentity, listEvmWallets, saveEvmWallet, signApprovedEvmCancel, signApprovedEvmTransfer, verifyEvmRecovery, EVM_VAULT_DATABASE } from "./vault";
import { encryptedRecordStore } from "../xrpl/storage";

const passphrase = "test vault phrase with spaces";
const TEST_MNEMONIC = "test test test test test test test test test test test junk";
const ACCOUNT0 = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";
const raw = () => encryptedRecordStore(EVM_VAULT_DATABASE);
beforeEach(() => { vi.stubGlobal("indexedDB", new IDBFactory()); vi.stubGlobal("crypto", webcrypto); });
const input = (mnemonic = TEST_MNEMONIC) => ({ ownerId: "1", name: "Sepolia", mnemonic, confirmation: mnemonic, passphrase, backupAcknowledged: true });
const code = (p: Promise<unknown>) => p.then(() => "no error", (e) => (e as Error).message);

describe("Ethereum Sepolia browser vault", { timeout: 30000 }, () => {
  it("round-trips without persisting the mnemonic or passphrase", async () => {
    const saved = await saveEvmWallet(input());
    expect(saved).toEqual({ ownerId: "1", address: ACCOUNT0, name: "Sepolia" });
    expect(await listEvmWallets("1")).toEqual([saved]);
    expect(await listEvmWallets("2")).toEqual([]);
    const stored = JSON.stringify(await raw().read(evmVaultIdentity("1", ACCOUNT0)));
    expect(stored).not.toContain("junk"); expect(stored).not.toContain(passphrase);
    expect(stored).toContain('"iterations":600000');
  });
  it("creates a fresh phrase whose address matches what gets saved", async () => {
    const fresh = createRecoveryPhrase();
    expect((await saveEvmWallet(input(fresh.mnemonic))).address).toBe(fresh.address);
  });
  it("requires an acknowledged, matching backup and a strong passphrase", async () => {
    expect(await code(saveEvmWallet({ ...input(), backupAcknowledged: false }))).toBe("BACKUP_REQUIRED");
    expect(await code(saveEvmWallet({ ...input(), confirmation: TEST_MNEMONIC.replace("junk", "test") }))).toBe("BACKUP_REQUIRED");
    expect(await code(saveEvmWallet({ ...input(), passphrase: "123456789012" }))).toBe("WEAK_PASSPHRASE");
    expect(await code(saveEvmWallet(input("not a real phrase")))).toBe("INVALID_MNEMONIC");
  });
  it("fails a wrong passphrase and leaves the ciphertext intact", async () => {
    await saveEvmWallet(input());
    const before = JSON.stringify(await raw().read(evmVaultIdentity("1", ACCOUNT0)));
    expect(await code(verifyEvmRecovery("1", ACCOUNT0, "wrong passphrase here"))).toBe("UNLOCK_FAILED");
    expect(JSON.stringify(await raw().read(evmVaultIdentity("1", ACCOUNT0)))).toBe(before);
  });
  it("rejects records moved to another owner or with altered KDF parameters", async () => {
    await saveEvmWallet(input());
    const record = (await raw().read(evmVaultIdentity("1", ACCOUNT0))) as { id: string; kdf: Record<string, unknown> } & Record<string, unknown>;
    await raw().write({ ...record, id: evmVaultIdentity("2", ACCOUNT0), ownerId: "2" });
    expect(await code(verifyEvmRecovery("2", ACCOUNT0, passphrase))).toBe("UNLOCK_FAILED"); // AAD binds the owner
    await raw().write({ ...record, kdf: { ...record.kdf, iterations: 1 } });
    expect(await code(verifyEvmRecovery("1", ACCOUNT0, passphrase))).toBe("CORRUPT_VAULT");
  });
  it("signs only the approved Sepolia transfer", async () => {
    await saveEvmWallet(input());
    const intent = { networkId: "ethereum-sepolia" as const, from: ACCOUNT0, to: "0x70997970C51812dc3A010C7d01b50e0d17dc79C8", amount: "0.01" };
    const prepared = prepareNativeTransfer(intent, { nonce: 0, balanceWei: 10n ** 18n, baseFeeWei: 10n ** 9n, priorityFeeWei: 10n ** 8n, gasEstimate: 21_000n });
    const signed = await signApprovedEvmTransfer("1", passphrase, intent, prepared);
    expect(parseTransaction(signed.rawTransaction)).toMatchObject({ chainId: 11155111, value: 10n ** 16n, nonce: 0 });
    expect(await code(signApprovedEvmTransfer("1", passphrase, { ...intent, amount: "0.02" }, prepared))).toBe("evm sign amount mismatch");
  });

  it("signs a cancel for the same nonce only with the vault passphrase", async () => {
    await saveEvmWallet(input());
    const transfer = { networkId: "ethereum-sepolia" as const, from: ACCOUNT0, to: "0x70997970C51812dc3A010C7d01b50e0d17dc79C8", amount: "0.01" };
    const original = await signApprovedEvmTransfer("1", passphrase, transfer, prepareNativeTransfer(transfer, { nonce: 4, balanceWei: 10n ** 18n, baseFeeWei: 10n ** 9n, priorityFeeWei: 10n ** 8n, gasEstimate: 21_000n }));
    const intent = await cancelIntentFor("ethereum-sepolia", ACCOUNT0, 4, original.rawTransaction);
    const prepared = prepareCancel(intent, { balanceWei: 10n ** 18n, baseFeeWei: 10n ** 9n, priorityFeeWei: 10n ** 8n, minedNonce: 4 });
    const cancel = parseTransaction((await signApprovedEvmCancel("1", passphrase, intent, prepared)).rawTransaction);
    expect(cancel).toMatchObject({ chainId: 11155111, nonce: 4, to: ACCOUNT0.toLowerCase() });
    expect(cancel.value ?? 0n).toBe(0n);
    expect(await code(signApprovedEvmCancel("1", "wrong passphrase here", intent, prepared))).toBe("UNLOCK_FAILED");
  });
});
