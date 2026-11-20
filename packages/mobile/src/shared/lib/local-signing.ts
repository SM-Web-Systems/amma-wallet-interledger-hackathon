import * as StellarSdk from "@stellar/stellar-sdk";

const TESTNET_PASSPHRASE = "Test SDF Network ; September 2015";
const PUBLIC_PASSPHRASE = "Public Global Stellar Network ; September 2015";

// The wallet store calls the real network "public"; "mainnet" is accepted too. Anything else is the test network.
const isPublicNetwork = (network: string) => network === "public" || network === "mainnet";

export function networkPassphraseFor(network: string): string {
  return isPublicNetwork(network) ? PUBLIC_PASSPHRASE : TESTNET_PASSPHRASE;
}

export function horizonBaseFor(network: string): string {
  return isPublicNetwork(network) ? "https://horizon.stellar.org" : "https://horizon-testnet.stellar.org";
}

/** The quote route answers with a list, which the server's response schema turns into an object keyed 0, 1, ... */
export function firstQuote(res: unknown): any | null {
  if (Array.isArray(res)) return res[0] ?? null;
  if (res && typeof res === "object") {
    const r = res as Record<string, any>;
    if (r["0"] && typeof r["0"] === "object") return r["0"];
    if (r.sourceAsset && r.destAsset) return r;
  }
  return null;
}

// A swap may carry one payment of the sold asset (the platform fee). It may take at most this share of the amount sold.
const MAX_FEE_SHARE = 0.02;
// The most the network fee on one transaction may be, in stroops (0.1 XLM).
const MAX_NETWORK_FEE_STROOPS = 1_000_000;

/** What the person typed on the Send screen. The phone checks the transaction against this before signing. */
export type PaymentExpectation = {
  source: string;
  destination: string;
  amount: string;
  assetCode: string;
  assetIssuer?: string | null;
};

/** What the person chose on the Swap screen. */
export type SwapExpectation = {
  source: string;
  amount: string;
  fromCode: string;
  fromIssuer?: string | null;
  toCode: string;
  toIssuer?: string | null;
};

function sameAsset(asset: StellarSdk.Asset, code: string, issuer?: string | null): boolean {
  if (asset.isNative()) return code === "XLM" && !issuer;
  return asset.getCode() === code && asset.getIssuer() === (issuer || undefined);
}

function sameAmount(a: string, b: string): boolean {
  return Number(a) === Number(b);
}

/** Builds the payment on the phone from the account state Horizon reports. One payment, nothing else. */
export function buildPaymentXdr(
  account: StellarSdk.Account | StellarSdk.Horizon.AccountResponse,
  p: PaymentExpectation & { memo?: string; networkPassphrase: string },
): string {
  const asset = p.assetIssuer ? new StellarSdk.Asset(p.assetCode, p.assetIssuer) : StellarSdk.Asset.native();
  const builder = new StellarSdk.TransactionBuilder(account, { fee: StellarSdk.BASE_FEE, networkPassphrase: p.networkPassphrase })
    .addOperation(StellarSdk.Operation.payment({ destination: p.destination, asset, amount: p.amount }));
  if (p.memo) builder.addMemo(StellarSdk.Memo.text(p.memo));
  return builder.setTimeout(180).build().toXDR();
}

/** Refuses a transaction that is not the one payment the person asked for. */
export function verifyPayment(want: PaymentExpectation): (tx: StellarSdk.Transaction) => void {
  return (tx) => {
    if (tx.operations.length !== 1) throw new Error("The transaction does not match what you entered.");
    const op = tx.operations[0];
    if (
      op.type !== "payment" ||
      op.destination !== want.destination ||
      !sameAmount(op.amount, want.amount) ||
      !sameAsset(op.asset, want.assetCode, want.assetIssuer)
    ) {
      throw new Error("The transaction does not match what you entered.");
    }
  };
}

/**
 * A swap built by the server must be exactly one strict-send path payment from the chosen asset to the chosen asset,
 * paying back to the person's own account, selling no more than the amount typed, plus at most one payment of the sold
 * asset that is the platform fee (a small share of the amount sold). Anything else is refused.
 */
export function verifySwap(want: SwapExpectation): (tx: StellarSdk.Transaction) => void {
  const refuse = (): never => { throw new Error("The swap does not match what you chose."); };
  return (tx) => {
    if (Number(tx.fee) > MAX_NETWORK_FEE_STROOPS) refuse();
    const paths = tx.operations.filter((op) => op.type === "pathPaymentStrictSend" || op.type === "pathPaymentStrictReceive");
    const payments = tx.operations.filter((op) => op.type === "payment");
    if (paths.length !== 1 || payments.length > 1 || paths.length + payments.length !== tx.operations.length) refuse();

    const op = paths[0];
    if (op.type !== "pathPaymentStrictSend") refuse();
    const swap = op as StellarSdk.Operation.PathPaymentStrictSend;
    if (!sameAsset(swap.sendAsset, want.fromCode, want.fromIssuer) || !sameAsset(swap.destAsset, want.toCode, want.toIssuer)) refuse();
    if (swap.destination !== want.source) throw new Error("The swap does not pay back to your own account.");
    const sold = Number(swap.sendAmount);
    if (!(sold > 0) || sold > Number(want.amount) * (1 + 1e-9)) refuse();

    for (const p of payments) {
      const pay = p as StellarSdk.Operation.Payment;
      if (!sameAsset(pay.asset, want.fromCode, want.fromIssuer)) refuse();
      if (!(Number(pay.amount) <= sold * MAX_FEE_SHARE)) refuse();
    }
  };
}

/** Signs on the device. The secret key stays in this function's scope. */
function signXdrLocally(
  xdr: string,
  secret: string,
  networkPassphrase: string,
  verify?: (tx: StellarSdk.Transaction) => void,
): string {
  const tx = StellarSdk.TransactionBuilder.fromXDR(xdr, networkPassphrase);
  if (tx instanceof StellarSdk.FeeBumpTransaction) {
    throw new Error("Fee bump transactions are not supported for local signing");
  }
  const keypair = StellarSdk.Keypair.fromSecret(secret);
  // The transaction must be for this account. It is never signed for someone else.
  if (tx.source !== keypair.publicKey()) throw new Error("The transaction is not for your account.");
  verify?.(tx);
  tx.sign(keypair);
  return tx.toXDR();
}

/** The submit route answers 200 either way; only `success: true` means the network took it. */
export function assertSubmitted(res: unknown): void {
  if (!res || (res as { success?: unknown }).success !== true) {
    throw new Error("The network did not confirm the transaction. Check your history before trying again.");
  }
}

/**
 * Self-custody Send and Swap (G-03): unlock with the passphrase, build the transaction, check it is what the person asked
 * for, sign it here and submit only the signed transaction. The secret key is never part of any request.
 * `unlock` runs first, so a wrong passphrase stops everything before a request is made.
 * `build` may return the network passphrase the server built for; if it differs from the phone's, nothing is signed.
 */
export async function buildSignSubmit<T>(input: {
  unlock: () => Promise<string>;
  build: () => Promise<string | { xdr: string; networkPassphrase?: string }>;
  submit: (signedXdr: string) => Promise<T>;
  networkPassphrase: string;
  verify?: (tx: StellarSdk.Transaction) => void;
}): Promise<T> {
  const secret = await input.unlock();
  const built = await input.build();
  const xdr = typeof built === "string" ? built : built.xdr;
  if (typeof built !== "string" && built.networkPassphrase && built.networkPassphrase !== input.networkPassphrase) {
    throw new Error("The server and this phone are on different networks. Nothing was signed.");
  }
  const signed = signXdrLocally(xdr, secret, input.networkPassphrase, input.verify);
  return input.submit(signed);
}
