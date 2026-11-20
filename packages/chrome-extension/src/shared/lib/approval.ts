import { Buffer } from "buffer";

export interface ApprovalRequest {
  method: string;
  params: any;
}

export interface ApprovalKeys {
  publicKey: string | null;
  secretKey: string | null;
  /** Amma holds the wallet: the server signs a transaction once the login password checks out. */
  serverSign?: (xdr: string) => Promise<string>;
}

const TESTNET_PASSPHRASE = "Test SDF Network ; September 2015";

/** Builds the response a dApp gets when the user approves a request in the popup. */
export async function buildApprovalResult(approval: ApprovalRequest, keys: ApprovalKeys): Promise<Record<string, string>> {
  if (approval.method === "connect") {
    if (!keys.publicKey) throw new Error("No active wallet");
    return { address: keys.publicKey };
  }
  if (!["signTransaction", "signAuthEntry", "signMessage"].includes(approval.method)) {
    throw new Error(`Unsupported request: ${approval.method}`);
  }
  if (keys.serverSign) {
    // Only whole transactions go through Amma's signer; raw messages and auth entries need the key on this device.
    if (approval.method !== "signTransaction") throw new Error("Amma holds this wallet, so it can approve transactions here but not sign messages yet.");
    if (!keys.publicKey) throw new Error("No active wallet");
    return { signedTxXdr: await keys.serverSign(approval.params.xdr), signerAddress: keys.publicKey };
  }
  if (!keys.secretKey) throw new Error("Wallet is locked");

  const StellarSdk = await import("@stellar/stellar-sdk");
  const keypair = StellarSdk.Keypair.fromSecret(keys.secretKey);

  if (approval.method === "signTransaction") {
    const tx = StellarSdk.TransactionBuilder.fromXDR(approval.params.xdr, approval.params.networkPassphrase || TESTNET_PASSPHRASE);
    if (tx instanceof StellarSdk.Transaction) tx.sign(keypair);
    return { signedTxXdr: tx.toXDR(), signerAddress: keypair.publicKey() };
  }
  if (approval.method === "signAuthEntry") {
    const signed = keypair.sign(Buffer.from(approval.params.authEntry, "base64"));
    return { signedAuthEntry: Buffer.from(signed).toString("base64"), signerAddress: keypair.publicKey() };
  }
  const signed = keypair.sign(Buffer.from(new TextEncoder().encode(approval.params.message)));
  return { signedMessage: Buffer.from(signed).toString("base64"), signerAddress: keypair.publicKey() };
}
