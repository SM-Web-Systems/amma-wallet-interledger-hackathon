import { describe, expect, it, vi } from "vitest";
// The pure reader needs no database (the custody wrapper is covered in routes/custody-xrpl-mainnet.test.ts).
vi.mock("../db", () => ({ db: {}, schema: {} }));
import { xrplActivationStatus, type ActivationReader } from "./xrpl-activation";
import type { AccountSnapshot } from "../modules/xrpl/read-adapter";

const ADDRESS = "rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh";
const ledger = { chain: "xrpl" as const, network: "mainnet" as const, endpoint: "wss://xrplcluster.com/", validatedLedgerIndex: 90_000_000, validatedLedgerHash: "A".repeat(64), observedAt: new Date().toISOString() };
const unfunded: AccountSnapshot = { ...ledger, address: ADDRESS, funded: false, balanceDrops: "0", reserveDrops: "1000000", baseReserveDrops: "1000000", spendableDrops: "0", sequence: null, ownerCount: 0, requiresDestinationTag: false };
const funded: AccountSnapshot = { ...unfunded, funded: true, balanceDrops: "3000000", reserveDrops: "1400000", spendableDrops: "1600000", sequence: 5, ownerCount: 2 };
const reader = (account: AccountSnapshot, feeDrops = "12"): ActivationReader => ({ getAccount: vi.fn(async () => account), getFee: vi.fn(async () => ({ ...ledger, feeDrops, currentLedgerIndex: 90_000_001 })) });

describe("XRP activation interface (for the activation-funding service)", () => {
  it("reports an unactivated wallet and the exact drops needed: base reserve + fee", async () => {
    expect(await xrplActivationStatus(reader(unfunded), ADDRESS)).toEqual({
      address: ADDRESS, network: "mainnet", activated: false, balanceDrops: "0", reserveDrops: "1000000", spendableDrops: "0",
      baseReserveDrops: "1000000", feeDrops: "12", neededDrops: "1000012", validatedLedgerIndex: 90_000_000 });
  });
  it("reports an activated wallet with nothing needed", async () => {
    expect(await xrplActivationStatus(reader(funded), ADDRESS)).toMatchObject({ activated: true, neededDrops: "0", baseReserveDrops: "1000000", reserveDrops: "1400000" });
  });
  it("follows the ledger's live reserve rather than a constant", async () => {
    expect((await xrplActivationStatus(reader({ ...unfunded, reserveDrops: "10000000", baseReserveDrops: "10000000" }, "15"), ADDRESS)).neededDrops).toBe("10000015");
  });
  it("throws instead of guessing when the ledger cannot be read", async () => {
    const broken: ActivationReader = { getAccount: async () => { throw new Error("XRPL_UNAVAILABLE"); }, getFee: async () => ({ ...ledger, feeDrops: "12", currentLedgerIndex: 1 }) };
    await expect(xrplActivationStatus(broken, ADDRESS)).rejects.toThrow("XRPL_UNAVAILABLE");
    await expect(xrplActivationStatus({ ...reader(unfunded), getFee: async () => ({ ...ledger, network: "testnet" as const, feeDrops: "12", currentLedgerIndex: 1 }) }, ADDRESS)).rejects.toThrow(/consistently/);
  });
});
