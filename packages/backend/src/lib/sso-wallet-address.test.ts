import { describe, expect, it } from "vitest";
import { pickSsoWalletAddress } from "./sso-wallet-address";

const t = (s: string) => new Date(s);
const device = { publicKey: "GDEVICE", isActive: true, derivationIndex: null, createdAt: t("2026-07-20T00:00:00Z") };
const custody = { publicKey: "GCUSTODY", isActive: false, derivationIndex: 0, createdAt: t("2026-11-15T00:00:00Z") };

describe("address sent to the LMS at sign-in", () => {
  it("is the Amma-held (index 0) wallet when the learner has one, even if a device wallet is the active one", () => {
    expect(pickSsoWalletAddress([device, custody])).toBe("GCUSTODY");
  });
  it("falls back to the newest active wallet when there is no Amma-held wallet (today's behaviour)", () => {
    const older = { ...device, publicKey: "GOLDER", createdAt: t("2026-01-01T00:00:00Z") };
    expect(pickSsoWalletAddress([older, device])).toBe("GDEVICE");
  });
  it("ignores inactive device wallets and other derivation indexes", () => {
    expect(pickSsoWalletAddress([{ ...device, isActive: false }, { ...custody, derivationIndex: 1 }])).toBeNull();
  });
  it("is null when the learner has no mainnet Stellar wallet", () => {
    expect(pickSsoWalletAddress([])).toBeNull();
  });
});
