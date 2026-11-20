// @vitest-environment jsdom
// Audit F-3 / TODO D3: Settings looked up `mnemonic_${account.id}`, but the
// store only ever keeps (legacy) phrases under `mnemonic_${publicKey}` and
// decrypts them on unlock. Settings must use the store's copy, not its own key.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../lib/api", async (orig) => {
  const real = await orig<typeof import("../lib/api")>();
  return { ...real, signingApi: { ...real.signingApi, getMode: vi.fn(async () => { throw new Error("offline"); }) } };
});
vi.mock("../lib/stellar-keystore", () => ({
  saveStellarSecret: vi.fn(async () => {}),
  loadStellarSecret: vi.fn(async () => null),
  loadAllStellarSecrets: vi.fn(async () => new Map()),
  deleteStellarSecret: vi.fn(async () => {}),
}));

import { useWalletStore } from "../store/wallet";
import { encryptSecret } from "../lib/crypto";

const PASS = "lamp river garden 42";
const PHRASE = "illness spike retreat truth genius clock brain pass fit cave bargain toe";
const SECRET = "SBGWSG6BTNCKCOB3DIFBGCVMUPQFYPA2G4O34RMTB343OYPXU5DJDVMN";
const PUBLIC = "GDRXE2BQUC3AZNPVFSCEZ76NJ3WWL25FYFK6RGZGIEKWE4SOOHSUJUJ6";

describe("Settings recovery phrase lookup", () => {
  const src = readFileSync(join(__dirname, "Settings.tsx"), "utf8");

  it("does not read a mnemonic keyed by account id", () => {
    expect(src).not.toMatch(/mnemonic_\$\{active\?\.id\}/);
    expect(src).not.toMatch(/localStorage\.getItem\(\s*`mnemonic_/);
  });

  it("takes the phrase from the unlocked wallet store", () => {
    expect(src).toMatch(/getMnemonic\(\)/);
  });
});

describe("unlock exposes a legacy phrase stored under the public key", () => {
  beforeEach(() => localStorage.clear());

  it("getMnemonic returns it after unlock, and nothing after lock", async () => {
    const encryptedSecret = await encryptSecret(SECRET, PASS);
    localStorage.setItem(`mnemonic_${PUBLIC}`, await encryptSecret(PHRASE, PASS));
    useWalletStore.setState({
      accounts: [{ id: "acc-1", name: "A", publicKey: PUBLIC, encryptedSecret, isHD: true, network: "testnet" }],
      activeAccountId: "acc-1",
      isUnlocked: false, _secretKey: null, _mnemonic: null,
    } as never);
    await useWalletStore.getState().unlock(PASS);
    expect(useWalletStore.getState().getMnemonic()).toBe(PHRASE);
    useWalletStore.getState().lock();
    expect(useWalletStore.getState().getMnemonic()).toBeNull();
  });
});
