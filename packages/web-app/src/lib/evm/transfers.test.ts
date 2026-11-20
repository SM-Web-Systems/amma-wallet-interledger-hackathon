// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";
import { IDBFactory } from "fake-indexeddb";
import { EVM_TRANSFER_DATABASE, listTransfers, mayRebroadcast, nonceForNewTransfer, recordCancel, recordSigned, updateState } from "./transfers";
import { encryptedRecordStore } from "../xrpl/storage";

const FROM = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266" as const;
const TO = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8" as const;
const hash = (n: number) => `0x${n.toString(16).padStart(64, "0")}` as `0x${string}`;
const signed = (nonce: number, ownerId = "1") => ({ ownerId, from: FROM, to: TO, nonce, hash: hash(nonce + 1), raw: "0x02f86b" as `0x${string}`, amount: "0.01", symbol: "SepoliaETH" });
const code = (p: Promise<unknown>) => p.then(() => "no error", (e) => (e as { code?: string; message: string }).code ?? (e as Error).message);
const raw = () => encryptedRecordStore(EVM_TRANSFER_DATABASE);

beforeEach(() => { vi.stubGlobal("indexedDB", new IDBFactory()); });

describe("Sepolia transfer persistence", () => {
  it("keeps signed bytes across reloads and blocks a second transfer until the first is final", async () => {
    const first = await recordSigned(signed(4), 1000);
    expect(first.state).toBe("signed");
    expect(await listTransfers("1", FROM)).toEqual([first]);
    // An uncertain outcome must never allow signing another payment.
    for (const state of ["signed", "broadcast", "pending", "included", "unknown"] as const) {
      await updateState(first, state);
      expect(await code(nonceForNewTransfer("1", FROM, 5))).toBe("EVM_EARLIER_TRANSFER_UNRESOLVED");
      expect(await code(recordSigned(signed(5)))).toBe("EVM_EARLIER_TRANSFER_UNRESOLVED");
    }
    await updateState(first, "confirmed");
    expect(await nonceForNewTransfer("1", FROM, 5)).toBe(5);
    expect((await recordSigned(signed(5))).nonce).toBe(5);
    expect((await listTransfers("1", FROM)).map((t) => t.nonce)).toEqual([5, 4]);
  });

  it("never leaves a final state and honours onlyFrom", async () => {
    const record = await recordSigned(signed(0));
    await updateState(record, "pending");
    expect((await updateState(record, "broadcast", { onlyFrom: ["signed"] })).state).toBe("pending");
    expect((await updateState(record, "broadcast")).state).toBe("broadcast");
    await updateState(record, "replaced");
    expect((await updateState(record, "pending")).state).toBe("replaced");
  });

  it("keeps owners apart", async () => {
    await recordSigned(signed(0, "1"));
    expect(await listTransfers("2", FROM)).toEqual([]);
    expect(await nonceForNewTransfer("2", FROM, 0)).toBe(0);
    expect(await code(listTransfers("0", FROM))).toBe("INVALID_OWNER");
  });

  it("refuses tampered or malformed records instead of guessing", async () => {
    const record = await recordSigned(signed(0));
    await raw().write({ ...record, nonce: 9 });
    expect(await code(listTransfers("1", FROM))).toBe("CORRUPT_TRANSFER");
    await raw().write({ ...record, from: FROM.toLowerCase() });
    expect(await code(listTransfers("1", FROM))).toBe("CORRUPT_TRANSFER");
    await raw().write({ ...record, state: "done" });
    expect(await code(listTransfers("1", FROM))).toBe("CORRUPT_TRANSFER");
    await raw().write({ ...record, extra: true });
    expect(await code(listTransfers("1", FROM))).toBe("CORRUPT_TRANSFER");
  });

  it("records one cancel per open transfer and stops rebroadcasting the original", async () => {
    const original = await recordSigned(signed(3));
    expect(mayRebroadcast(original, await listTransfers("1", FROM))).toBe(true);
    const cancel = await recordCancel(original, { hash: hash(99), raw: "0x02f86c", symbol: "SepoliaETH" });
    expect(cancel).toMatchObject({ kind: "cancel", nonce: 3, to: FROM, amount: "0", state: "signed" });
    const all = await listTransfers("1", FROM);
    expect(all).toHaveLength(2);
    expect(mayRebroadcast(original, all)).toBe(false);
    expect(mayRebroadcast(cancel, all)).toBe(true);
    expect(await code(recordCancel(original, { hash: hash(100), raw: "0x02f86d", symbol: "SepoliaETH" }))).toBe("EVM_CANCEL_ALREADY_SENT");
    expect(await code(recordCancel(cancel, { hash: hash(101), raw: "0x02f86e", symbol: "SepoliaETH" }))).toBe("EVM_CANCEL_NOT_APPLICABLE");
    // Both stay open (blocking new transfers) until the nonce resolves one way or the other.
    expect(await code(nonceForNewTransfer("1", FROM, 4))).toBe("EVM_EARLIER_TRANSFER_UNRESOLVED");
    await updateState(original, "replaced"); await updateState(cancel, "confirmed");
    expect(await nonceForNewTransfer("1", FROM, 4)).toBe(4);
    expect(await code(recordCancel(original, { hash: hash(102), raw: "0x02f86f", symbol: "SepoliaETH" }))).toBe("EVM_CANCEL_NOT_APPLICABLE");
  });

  it("rejects a cancel record that pays someone else", async () => {
    const cancel = await recordCancel(await recordSigned(signed(0)), { hash: hash(50), raw: "0x02f8", symbol: "SepoliaETH" });
    await raw().write({ ...cancel, to: TO });
    expect(await code(listTransfers("1", FROM))).toBe("CORRUPT_TRANSFER");
  });
});
