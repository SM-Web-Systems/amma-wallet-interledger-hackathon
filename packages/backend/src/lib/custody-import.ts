import * as StellarSdk from "@stellar/stellar-sdk";
import { Wallet, decode, deriveAddress, isValidClassicAddress, verifySignature } from "xrpl";
import { isAddress, verifyMessage } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { deriveAllChains, isValidPhrase } from "./one-phrase";
import type { CustodyChain } from "./custody-signer";
import type { EscrowKind } from "./key-wrapper";

/**
 * Device-only wallets moved into Amma's escrow. One sealed secret per wallet, kind "import:<chain>:<address>".
 * Accepted secrets: a recovery phrase (account 0 of the chain's usual path), an XRP family seed, a Stellar "S..." secret.
 * Nothing here logs or returns a secret; failures say nothing about its contents.
 */
export const importKind = (chain: CustodyChain, address: string): EscrowKind => `import:${chain}:${chain === "evm" ? address.toLowerCase() : address}`;

export const validAddress = (chain: CustodyChain, address: string): boolean =>
  chain === "evm" ? /^0x[0-9a-fA-F]{40}$/.test(address) && isAddress(address)
    : chain === "xrpl" ? isValidClassicAddress(address) : StellarSdk.StrKey.isValidEd25519PublicKey(address);

/** Trims, and for a phrase lowers case and collapses spacing the way the phrase code does. */
export function cleanSecret(secret: string): string {
  const t = secret.normalize("NFKD").trim();
  return /\s/.test(t) ? t.toLowerCase().split(/\s+/).filter(Boolean).join(" ") : t;
}

type Key = { stellarSecret?: string; xrplWallet?: Wallet; evmPrivateKey?: `0x${string}` };

/** The signing key and address the secret yields for this chain, or null when it is not a usable secret. */
export function keyFromImported(chain: CustodyChain, secret: string): { address: string; key: Key } | null {
  try {
    if (/\s/.test(secret)) {
      if (!isValidPhrase(secret)) return null;
      const d = deriveAllChains(secret, 0);
      if (chain === "evm") return { address: d.evm.address, key: { evmPrivateKey: d.evm.privateKey() } };
      if (chain === "xrpl") { const s = d.xrpl.seed(); return { address: d.xrpl.address, key: { xrplWallet: new Wallet(s.publicKey, s.privateKey) } }; }
      return { address: d.stellar.publicKey, key: { stellarSecret: d.stellar.secret() } };
    }
    if (chain === "xrpl" && /^s[1-9A-HJ-NP-Za-km-z]{15,40}$/.test(secret)) {
      const w = Wallet.fromSeed(secret);
      return { address: w.classicAddress, key: { xrplWallet: w } };
    }
    if (chain === "stellar" && /^S[A-Z2-7]{55}$/.test(secret)) {
      return { address: StellarSdk.Keypair.fromSecret(secret).publicKey(), key: { stellarSecret: secret } };
    }
  } catch { /* not a usable secret */ }
  return null;
}

export const sameAddress = (chain: CustodyChain, a: string, b: string) => (chain === "evm" ? a.toLowerCase() === b.toLowerCase() : a === b);

const CHECK_MESSAGE = "Amma import check";

/** Signs a fixed, never-submitted message with the key and checks the signature against the address. Throws when it does not verify; returns nothing, so no signature leaves. */
export async function proveCanSign(chain: CustodyChain, address: string, key: Key): Promise<void> {
  if (chain === "stellar") {
    const data = Buffer.from(CHECK_MESSAGE, "utf8");
    const sig = StellarSdk.Keypair.fromSecret(key.stellarSecret!).sign(data);
    if (!StellarSdk.Keypair.fromPublicKey(address).verify(data, sig)) throw new Error("signature did not verify");
    return;
  }
  if (chain === "xrpl") {
    // An AccountSet-shaped transaction that is only signed and checked here, never submitted.
    const signed = key.xrplWallet!.sign({ TransactionType: "AccountSet", Account: address, Sequence: 1, Fee: "12", LastLedgerSequence: 1 });
    const decoded = decode(signed.tx_blob) as { SigningPubKey?: string };
    if (!verifySignature(signed.tx_blob) || !decoded.SigningPubKey || deriveAddress(decoded.SigningPubKey) !== address) throw new Error("signature did not verify");
    return;
  }
  const signature = await privateKeyToAccount(key.evmPrivateKey!).signMessage({ message: CHECK_MESSAGE });
  if (!(await verifyMessage({ address: address as `0x${string}`, message: CHECK_MESSAGE, signature }))) throw new Error("signature did not verify");
}
