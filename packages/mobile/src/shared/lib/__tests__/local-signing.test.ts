import { describe, expect, it, vi } from "vitest";
import { readFileSync, readdirSync, statSync } from "fs";
import { join, resolve } from "path";
import * as StellarSdk from "@stellar/stellar-sdk";
import {
  buildSignSubmit, buildPaymentXdr, verifyPayment, verifySwap, assertSubmitted, networkPassphraseFor, horizonBaseFor, firstQuote,
} from "../local-signing";

// G-03: a self-custody secret key never leaves the phone. Send and Swap sign here and submit only the signed transaction.
const PASSPHRASE = "Test SDF Network ; September 2015";
const keypair = StellarSdk.Keypair.random();
const SECRET = keypair.secret();

function unsignedXdr(): string {
  const account = new StellarSdk.Account(keypair.publicKey(), "100");
  return new StellarSdk.TransactionBuilder(account, { fee: "100", networkPassphrase: PASSPHRASE })
    .addOperation(StellarSdk.Operation.payment({ destination: StellarSdk.Keypair.random().publicKey(), asset: StellarSdk.Asset.native(), amount: "1" }))
    .setTimeout(30)
    .build()
    .toXDR();
}

describe("buildSignSubmit", () => {
  it("signs on the device and submits only the signed transaction", async () => {
    const build = vi.fn(async () => unsignedXdr());
    const submit = vi.fn(async (_signed: string) => ({ hash: "h" }));
    const unlock = vi.fn(async () => SECRET);

    await buildSignSubmit({ unlock, build, submit, networkPassphrase: PASSPHRASE });

    expect(submit).toHaveBeenCalledTimes(1);
    const signed = submit.mock.calls[0][0];
    const tx = StellarSdk.TransactionBuilder.fromXDR(signed, PASSPHRASE) as StellarSdk.Transaction;
    expect(tx.signatures).toHaveLength(1);
    // The signature is the account's own.
    expect(keypair.verify(tx.hash(), tx.signatures[0].signature())).toBe(true);
  });

  it("never passes the secret key to the build step or the submit step", async () => {
    const build = vi.fn(async (..._args: unknown[]) => unsignedXdr());
    const submit = vi.fn(async (..._args: unknown[]) => ({}));
    await buildSignSubmit({ unlock: async () => SECRET, build, submit, networkPassphrase: PASSPHRASE });
    for (const call of [...build.mock.calls, ...submit.mock.calls]) {
      expect(JSON.stringify(call)).not.toContain(SECRET);
      expect(JSON.stringify(call)).not.toMatch(/"secret"/);
    }
  });

  it("when the unlock step fails (wrong passphrase), nothing is built, signed or sent", async () => {
    const build = vi.fn(async () => unsignedXdr());
    const submit = vi.fn(async () => ({}));
    const unlock = vi.fn(async () => { throw new Error("Wrong passphrase."); });
    await expect(buildSignSubmit({ unlock, build, submit, networkPassphrase: PASSPHRASE })).rejects.toThrow("Wrong passphrase.");
    expect(build).not.toHaveBeenCalled();
    expect(submit).not.toHaveBeenCalled();
  });

  it("refuses a transaction whose source is not this account", async () => {
    const other = StellarSdk.Keypair.random();
    const foreign = new StellarSdk.TransactionBuilder(new StellarSdk.Account(other.publicKey(), "1"), { fee: "100", networkPassphrase: PASSPHRASE })
      .addOperation(StellarSdk.Operation.payment({ destination: keypair.publicKey(), asset: StellarSdk.Asset.native(), amount: "1" }))
      .setTimeout(30).build().toXDR();
    const submit = vi.fn(async () => ({}));
    await expect(buildSignSubmit({ unlock: async () => SECRET, build: async () => foreign, submit, networkPassphrase: PASSPHRASE })).rejects.toThrow(/not for your account/);
    expect(submit).not.toHaveBeenCalled();
  });

  it("refuses to sign when the server built for a different network", async () => {
    const submit = vi.fn(async () => ({}));
    await expect(buildSignSubmit({
      unlock: async () => SECRET,
      build: async () => ({ xdr: unsignedXdr(), networkPassphrase: "Public Global Stellar Network ; September 2015" }),
      submit, networkPassphrase: PASSPHRASE,
    })).rejects.toThrow(/different networks/);
    expect(submit).not.toHaveBeenCalled();
  });

  it("refuses to sign a fee bump transaction locally", async () => {
    const inner = StellarSdk.TransactionBuilder.fromXDR(unsignedXdr(), PASSPHRASE) as StellarSdk.Transaction;
    const bump = StellarSdk.TransactionBuilder.buildFeeBumpTransaction(keypair, "200", inner, PASSPHRASE).toXDR();
    const submit = vi.fn(async () => ({}));
    await expect(buildSignSubmit({ unlock: async () => SECRET, build: async () => bump, submit, networkPassphrase: PASSPHRASE })).rejects.toThrow(/fee bump/i);
    expect(submit).not.toHaveBeenCalled();
  });
});

const DEST = StellarSdk.Keypair.random().publicKey();
const ISSUER = StellarSdk.Keypair.random().publicKey();

describe("Send: the phone builds the payment and checks it before signing", () => {
  const want = { source: keypair.publicKey(), destination: DEST, amount: "2.5", assetCode: "USDC", assetIssuer: ISSUER };
  const xdr = (over: Partial<typeof want> = {}, extraOp = false) => {
    const w = { ...want, ...over };
    const asset = w.assetIssuer ? new StellarSdk.Asset(w.assetCode, w.assetIssuer) : StellarSdk.Asset.native();
    const b = new StellarSdk.TransactionBuilder(new StellarSdk.Account(keypair.publicKey(), "5"), { fee: "100", networkPassphrase: PASSPHRASE })
      .addOperation(StellarSdk.Operation.payment({ destination: w.destination, asset, amount: w.amount }));
    if (extraOp) b.addOperation(StellarSdk.Operation.payment({ destination: StellarSdk.Keypair.random().publicKey(), asset, amount: "1" }));
    return b.setTimeout(30).build().toXDR();
  };
  const run = (built: string) => buildSignSubmit({ unlock: async () => SECRET, build: async () => built, submit: async (x) => x, networkPassphrase: PASSPHRASE, verify: verifyPayment(want) });

  it("builds one payment with the typed destination, amount, asset and memo", () => {
    const built = buildPaymentXdr(new StellarSdk.Account(keypair.publicKey(), "7"), { ...want, memo: "hi", networkPassphrase: PASSPHRASE });
    const tx = StellarSdk.TransactionBuilder.fromXDR(built, PASSPHRASE) as StellarSdk.Transaction;
    expect(tx.source).toBe(keypair.publicKey());
    expect(tx.operations).toHaveLength(1);
    expect(tx.memo.value?.toString()).toBe("hi");
    expect(() => verifyPayment(want)(tx)).not.toThrow();
  });
  it("signs a matching payment", async () => {
    await expect(run(xdr())).resolves.toBeTypeOf("string");
  });
  it.each([
    ["another destination", xdr({ destination: StellarSdk.Keypair.random().publicKey() })],
    ["another amount", xdr({ amount: "250" })],
    ["another asset", xdr({ assetCode: "EURC" })],
    ["an extra operation", xdr({}, true)],
  ])("refuses %s", async (_name, built) => {
    await expect(run(built)).rejects.toThrow(/does not match what you entered/);
  });
});

describe("Swap: the phone checks what the server built", () => {
  const want = { source: keypair.publicKey(), amount: "10", fromCode: "XLM", fromIssuer: null, toCode: "USDC", toIssuer: ISSUER };
  const usdc = new StellarSdk.Asset("USDC", ISSUER);
  const path = (over: { dest?: string; sendAsset?: StellarSdk.Asset; destAsset?: StellarSdk.Asset; sendAmount?: string } = {}) =>
    StellarSdk.Operation.pathPaymentStrictSend({
      sendAsset: over.sendAsset ?? StellarSdk.Asset.native(), sendAmount: over.sendAmount ?? "10", destination: over.dest ?? keypair.publicKey(),
      destAsset: over.destAsset ?? usdc, destMin: "1", path: [],
    });
  const tx = (ops: any[], fee = "100") => {
    const b = new StellarSdk.TransactionBuilder(new StellarSdk.Account(keypair.publicKey(), "5"), { fee, networkPassphrase: PASSPHRASE });
    ops.forEach((o) => b.addOperation(o));
    return StellarSdk.TransactionBuilder.fromXDR(b.setTimeout(30).build().toXDR(), PASSPHRASE) as StellarSdk.Transaction;
  };
  const feePayment = (amount = "0.01", asset = StellarSdk.Asset.native()) =>
    StellarSdk.Operation.payment({ destination: StellarSdk.Keypair.random().publicKey(), asset, amount });

  it("accepts the chosen path payment, with or without one small fee payment of the sold asset", () => {
    expect(() => verifySwap(want)(tx([path()]))).not.toThrow();
    expect(() => verifySwap(want)(tx([path(), feePayment("0.01")]))).not.toThrow();
  });
  it("refuses another sold asset, another bought asset, a payout to someone else, or no swap at all", () => {
    expect(() => verifySwap(want)(tx([path({ sendAsset: usdc })]))).toThrow();
    expect(() => verifySwap(want)(tx([path({ destAsset: StellarSdk.Asset.native() })]))).toThrow();
    expect(() => verifySwap(want)(tx([path({ dest: StellarSdk.Keypair.random().publicKey() })]))).toThrow(/pay back/);
    expect(() => verifySwap(want)(tx([feePayment()]))).toThrow();
  });
  it("refuses selling more than was typed", () => {
    expect(() => verifySwap(want)(tx([path({ sendAmount: "1000" })]))).toThrow();
  });
  it("refuses a fee payment that is large, in another asset, or a second one; and other operations", () => {
    expect(() => verifySwap(want)(tx([path(), feePayment("9")]))).toThrow();
    expect(() => verifySwap(want)(tx([path(), feePayment("0.01", usdc)]))).toThrow();
    expect(() => verifySwap(want)(tx([path(), feePayment(), feePayment()]))).toThrow();
    expect(() => verifySwap(want)(tx([path(), path()]))).toThrow();
    expect(() => verifySwap(want)(tx([path(), StellarSdk.Operation.changeTrust({ asset: usdc })]))).toThrow();
  });
  it("refuses a transaction with a very large network fee", () => {
    expect(() => verifySwap(want)(tx([path()], "5000000"))).toThrow();
  });
  it("refuses a strict-receive path payment (the phone only asks for strict-send quotes)", () => {
    const op = StellarSdk.Operation.pathPaymentStrictReceive({
      sendAsset: StellarSdk.Asset.native(), sendMax: "10", destination: keypair.publicKey(), destAsset: usdc, destAmount: "1", path: [],
    });
    expect(() => verifySwap(want)(tx([op]))).toThrow();
  });
});

describe("firstQuote: the quote route answers with a list", () => {
  const q = { sourceAsset: { code: "XLM" }, destAsset: { code: "USDC" }, sourceAmount: "10", destAmount: "1" };
  it("takes the best quote from a list, from the object the server's response schema makes of a list, or a single quote", () => {
    expect(firstQuote([q])).toBe(q);
    expect(firstQuote({ "0": q })).toBe(q);
    expect(firstQuote(q)).toBe(q);
  });
  it("is null when there is no quote", () => {
    expect(firstQuote([])).toBeNull();
    expect(firstQuote({})).toBeNull();
    expect(firstQuote({ error: "x" })).toBeNull();
    expect(firstQuote(undefined)).toBeNull();
  });
});

describe("submit result and network helpers", () => {
  it("only success: true counts as sent", () => {
    expect(() => assertSubmitted({ success: true, result: {} })).not.toThrow();
    expect(() => assertSubmitted({})).toThrow(/did not confirm/);
    expect(() => assertSubmitted({ error: "bad" })).toThrow();
    expect(() => assertSubmitted(undefined)).toThrow();
  });
  it("maps the wallet network to its passphrase and Horizon", () => {
    expect(networkPassphraseFor("testnet")).toBe(PASSPHRASE);
    // The wallet store's real-network value is "public".
    expect(networkPassphraseFor("public")).toContain("Public Global");
    expect(networkPassphraseFor("mainnet")).toContain("Public Global");
    expect(horizonBaseFor("testnet")).toContain("horizon-testnet");
    expect(horizonBaseFor("public")).toBe("https://horizon.stellar.org");
  });
});

describe("no phone code sends a secret key", () => {
  const root = resolve(__dirname, "..", "..", "..", "..");
  const files = (dir: string): string[] => readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    if (name === "node_modules" || name === "__tests__") return [];
    if (statSync(full).isDirectory()) return files(full);
    return /\.(ts|tsx)$/.test(name) && !/\.test\./.test(name) ? [full] : [];
  });
  const sources = [...files(join(root, "app")), ...files(join(root, "src"))];

  it("no request body is built with a secret field", () => {
    const offenders = sources.filter((f) => /JSON\.stringify\(\{[^}]*\bsecret\b/.test(readFileSync(f, "utf-8")));
    expect(offenders.map((f) => f.replace(root, ""))).toEqual([]);
  });

  it("the Send and Swap screens never put a secret, phrase or passphrase near a request", () => {
    for (const screen of ["app/(tabs)/send.tsx", "app/(tabs)/swap.tsx"]) {
      const text = readFileSync(join(root, screen), "utf-8");
      expect(text).not.toMatch(/\b(secret|mnemonic|phrase)\s*[:,]/i);
      // The only network call a screen makes itself is a read of the public ledger (Send's account lookup).
      for (const call of text.match(/fetch\([^)]*\)/g) ?? []) expect(call).toContain("horizonBaseFor");
    }
  });

  it("every server route the phone Send and Swap use exists in the backend", () => {
    const backend = readFileSync(resolve(root, "..", "backend", "src", "server.ts"), "utf-8");
    const api = readFileSync(join(root, "src/shared/lib/api.ts"), "utf-8");
    for (const route of ["/api/v1/swap/quote", "/api/v1/swap/build", "/api/v1/transactions/submit"]) {
      expect(api).toContain(route);
      expect(backend).toContain(route);
    }
    expect(readFileSync(join(root, "app/(tabs)/send.tsx"), "utf-8")).not.toContain("build-payment");
  });

  it("Send and Swap no longer call the server's /transactions/sign route", () => {
    for (const screen of ["app/(tabs)/send.tsx", "app/(tabs)/swap.tsx"]) {
      expect(readFileSync(join(root, screen), "utf-8")).not.toContain("/api/v1/transactions/sign");
    }
  });
});
