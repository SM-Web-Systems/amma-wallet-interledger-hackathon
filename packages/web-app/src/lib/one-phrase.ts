import { Wallet } from "xrpl";
import { deriveEvmAccount } from "@amma-wallet/evm-core";
import { deriveHDKeypair, isValidMnemonic, normalizeMnemonic } from "./hd-wallet";

/** The derivation paths one recovery phrase uses. These must not change: users restore elsewhere with them. */
export const ONE_PHRASE_PATHS = {
  stellar: "m/44'/148'/i'",
  xrpl: "m/44'/144'/0'/0/0",
  evm: "m/44'/60'/0'/0/i",
} as const;

export interface AllChains {
  stellar: { publicKey: string; secretKey: () => string };
  xrpl: { address: string };
  evm: { address: string };
}

/**
 * One BIP-39 phrase to the Stellar, XRP and Ethereum accounts of a user. Public details come back as
 * plain values; the Stellar secret only through a function, so a summary logged or serialised by
 * mistake carries no key. Throws a message that never contains the phrase.
 */
export function deriveAllChains(phrase: string, accountIndex = 0): AllChains {
  if (!isValidMnemonic(phrase)) throw new Error("This recovery phrase is not valid.");
  const normal = normalizeMnemonic(phrase);
  const stellar = deriveHDKeypair(normal, accountIndex);
  return {
    stellar: { publicKey: stellar.publicKey, secretKey: () => stellar.secretKey },
    xrpl: { address: Wallet.fromMnemonic(normal, { derivationPath: ONE_PHRASE_PATHS.xrpl }).classicAddress },
    evm: { address: deriveEvmAccount(normal, accountIndex).address },
  };
}
