import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../lib/api", () => ({
  userWalletApi: { add: vi.fn(async () => ({ id: 1 })), activate: vi.fn(async () => ({})) },
}));
vi.mock("../../lib/stellar", () => ({
  generateKeypair: vi.fn(),
  keypairFromSecret: vi.fn(),
  fundTestnet: vi.fn(async () => undefined),
}));
vi.mock("../../lib/crypto", () => ({
  encryptSecret: vi.fn(async (s: string) => `enc(${s.length})`),
  decryptSecret: vi.fn(),
}));

import { useWalletStore } from "../wallet";
import { isValidMnemonic } from "../../lib/hd-wallet";

const SEP5_24 =
  "bench hurt jump file august wise shallow faculty impulse spring exact slush thunder author capable act festival slice deposit sauce coconut afford frown better";
const SEP5_24_PK = "GC3MMSXBWHL6CPOAVERSJITX7BH76YU252WGLUOM5CJX3E7UCYZBTPJQ";

beforeEach(() => {
  localStorage.clear();
  useWalletStore.setState({ accounts: [], activeAccountId: null, _secretKey: null, _mnemonic: null });
});

describe("wallet store: recovery phrases", () => {
  it("generateMnemonic returns a valid 24-word phrase", async () => {
    const phrase = await useWalletStore.getState().generateMnemonic();
    expect(phrase.split(" ")).toHaveLength(24);
    expect(isValidMnemonic(phrase)).toBe(true);
  });

  it("importFromMnemonic normalizes a messy phrase and derives the SEP-0005 key", async () => {
    const messy = `\n ${SEP5_24.toUpperCase().replace(/ /g, "   ")} \n`;
    const pk = await useWalletStore.getState().importFromMnemonic("Imported", messy, "12345678");
    expect(pk).toBe(SEP5_24_PK);
    expect(useWalletStore.getState()._mnemonic).toBe(SEP5_24);
  });

  it("importFromMnemonic rejects an invalid phrase", async () => {
    await expect(
      useWalletStore.getState().importFromMnemonic("Bad", "hello world foo bar", "12345678"),
    ).rejects.toThrow(/invalid recovery phrase/i);
  });
});
