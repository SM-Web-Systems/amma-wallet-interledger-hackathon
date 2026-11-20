import { describe, expect, it } from "vitest";
import { parseTransaction } from "viem";
import { cancelIntentFor, deriveEvmAccount, prepareNativeTransfer, signApprovedTransfer, prepareCancel, signApprovedCancel, type CancelIntent, type EvmError, type PreparedCancel } from "../src";

const TEST_MNEMONIC = "test test test test test test test test test test test junk";
const ACCOUNT0 = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";
const GWEI = 1_000_000_000n, ETH = 10n ** 18n;
const code = (fn: () => unknown) => { try { fn(); } catch (e) { return (e as EvmError).code; } return "no error"; };
const acode = async (p: Promise<unknown>) => p.then(() => "no error", (e) => (e as EvmError).code);

const intent: CancelIntent = { networkId: "ethereum-sepolia", from: ACCOUNT0, nonce: 7, original: { maxFeePerGasWei: (30n * GWEI).toString(), maxPriorityFeePerGasWei: (2n * GWEI).toString() } };
const quiet = { balanceWei: ETH, baseFeeWei: 1n * GWEI, priorityFeeWei: 1n * GWEI, minedNonce: 7 };

describe("cancel a stuck transfer", () => {
  it("replaces the same nonce with a zero-value self transfer and at least a 10% fee bump", async () => {
    const prepared = prepareCancel(intent, quiet);
    expect(prepared).toMatchObject({ kind: "cancel", from: ACCOUNT0, to: ACCOUNT0, valueWei: "0", nonce: 7, gasLimit: "21000" });
    expect(BigInt(prepared.maxFeePerGasWei)).toBe(33n * GWEI + 1n);
    expect(BigInt(prepared.maxPriorityFeePerGasWei)).toBe(2n * GWEI + 2n * GWEI / 10n + 1n);
    const signed = await signApprovedCancel(deriveEvmAccount(TEST_MNEMONIC), intent, prepared);
    const tx = parseTransaction(signed.rawTransaction);
    expect(tx.nonce).toBe(7);
    expect(tx.value ?? 0n).toBe(0n);
    expect(tx.to?.toLowerCase()).toBe(ACCOUNT0.toLowerCase());
    expect(tx.data).toBeUndefined();
  });

  it("pays the market rate when it is above the bump", () => {
    const prepared = prepareCancel(intent, { ...quiet, baseFeeWei: 40n * GWEI, priorityFeeWei: 5n * GWEI });
    expect(BigInt(prepared.maxFeePerGasWei)).toBe(85n * GWEI);
    expect(BigInt(prepared.maxPriorityFeePerGasWei)).toBe(5n * GWEI);
  });

  it("refuses when the nonce is already used, fees exceed the cap, or the fee is unaffordable", () => {
    expect(code(() => prepareCancel(intent, { ...quiet, minedNonce: 8 }))).toBe("EVM_CANCEL_TOO_LATE");
    expect(code(() => prepareCancel({ ...intent, original: { maxFeePerGasWei: (950n * GWEI).toString(), maxPriorityFeePerGasWei: "0" } }, quiet))).toBe("EVM_FEE_ABOVE_CAP");
    expect(code(() => prepareCancel(intent, { ...quiet, balanceWei: 1000n }))).toBe("EVM_INSUFFICIENT_FUNDS");
    expect(code(() => prepareCancel({ ...intent, original: { maxFeePerGasWei: "1", maxPriorityFeePerGasWei: "2" } }, quiet))).toBe("EVM_CANCEL_INVALID");
    expect(code(() => prepareCancel({ ...intent, original: { maxFeePerGasWei: "0x10", maxPriorityFeePerGasWei: "1" } }, quiet))).toBe("EVM_CANCEL_INVALID");
  });

  it("will not sign a tampered cancel", async () => {
    const account = deriveEvmAccount(TEST_MNEMONIC);
    const prepared = prepareCancel(intent, quiet);
    const tamper = async (change: Partial<Record<keyof PreparedCancel, unknown>>) => acode(signApprovedCancel(account, intent, { ...prepared, ...change } as PreparedCancel));
    expect(await tamper({ to: "0x70997970C51812dc3A010C7d01b50e0d17dc79C8" })).toBe("EVM_SIGN_RECIPIENT_MISMATCH");
    expect(await tamper({ valueWei: "1" })).toBe("EVM_SIGN_AMOUNT_MISMATCH");
    expect(await tamper({ nonce: 8 })).toBe("EVM_SIGN_NONCE_MISMATCH");
    expect(await tamper({ chainId: 1 })).toBe("EVM_SIGN_NETWORK_MISMATCH");
    expect(await tamper({ maxFeePerGasWei: (30n * GWEI).toString(), maxNetworkFeeWei: (21000n * 30n * GWEI).toString() })).toBe("EVM_CANCEL_FEE_TOO_LOW");
    expect(await tamper({ maxFeePerGasWei: (2000n * GWEI).toString() })).toBe("EVM_SIGN_FEE_ABOVE_CAP");
    expect(await tamper({ maxNetworkFeeWei: "1" })).toBe("EVM_SIGN_TOTAL_MISMATCH");
    expect(await tamper({ gasLimit: "50000" })).toBe("EVM_SIGN_GAS_UNEXPECTED");
    expect(await acode(signApprovedCancel(deriveEvmAccount(TEST_MNEMONIC, 1), intent, prepared))).toBe("EVM_SIGN_WRONG_KEY");
  });

  it("derives the cancel intent from the wallet's own signed bytes", async () => {
    const account = deriveEvmAccount(TEST_MNEMONIC);
    const transfer = { networkId: "ethereum-sepolia" as const, from: ACCOUNT0, to: "0x70997970C51812dc3A010C7d01b50e0d17dc79C8", amount: "0.01" };
    const prepared = prepareNativeTransfer(transfer, { nonce: 7, balanceWei: ETH, baseFeeWei: 14n * GWEI, priorityFeeWei: 2n * GWEI, gasEstimate: 21_000n });
    const signed = await signApprovedTransfer(account, transfer, prepared);
    expect(await cancelIntentFor("ethereum-sepolia", ACCOUNT0, 7, signed.rawTransaction)).toEqual(intent);
    expect(await acode(cancelIntentFor("ethereum-sepolia", ACCOUNT0, 8, signed.rawTransaction))).toBe("EVM_CANCEL_INVALID");
    expect(await acode(cancelIntentFor("ethereum-sepolia", "0x70997970C51812dc3A010C7d01b50e0d17dc79C8", 7, signed.rawTransaction))).toBe("EVM_CANCEL_INVALID");
    expect(await acode(cancelIntentFor("ethereum-sepolia", ACCOUNT0, 7, "0x02ff"))).toBe("EVM_CANCEL_INVALID");
  });
});
