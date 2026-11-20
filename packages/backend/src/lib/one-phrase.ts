import StellarHDWallet from "stellar-hd-wallet";
import { Wallet } from "xrpl";
import { mnemonicToAccount } from "viem/accounts";

/** The derivation paths one recovery phrase uses. These must not change: users restore elsewhere with them. */
export const ONE_PHRASE_PATHS = {
  stellar: "m/44'/148'/i'",
  xrpl: "m/44'/144'/0'/0/i",
  evm: "m/44'/60'/0'/0/i",
} as const;

export interface DerivedChains {
  stellar: { publicKey: string; secret: () => string };
  xrpl: { address: string; seed: () => { publicKey: string; privateKey: string } };
  evm: { address: `0x${string}`; privateKey: () => `0x${string}` };
}

/** NFKD, trimmed, lower case, single spaces: people paste phrases with capitals and odd spacing. */
function normalize(p: string): string {
  return (p ?? "").normalize("NFKD").trim().toLowerCase().split(/\s+/).filter(Boolean).join(" ");
}

/** A new 12-word BIP-39 phrase (128 bits of entropy). */
export function generatePhrase(): string {
  return StellarHDWallet.generateMnemonic({ entropyBits: 128 });
}

export function isValidPhrase(p: string): boolean {
  const n = normalize(p);
  return !!n && StellarHDWallet.validateMnemonic(n);
}

/**
 * One phrase to the Stellar, XRP and Ethereum accounts of a user. Public details are plain values;
 * secrets only come out of functions, so a summary logged or serialised by mistake carries no key.
 * Throws a message that never contains the phrase.
 */
export function deriveAllChains(phrase: string, index = 0): DerivedChains {
  if (!isValidPhrase(phrase)) throw new Error("This recovery phrase is not valid.");
  if (!Number.isSafeInteger(index) || index < 0 || index >= 2 ** 31) throw new Error("The account number is not valid.");
  const normal = normalize(phrase);
  const stellar = StellarHDWallet.fromMnemonic(normal);
  const xrp = Wallet.fromMnemonic(normal, { derivationPath: ONE_PHRASE_PATHS.xrpl.replace("i", String(index)) });
  const evm = mnemonicToAccount(normal, { path: ONE_PHRASE_PATHS.evm.replace("i", String(index)) as `m/44'/60'/${string}` });
  return {
    stellar: { publicKey: stellar.getPublicKey(index), secret: () => stellar.getSecret(index) },
    xrpl: { address: xrp.classicAddress, seed: () => ({ publicKey: xrp.publicKey, privateKey: xrp.privateKey }) },
    evm: {
      address: evm.address,
      privateKey: () => {
        const k = evm.getHdKey().privateKey;
        if (!k) throw new Error("Could not derive the Ethereum key.");
        return `0x${Buffer.from(k).toString("hex")}`;
      },
    },
  };
}
