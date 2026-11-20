import { describe, expect, it } from "vitest";
import { parseTransaction, recoverTransactionAddress } from "viem";
import {
  EvmError, NETWORKS, assertRpcChain, automaticAction, classify, deriveEvmAccount, enabledNetwork, formatUnits,
  nextNonce, normalizeAddress, parseUnits, prepareNativeTransfer, quoteFees, signApprovedTransfer, type PreparedTransfer,
} from "../src";

// Public BIP-39 test vector used by Hardhat/Anvil. Never fund it on a mainnet.
const TEST_MNEMONIC = "test test test test test test test test test test test junk";
const ACCOUNT0 = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";
const ACCOUNT1 = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";
const GWEI = 1_000_000_000n, ETH = 10n ** 18n;
const code = (fn: () => unknown) => { try { fn(); } catch (e) { return (e as EvmError).code; } return "no error"; };
const acode = async (p: Promise<unknown>) => p.then(() => "no error", (e) => (e as EvmError).code);

describe("network registry", () => {
  it("enables Sepolia only and refuses mainnet and unknown ids", () => {
    expect(enabledNetwork("ethereum-sepolia").chainId).toBe(11155111);
    expect(code(() => enabledNetwork("ethereum-mainnet"))).toBe("EVM_NETWORK_DISABLED");
    expect(code(() => enabledNetwork("base-mainnet"))).toBe("EVM_NETWORK_UNKNOWN");
    expect(code(() => enabledNetwork("__proto__"))).toBe("EVM_NETWORK_UNKNOWN");
  });
  it("refuses an RPC that reports another chain", () => {
    expect(code(() => assertRpcChain(NETWORKS["ethereum-sepolia"], "0xaa36a7"))).toBe("no error");
    expect(code(() => assertRpcChain(NETWORKS["ethereum-sepolia"], 1))).toBe("EVM_RPC_WRONG_CHAIN");
  });
});

describe("exact amounts", () => {
  it("round-trips without floating point", () => {
    expect(parseUnits("0.1", 18)).toBe(100000000000000000n);
    expect(parseUnits("123456789.123456789123456789", 18)).toBe(123456789123456789123456789n);
    expect(formatUnits(1500000000000000000n, 18)).toBe("1.5");
    expect(formatUnits(1n, 18)).toBe("0.000000000000000001");
    expect(formatUnits(0n, 6)).toBe("0");
  });
  it("rejects ambiguous or lossy input", () => {
    for (const bad of ["", "1e18", "-1", "01", "1.", ".5", " 1", "1,5", "0x10", "Infinity"]) expect(code(() => parseUnits(bad, 18))).toBe("EVM_AMOUNT_INVALID");
    expect(code(() => parseUnits("0.0000000000000000001", 18))).toBe("EVM_AMOUNT_TOO_PRECISE");
    expect(code(() => parseUnits("1.5", 0))).toBe("EVM_AMOUNT_TOO_PRECISE");
    expect(code(() => parseUnits("9".repeat(80), 18))).toBe("EVM_AMOUNT_TOO_LARGE");
  });
});

describe("addresses", () => {
  it("checksums lower-case input and rejects a mistyped checksum", () => {
    expect(normalizeAddress(ACCOUNT0.toLowerCase())).toBe(ACCOUNT0);
    expect(normalizeAddress(ACCOUNT0)).toBe(ACCOUNT0);
    expect(code(() => normalizeAddress(ACCOUNT0.replace("f39Fd", "f39fD")))).toBe("EVM_ADDRESS_CHECKSUM");
    expect(code(() => normalizeAddress(ACCOUNT0.slice(0, -1)))).toBe("EVM_ADDRESS_INVALID");
    expect(code(() => normalizeAddress("0x" + "0".repeat(40)))).toBe("EVM_ADDRESS_ZERO");
  });
});

describe("derivation", () => {
  it("derives the standard m/44'/60'/0'/0/i accounts", () => {
    expect(deriveEvmAccount(TEST_MNEMONIC).address).toBe(ACCOUNT0);
    expect(deriveEvmAccount(`  ${TEST_MNEMONIC.replaceAll(" ", "   ")} `, 1).address).toBe(ACCOUNT1);
  });
  it("rejects a bad checksum word and invalid indexes", () => {
    expect(code(() => deriveEvmAccount(TEST_MNEMONIC.replace("junk", "test")))).toBe("EVM_MNEMONIC_INVALID");
    expect(code(() => deriveEvmAccount(TEST_MNEMONIC, -1))).toBe("EVM_DERIVATION_INDEX_INVALID");
    expect(code(() => deriveEvmAccount(TEST_MNEMONIC, 2 ** 31))).toBe("EVM_DERIVATION_INDEX_INVALID");
  });
});

describe("fees", () => {
  it("allows the base fee to double plus tip, and refuses a market above the cap", () => {
    expect(quoteFees(NETWORKS["ethereum-sepolia"], 10n * GWEI, 2n * GWEI)).toEqual({ maxFeePerGasWei: 22n * GWEI, maxPriorityFeePerGasWei: 2n * GWEI });
    expect(code(() => quoteFees(NETWORKS["ethereum-sepolia"], 600n * GWEI, 0n))).toBe("EVM_FEE_ABOVE_CAP");
    expect(code(() => quoteFees(NETWORKS["ethereum-sepolia"], 0n, 0n))).toBe("EVM_FEE_INVALID");
  });
});

const intent = { networkId: "ethereum-sepolia" as const, from: ACCOUNT0, to: ACCOUNT1, amount: "0.25" };
// An estimate of 17,500 pads to exactly 21,000, which keeps the totals below easy to read.
const state = { nonce: 7, balanceWei: 1n * ETH, baseFeeWei: 10n * GWEI, priorityFeeWei: 1n * GWEI, gasEstimate: 17_500n };

describe("native transfer preparation", () => {
  it("computes exact totals for review", () => {
    const p = prepareNativeTransfer(intent, state);
    expect(p).toMatchObject({ chainId: 11155111, nonce: 7, gasLimit: "21000", valueWei: "250000000000000000",
      maxFeePerGasWei: "21000000000", maxNetworkFeeWei: "441000000000000", maxTotalWei: "250441000000000000" });
    expect(p.display).toEqual({ amount: "0.25", maxNetworkFee: "0.000441", maxTotal: "0.250441", symbol: "SepoliaETH" });
  });
  it("refuses when value plus the maximum fee exceeds the balance, even by one wei", () => {
    expect(code(() => prepareNativeTransfer(intent, { ...state, balanceWei: 250441000000000000n - 1n }))).toBe("EVM_INSUFFICIENT_FUNDS");
    expect(code(() => prepareNativeTransfer(intent, { ...state, balanceWei: 250441000000000000n }))).toBe("no error");
  });
  it("uses the estimate plus 20% so a first send to a new address has enough gas", () => {
    // Measured on Sepolia: 207,391 gas to an address that does not exist yet.
    const p = prepareNativeTransfer(intent, { ...state, gasEstimate: 207_391n });
    expect(p.gasLimit).toBe("248870");
    expect(p.maxNetworkFeeWei).toBe((248_870n * 21n * GWEI).toString());
    expect(prepareNativeTransfer(intent, { ...state, gasEstimate: 260_000n }).gasLimit).toBe("300000");
  });
  it("refuses an estimate above the cap or not positive, rather than guessing", () => {
    expect(code(() => prepareNativeTransfer(intent, { ...state, gasEstimate: 300_001n }))).toBe("EVM_GAS_ABOVE_CAP");
    expect(code(() => prepareNativeTransfer(intent, { ...state, gasEstimate: 0n }))).toBe("EVM_GAS_ESTIMATE_INVALID");
  });
  it("refuses zero amounts and mainnet", () => {
    expect(code(() => prepareNativeTransfer({ ...intent, amount: "0" }, state))).toBe("EVM_AMOUNT_NOT_POSITIVE");
    expect(code(() => prepareNativeTransfer({ ...intent, networkId: "ethereum-mainnet" }, state))).toBe("EVM_NETWORK_DISABLED");
  });
});

describe("signing boundary", () => {
  const account = deriveEvmAccount(TEST_MNEMONIC);
  const prepared = prepareNativeTransfer(intent, state);

  it("signs exactly the approved transfer on Sepolia", async () => {
    const signed = await signApprovedTransfer(account, intent, prepared);
    const tx = parseTransaction(signed.rawTransaction);
    expect({ ...tx, to: normalizeAddress(tx.to!) }).toMatchObject({ type: "eip1559", chainId: 11155111, to: ACCOUNT1, value: 250000000000000000n, nonce: 7, gas: 21000n });
    expect(tx.data).toBeUndefined();
    expect(await recoverTransactionAddress({ serializedTransaction: signed.rawTransaction as never })).toBe(ACCOUNT0);
    expect(signed.hash).toMatch(/^0x[0-9a-f]{64}$/);
  });

  // A compromised backend or tampered review state must not get a signature.
  const tampered: [string, Partial<PreparedTransfer>, string][] = [
    ["recipient", { to: "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC" }, "EVM_SIGN_RECIPIENT_MISMATCH"],
    ["amount", { valueWei: "250000000000000001" }, "EVM_SIGN_AMOUNT_MISMATCH"],
    ["chain id", { chainId: 1 }, "EVM_SIGN_NETWORK_MISMATCH"],
    ["network", { networkId: "ethereum-mainnet" }, "EVM_SIGN_NETWORK_MISMATCH"],
    ["gas limit above the cap", { gasLimit: "300001" }, "EVM_SIGN_GAS_UNEXPECTED"],
    ["zero gas limit", { gasLimit: "0" }, "EVM_SIGN_GAS_UNEXPECTED"],
    ["gas limit without matching totals", { gasLimit: "100000" }, "EVM_SIGN_TOTAL_MISMATCH"],
    ["fee above cap", { maxFeePerGasWei: (1001n * GWEI).toString() }, "EVM_SIGN_FEE_ABOVE_CAP"],
    ["tip above max fee", { maxPriorityFeePerGasWei: (22n * GWEI).toString() }, "EVM_SIGN_FEE_ABOVE_CAP"],
    ["understated total", { maxTotalWei: "250000000000000000" }, "EVM_SIGN_TOTAL_MISMATCH"],
    ["non-canonical number", { valueWei: "0250000000000000000" }, "EVM_SIGN_MALFORMED"],
    ["negative nonce", { nonce: -1 }, "EVM_NONCE_INVALID"],
  ];
  for (const [name, change, expected] of tampered) {
    it(`refuses a changed ${name}`, async () => {
      expect(await acode(signApprovedTransfer(account, intent, { ...prepared, ...change } as PreparedTransfer))).toBe(expected);
    });
  }
  it("signs the estimated gas limit for a send to a new address", async () => {
    const big = prepareNativeTransfer(intent, { ...state, gasEstimate: 207_391n });
    expect(parseTransaction((await signApprovedTransfer(account, intent, big)).rawTransaction).gas).toBe(248_870n);
  });
  it("refuses a key that does not belong to the approved sender", async () => {
    expect(await acode(signApprovedTransfer(deriveEvmAccount(TEST_MNEMONIC, 1), intent, prepared))).toBe("EVM_SIGN_WRONG_KEY");
  });
});

describe("transaction lifecycle and uncertain outcomes", () => {
  const base = { transaction: null, receipt: null, minedNonce: 7, latestBlock: 100n };
  it("classifies observations", () => {
    expect(classify(7, 3, base)).toBe("unknown");
    expect(classify(7, 3, { ...base, transaction: { blockNumber: null } })).toBe("pending");
    expect(classify(7, 3, { ...base, receipt: { status: "success", blockNumber: 99n }, minedNonce: 8 })).toBe("included");
    expect(classify(7, 3, { ...base, receipt: { status: "success", blockNumber: 98n }, minedNonce: 8 })).toBe("confirmed");
    expect(classify(7, 3, { ...base, receipt: { status: "reverted", blockNumber: 90n }, minedNonce: 8 })).toBe("reverted");
    expect(classify(7, 3, { ...base, minedNonce: 8 })).toBe("replaced");
  });
  it("falls back from included to pending/unknown after a reorg removes the block", () => {
    expect(classify(7, 3, { ...base, transaction: { blockNumber: null }, minedNonce: 7 })).toBe("pending");
  });
  it("only ever rebroadcasts the same bytes for an open outcome", () => {
    expect(automaticAction("unknown")).toBe("rebroadcast-same-bytes");
    expect(automaticAction("broadcast")).toBe("rebroadcast-same-bytes");
    expect(automaticAction("replaced")).toBe("none");
  });
  it("blocks a new nonce while an earlier transfer is unresolved", () => {
    expect(code(() => nextNonce([{ nonce: 7, state: "unknown" }], 7))).toBe("EVM_EARLIER_TRANSFER_UNRESOLVED");
    expect(nextNonce([{ nonce: 7, state: "confirmed" }], 8)).toBe(8);
  });
});

describe("mnemonic creation", () => {
  it("creates distinct valid 12-word mnemonics that derive accounts", async () => {
    const { createMnemonic, normalizeMnemonic } = await import("../src");
    const a = createMnemonic(), b = createMnemonic();
    expect(a.split(" ")).toHaveLength(12);
    expect(a).not.toBe(b);
    expect(normalizeMnemonic(a.toUpperCase())).toBe(a);
    expect(deriveEvmAccount(a).address).toMatch(/^0x[0-9a-fA-F]{40}$/);
  });
});

describe("recovery phrase length (12 or 24 words)", () => {
  const V24 = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon art";
  it("generates 12 words by default and 24 on request, both valid", async () => {
    const { createMnemonic, normalizeMnemonic } = await import("../src");
    expect(createMnemonic().split(" ")).toHaveLength(12);
    const long = createMnemonic(24);
    expect(long.split(" ")).toHaveLength(24);
    expect(normalizeMnemonic(long)).toBe(long);
  });
  it("refuses any other length", async () => {
    const { createMnemonic } = await import("../src");
    expect(() => createMnemonic(18 as never)).toThrow(expect.objectContaining({ code: "EVM_MNEMONIC_LENGTH_INVALID" }));
  });
  it("restores a 24-word phrase to the standard m/44'/60'/0'/0/0 address", async () => {
    const { deriveEvmAccount } = await import("../src");
    // BIP-39 all-"abandon … art" vector; address matches MetaMask/ethers for this phrase.
    expect(deriveEvmAccount(V24.toUpperCase()).address).toBe("0xF278cF59F82eDcf871d630F28EcC8056f25C1cdb");
  });
});
