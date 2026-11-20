// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from "vitest";

const m = vi.hoisted(() => ({ importDeviceWallet: vi.fn() }));
vi.mock("./custody-import", async (orig) => ({ ...(await orig<typeof import("./custody-import")>()), importDeviceWallet: m.importDeviceWallet }));

import { custodyUnavailable, isPinRetiredError, moveLegacyPinWallet } from "./pin-retire";

const ok = { imported: true, alreadyHeld: false, verified: true, wallet: { chain: "stellar", address: "GPUB" } };
beforeEach(() => m.importDeviceWallet.mockReset());

describe("pin-retire", () => {
  it("recognises the server's pin-retired answer", () => {
    expect(isPinRetiredError(Object.assign(new Error("x"), { code: "pin-retired" }))).toBe(true);
    expect(isPinRetiredError(new Error("Incorrect wallet passphrase."))).toBe(false);
  });

  it("treats custody switched off, or not open to this account on mainnet, as paused", () => {
    expect(custodyUnavailable({ status: 503, message: "off" })).toBe(true);
    expect(custodyUnavailable({ status: 403, message: "Amma-held wallets aren't available for this account on mainnet yet." })).toBe(true);
    expect(custodyUnavailable({ status: 403, message: "That password is not correct." })).toBe(false);
  });

  it("moves with retirePin only for self-custody accounts", async () => {
    m.importDeviceWallet.mockResolvedValue(ok);
    expect(await moveLegacyPinWallet({ address: "GPUB", secret: "S", password: "p", selfCustody: false })).toBe("moved");
    expect(m.importDeviceWallet.mock.calls[0][0]).not.toHaveProperty("retirePin");
    await moveLegacyPinWallet({ address: "GPUB", secret: "S", password: "p", selfCustody: true });
    expect(m.importDeviceWallet.mock.calls[1][0]).toMatchObject({ retirePin: true });
  });

  it("is not 'moved' unless the server verified exactly this wallet", async () => {
    m.importDeviceWallet.mockResolvedValue({ ...ok, verified: false });
    await expect(moveLegacyPinWallet({ address: "GPUB", secret: "S", password: "p", selfCustody: false })).rejects.toThrow(/couldn't check/);
    m.importDeviceWallet.mockResolvedValue({ ...ok, wallet: { chain: "stellar", address: "GOTHER" } });
    await expect(moveLegacyPinWallet({ address: "GPUB", secret: "S", password: "p", selfCustody: false })).rejects.toThrow();
  });

  it("returns paused when custody isn't open to the account, and passes other errors on", async () => {
    m.importDeviceWallet.mockRejectedValueOnce(Object.assign(new Error("Amma-held wallets aren't available for this account on mainnet yet."), { status: 403 }));
    expect(await moveLegacyPinWallet({ address: "GPUB", secret: "S", password: "p", selfCustody: false })).toBe("paused");
    m.importDeviceWallet.mockRejectedValueOnce(Object.assign(new Error("That password is not correct."), { status: 403 }));
    await expect(moveLegacyPinWallet({ address: "GPUB", secret: "S", password: "p", selfCustody: false })).rejects.toThrow(/password/);
  });
});
