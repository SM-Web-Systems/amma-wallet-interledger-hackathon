import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { Wallet, decode, ECDSA, type Payment } from "xrpl";
import { buildPreparation, parseIntent, requestDigest, validateSigned, verifySettlement, type IntentInput } from "./payment";
import type { AccountSnapshot, FeeSnapshot, TransactionObservation } from "./read-adapter";

const sourceWallet = Wallet.generate(ECDSA.ed25519), destinationWallet = Wallet.generate(ECDSA.secp256k1);
const ledger = () => ({ chain: "xrpl" as const, network: "testnet" as const, endpoint: "wss://testnet.xrpl-labs.com/", validatedLedgerIndex: 1234, validatedLedgerHash: "A".repeat(64), observedAt: new Date().toISOString() });
const source = (): AccountSnapshot => ({ ...ledger(), address: sourceWallet.classicAddress, funded: true, balanceDrops: "20000000", reserveDrops: "1000000", spendableDrops: "19000000", sequence: 12, ownerCount: 0, requiresDestinationTag: false });
const destination = (): AccountSnapshot => ({ ...source(), address: destinationWallet.classicAddress });
const fee = (): FeeSnapshot => ({ ...ledger(), feeDrops: "12", currentLedgerIndex: 1235 });
const input = (): IntentInput => ({ schemaVersion: 1, walletId: "1", chain: "xrpl", network: "testnet", destination: destinationWallet.classicAddress, destinationTag: 0, amountDrops: "1000000", maxFeeDrops: "100", reference: randomUUID() });

describe("approved direct XRP payment policy", () => {
  it("keeps exact canonical amounts, tag zero and stable validated request hashes", () => {
    const request = input(); expect(parseIntent(request)).toEqual(request);
    const reordered = Object.fromEntries(Object.entries(request).reverse());
    expect(requestDigest(parseIntent(reordered))).toBe(requestDigest(parseIntent(request)));
    expect(parseIntent({ ...request, amountDrops: "9007199254740993" }).amountDrops).toBe("9007199254740993");
  });
  it.each(["01", "0", "1.0", "1e6", "-1", "100000000000000001", 1000000, null])("rejects invalid amount %s", amountDrops => {
    expect(() => parseIntent({ ...input(), amountDrops })).toThrow();
  });
  it.each([{ destinationTag: "0" }, { destinationTag: null }, { destinationTag: -1 }, { destinationTag: 4294967296 }, { chain: "stellar" }, { network: "mainnet" }, { approved: true }, { seed: "prohibited" }, { maxFeeDrops: "1001" }, { walletId: 1 }, { schemaVersion: "1" }])("rejects invalid/extra request fields %j", change => {
    expect(() => parseIntent({ ...input(), ...change })).toThrow();
  });
  describe("on a mainnet pipeline", () => {
    const main = (): IntentInput => ({ ...input(), network: "mainnet" });
    const onMain = <T extends { network: string }>(x: T) => ({ ...x, network: "mainnet" as const });
    it("accepts only mainnet intents and observations, with a mainnet digest", () => {
      expect(parseIntent(main(), "mainnet").network).toBe("mainnet");
      expect(() => parseIntent(input(), "mainnet")).toThrow("NETWORK_NOT_ALLOWED");
      expect(() => parseIntent(main())).toThrow("NETWORK_NOT_ALLOWED");
      const m = main(), prepared = buildPreparation(m, onMain(source()), onMain(destination()), onMain(fee()), "mainnet");
      expect(prepared.transactionDigest).not.toBe(buildPreparation(input(), source(), destination(), fee()).transactionDigest);
      expect(() => buildPreparation(main(), source(), destination(), fee(), "mainnet")).toThrow("STALE_PREPARATION");
      expect(() => buildPreparation(input(), onMain(source()), onMain(destination()), onMain(fee()), "mainnet")).toThrow("NETWORK_NOT_ALLOWED");
      const signed = sourceWallet.sign(prepared.unsignedTransaction);
      expect(validateSigned(signed.tx_blob, prepared, m, sourceWallet.classicAddress).hash).toBe(signed.hash);
      // The same transaction under a testnet intent fails the network-bound digest.
      expect(() => validateSigned(signed.tx_blob, prepared, { ...m, network: "testnet" }, sourceWallet.classicAddress)).toThrow("SIGNED_TRANSACTION_MISMATCH");
    });
    it("reports the reserve amounts in the refusals", () => {
      try { buildPreparation(input(), { ...source(), reserveDrops: "1400000", baseReserveDrops: "1000000", spendableDrops: "1000000" }, destination(), fee()); throw new Error("no"); }
      catch (e: any) { expect(e.code).toBe("INSUFFICIENT_SPENDABLE_BALANCE"); expect(e.detail).toEqual({ reserveDrops: "1400000", spendableDrops: "1000000", feeDrops: "12", baseReserveDrops: "1000000", ownerCount: "0" }); }
      try { buildPreparation({ ...input(), amountDrops: "999999" }, source(), { ...destination(), funded: false, reserveDrops: "1000000" }, fee()); throw new Error("no"); }
      catch (e: any) { expect(e.code).toBe("DESTINATION_RESERVE_REQUIRED"); expect(e.detail).toEqual({ reserveDrops: "1000000" }); }
    });
  });
  it("builds an immutable, bounded native Payment with exactly one opaque memo", () => {
    const request = input(), prepared = buildPreparation(request, source(), destination(), fee());
    expect(prepared).toMatchObject({ feeDrops: "12", totalDrops: "1000012", sequence: 12, lastLedgerSequence: 1254 });
    const tx = decode(prepared.unsignedBlob);
    expect(tx).toMatchObject({ TransactionType: "Payment", Amount: request.amountDrops, DestinationTag: 0, Flags: 0x80000000 });
    expect(tx).not.toHaveProperty("SendMax"); expect(tx).not.toHaveProperty("SigningPubKey");
  });
  it.each([
    ["SOURCE_NOT_FUNDED", () => ({ src: { ...source(), funded: false, sequence: null } })],
    ["UNSUPPORTED_SIGNING_CONFIGURATION", () => ({ src: { ...source(), masterDisabled: true } })],
    ["UNSUPPORTED_SIGNING_CONFIGURATION", () => ({ src: { ...source(), hasRegularKey: true } })],
    ["UNSUPPORTED_SIGNING_CONFIGURATION", () => ({ src: { ...source(), hasSignerList: true } })],
    ["TAG_REQUIRED", () => ({ request: { ...input(), destinationTag: undefined }, dest: { ...destination(), requiresDestinationTag: true } })],
    ["UNSUPPORTED_DESTINATION", () => ({ dest: { ...destination(), depositAuth: true } })],
    ["FEE_LIMIT_EXCEEDED", () => ({ fee: { ...fee(), feeDrops: "101" } })],
    ["INSUFFICIENT_SPENDABLE_BALANCE", () => ({ src: { ...source(), spendableDrops: "1000000" } })],
    ["DESTINATION_RESERVE_REQUIRED", () => ({ request: { ...input(), amountDrops: "1" }, dest: { ...destination(), funded: false } })],
    ["STALE_PREPARATION", () => ({ fee: { ...fee(), observedAt: "2000-01-01T00:00:00Z" } })],
  ] as const)("enforces %s before signing", (code, changes) => {
    const change = changes() as { request?: IntentInput; src?: AccountSnapshot; dest?: AccountSnapshot; fee?: FeeSnapshot };
    expect(() => buildPreparation(change.request ?? input(), change.src ?? source(), change.dest ?? destination(), change.fee ?? fee())).toThrow(code);
  });
  it.each([ECDSA.ed25519, ECDSA.secp256k1])("verifies the %s master signature and transaction hash", algorithm => {
    const wallet = Wallet.generate(algorithm), request = input();
    const prepared = buildPreparation(request, { ...source(), address: wallet.classicAddress }, destination(), fee());
    const signed = wallet.sign(prepared.unsignedTransaction);
    expect(validateSigned(signed.tx_blob, prepared, request, wallet.classicAddress).hash).toBe(signed.hash);
  });
  it.each(["Amount", "Destination", "DestinationTag", "Fee", "Sequence", "LastLedgerSequence", "Flags", "Memos", "SendMax", "Paths", "TicketSequence", "Delegate"])("rejects a signed change to %s", field => {
    const request = input(), prepared = buildPreparation(request, source(), destination(), fee());
    const changes: Record<string, unknown> = { Amount: "2000000", Destination: sourceWallet.classicAddress, DestinationTag: 42, Fee: "13", Sequence: 13, LastLedgerSequence: 9999,
      Flags: 0x80020000, Memos: [], SendMax: "2000000", Paths: [], TicketSequence: 1, Delegate: destinationWallet.classicAddress };
    expect(() => {
      const signed = sourceWallet.sign({ ...prepared.unsignedTransaction, [field]: changes[field] } as Payment);
      validateSigned(signed.tx_blob, prepared, request, sourceWallet.classicAddress);
    }).toThrow();
  });
  it("rejects wrong-key signatures, broken signatures and extra binary fields", () => {
    const request = input(), prepared = buildPreparation(request, source(), destination(), fee());
    const wrong = Wallet.fromSeed(destinationWallet.seed!, { masterAddress: sourceWallet.classicAddress });
    expect(() => validateSigned(wrong.sign(prepared.unsignedTransaction).tx_blob, prepared, request, sourceWallet.classicAddress)).toThrow();
    const signed = sourceWallet.sign(prepared.unsignedTransaction).tx_blob;
    expect(() => validateSigned(signed.slice(0,-2) + (signed.endsWith("00") ? "01" : "00"), prepared, request, sourceWallet.classicAddress)).toThrow();
  });
  it("issues receipts only for exact delivered native XRP in a validated ledger", () => {
    const request = input(), prepared = buildPreparation(request, source(), destination(), fee()), signed = sourceWallet.sign(prepared.unsignedTransaction);
    const observation: TransactionObservation = { ...ledger(), status: "validated", transactionHash: signed.hash, validated: true, ledgerIndex: 1235, ledgerHash: "B".repeat(64), resultCode: "tesSUCCESS", transaction: decode(signed.tx_blob), metadata: { TransactionResult: "tesSUCCESS", delivered_amount: "1000000" } };
    expect(verifySettlement(randomUUID(), request, sourceWallet.classicAddress, prepared, signed.hash, observation)?.receipt).toMatchObject({ destinationTag: 0, deliveredAmountDrops: "1000000", validated: true, result: "tesSUCCESS" });
    const v2 = { ...observation, transaction: { ...observation.transaction, Amount: undefined, DeliverMax: "1000000" } }; delete v2.transaction.Amount;
    expect(verifySettlement(randomUUID(), request, sourceWallet.classicAddress, prepared, signed.hash, v2)?.state).toBe("validated_success");
    for (const metadata of [{ TransactionResult: "tesSUCCESS", delivered_amount: "999999" }, { TransactionResult: "tesSUCCESS", delivered_amount: "unavailable" }, { TransactionResult: "tecPATH_DRY", delivered_amount: "1000000" }]) {
      expect(() => verifySettlement(randomUUID(), request, sourceWallet.classicAddress, prepared, signed.hash, { ...observation, metadata })).toThrow("INTEGRITY_MISMATCH");
    }
    expect(verifySettlement(randomUUID(), request, sourceWallet.classicAddress, prepared, signed.hash, { ...observation, resultCode: "tecNO_DST", metadata: { TransactionResult: "tecNO_DST" } })).toMatchObject({ state: "validated_failure", receipt: null });
    expect(() => verifySettlement(randomUUID(), request, sourceWallet.classicAddress, prepared, signed.hash, { ...observation, resultCode: "tefPAST_SEQ", metadata: { TransactionResult: "tefPAST_SEQ" } })).toThrow("INTEGRITY_MISMATCH");
    expect(verifySettlement(randomUUID(), request, sourceWallet.classicAddress, prepared, signed.hash, { ...ledger(), status: "not_found", transactionHash: signed.hash, validated: false, authoritative: false })).toBeNull();
  });
});
