import { describe, expect, it } from "vitest";
import { Account, Asset, Keypair, Networks, Operation, TransactionBuilder, nativeToScVal } from "@stellar/stellar-sdk";
import { DEFAULT_MAINNET_TOKEN_CAPS, TOKEN_REFUSED_ERROR, checkEvmLimits, checkStellarTx, checkXrpLimits, custodyLimitsFromEnv, foreignSourceOp, parseDecimal7, parseTokenCaps, tokenOutflows } from "./custody-limits";

const XRP = 1_000_000n;
describe("custodyLimitsFromEnv", () => {
  it("uses the testnet defaults", () => {
    const l = custodyLimitsFromEnv({});
    expect(l.xrpTxDrops).toBe(100n * XRP);
    expect(l.xrpDayDrops).toBe(500n * XRP);
    expect(l.evmTxWei).toBe(50_000_000_000_000_000n);
    expect(l.evmDayWei).toBe(200_000_000_000_000_000n);
    expect(l.xrpNewRecipientDrops).toBe(l.xrpTxDrops);
    expect(l.evmNewRecipientWei).toBe(l.evmTxWei);
  });
  it("reads overrides, and the new-recipient cap follows the tx limit unless set", () => {
    const l = custodyLimitsFromEnv({ CUSTODY_LIMIT_XRP_TX_DROPS: "5000000", CUSTODY_NEW_RECIPIENT_MAX_EVM_WEI: "7" });
    expect(l.xrpTxDrops).toBe(5_000_000n);
    expect(l.xrpNewRecipientDrops).toBe(5_000_000n);
    expect(l.evmNewRecipientWei).toBe(7n);
  });
  it("refuses values that are not positive whole numbers", () => {
    for (const bad of ["0", "-5", "1.5", "abc", "1e6", "0x10"]) {
      expect(() => custodyLimitsFromEnv({ CUSTODY_LIMIT_XRP_DAY_DROPS: bad })).toThrow(/CUSTODY_LIMIT_XRP_DAY_DROPS/);
    }
    expect(() => custodyLimitsFromEnv({ CUSTODY_NEW_RECIPIENT_MAX_XRP_DROPS: "0" })).toThrow(/CUSTODY_NEW_RECIPIENT_MAX_XRP_DROPS/);
  });
});

describe('mainnet defaults', () => {
  const main = { STELLAR_NETWORK: 'public', MAINNET_CUSTODY: 'on' };
  it('are lower, and still overridable from env', () => {
    const l = custodyLimitsFromEnv(main);
    expect(l.xrpTxDrops).toBe(5n * XRP);
    expect(l.xrpDayDrops).toBe(20n * XRP);
    expect(l.evmTxWei).toBe(2_000_000_000_000_000n);
    expect(l.evmDayWei).toBe(10_000_000_000_000_000n);
    expect(l.xlmTxStroops).toBe(100_000_000n);
    expect(l.xrpNewRecipientDrops).toBe(5n * XRP);
    expect(custodyLimitsFromEnv({ ...main, CUSTODY_LIMIT_XRP_TX_DROPS: '7' }).xrpTxDrops).toBe(7n);
    expect(custodyLimitsFromEnv({ ...main, CUSTODY_LIMIT_XLM_TX_STROOPS: '9' }).xlmTxStroops).toBe(9n);
  });
  it('are not used on testnet, where there is no Stellar cap', () => {
    expect(custodyLimitsFromEnv({}).xlmTxStroops).toBeUndefined();
    expect(custodyLimitsFromEnv({ STELLAR_NETWORK: 'public' }).xrpTxDrops).toBe(100n * XRP);
  });
});

describe("evmMaxFeeGwei", () => {
  it("defaults to 100 gwei, reads CUSTODY_EVM_MAX_FEE_GWEI, and must be a positive whole number", () => {
    expect(custodyLimitsFromEnv({}).evmMaxFeeWei).toBe(100_000_000_000n);
    expect(custodyLimitsFromEnv({ CUSTODY_EVM_MAX_FEE_GWEI: "30" }).evmMaxFeeWei).toBe(30_000_000_000n);
    for (const bad of ["0", "-1", "1.5", "x"]) expect(() => custodyLimitsFromEnv({ CUSTODY_EVM_MAX_FEE_GWEI: bad })).toThrow(/CUSTODY_EVM_MAX_FEE_GWEI/);
  });
});

describe("checkXrpLimits", () => {
  const l = custodyLimitsFromEnv({});
  it("allows an amount within every cap, including exactly at the caps", () => {
    expect(checkXrpLimits(l, { amount: 100n * XRP, sentToday: 400n * XRP, newRecipient: true })).toBeNull();
  });
  it("refuses over the per-transaction cap", () => {
    expect(checkXrpLimits(l, { amount: 100n * XRP + 1n, sentToday: 0n, newRecipient: false })).toMatchObject({ status: 403, limit: "tx" });
  });
  it("refuses when today's total would pass the daily cap", () => {
    const r = checkXrpLimits(l, { amount: 100n * XRP, sentToday: 401n * XRP, newRecipient: false });
    expect(r).toMatchObject({ status: 403, limit: "day" });
    expect(r!.error).toContain("500 XRP");
  });
  it("refuses a first payment to a new address over the new-recipient cap", () => {
    const small = custodyLimitsFromEnv({ CUSTODY_NEW_RECIPIENT_MAX_XRP_DROPS: "10000000" });
    expect(checkXrpLimits(small, { amount: 20n * XRP, sentToday: 0n, newRecipient: true })).toMatchObject({ limit: "new_recipient" });
    expect(checkXrpLimits(small, { amount: 20n * XRP, sentToday: 0n, newRecipient: false })).toBeNull();
  });
});

describe("checkEvmLimits", () => {
  const l = custodyLimitsFromEnv({});
  it("applies the wei caps", () => {
    expect(checkEvmLimits(l, { amount: 50_000_000_000_000_000n, sentToday: 150_000_000_000_000_000n, newRecipient: false })).toBeNull();
    expect(checkEvmLimits(l, { amount: 50_000_000_000_000_001n, sentToday: 0n, newRecipient: false })).toMatchObject({ limit: "tx" });
    expect(checkEvmLimits(l, { amount: 50_000_000_000_000_000n, sentToday: 150_000_000_000_000_001n, newRecipient: false })).toMatchObject({ limit: "day" });
    expect(checkEvmLimits(l, { amount: 1n, sentToday: 0n, newRecipient: true })).toBeNull();
  });
});

describe("foreignSourceOp (every network)", () => {
  const me = Keypair.random().publicKey(), platform = Keypair.random().publicKey();
  const ops = (...o: any[]) => { const t = new TransactionBuilder(new Account(me, "1"), { fee: "100", networkPassphrase: Networks.TESTNET }); o.forEach((x) => t.addOperation(x)); return t.setTimeout(60).build().operations as any[]; };
  it("refuses a payment op whose source is the platform wallet, or any other account", () => {
    const pay = (source?: string) => Operation.payment({ destination: me, asset: Asset.native(), amount: "1", source });
    expect(foreignSourceOp(ops(pay(platform)), me)).toMatchObject({ type: "payment", source: platform });
    expect(foreignSourceOp(ops(pay(), pay(Keypair.random().publicKey())), me)).not.toBeNull();
    expect(foreignSourceOp(ops(pay(), pay(me)), me)).toBeNull();
  });
});

describe("checkStellarTx allow-list", () => {
  const me = Keypair.random().publicKey(), x = Keypair.random().publicKey();
  const ops = (...o: any[]) => { const t = new TransactionBuilder(new Account(me, "1"), { fee: "100", networkPassphrase: Networks.PUBLIC }); o.forEach((v) => t.addOperation(v)); return t.setTimeout(60).build().operations as any[]; };
  const cap = 100_000_000n;
  it("refuses setOptions (adding a signer), contract calls, offers and liquidity pool operations", () => {
    for (const op of [
      Operation.setOptions({ signer: { ed25519PublicKey: x, weight: 255 }, masterWeight: 0 }),
      Operation.invokeContractFunction({ contract: Asset.native().contractId(Networks.PUBLIC), function: "transfer", args: [nativeToScVal(me, { type: "address" }), nativeToScVal(x, { type: "address" }), nativeToScVal(10n ** 15n, { type: "i128" })] }),
      Operation.manageBuyOffer({ selling: Asset.native(), buying: new Asset("USD", x), buyAmount: "1000000", price: "1" }),
      Operation.liquidityPoolDeposit({ liquidityPoolId: "a".repeat(64), maxAmountA: "100000", maxAmountB: "1", minPrice: "0.0000001", maxPrice: "10000000" }),
    ]) expect(checkStellarTx(cap, ops(op), { wallet: me })).toMatchObject({ status: 403 });
  });
  it("refuses a fee bid over the ceiling and many small payments adding up over the cap", () => {
    const p = Operation.payment({ destination: x, asset: Asset.native(), amount: "1" });
    expect(checkStellarTx(cap, ops(p), { wallet: me, feeStroops: 1_000_001n })).toMatchObject({ status: 403 });
    expect(checkStellarTx(cap, ops(p), { wallet: me, feeStroops: 1_000_000n })).toBeNull();
    expect(checkStellarTx(cap, ops(...Array(11).fill(0).map(() => Operation.payment({ destination: x, asset: Asset.native(), amount: "9" }))), { wallet: me })).toMatchObject({ limit: "tx" });
  });
});

describe("mainnet token caps config", () => {
  const circle = "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN";
  const zarIssuer = Keypair.random().publicKey();
  const main = { STELLAR_NETWORK: "public", MAINNET_CUSTODY: "on" };
  it("defaults to Circle's USDC with the owner's USD caps, on mainnet only", () => {
    const t = custodyLimitsFromEnv(main).tokens!;
    expect([...t.keys()]).toEqual([`USDC:${circle}`]);
    expect(t.get(`USDC:${circle}`)).toMatchObject({ cls: "usd", txUnits: 10_000_000n, dayUnits: 50_000_000n });
    expect(DEFAULT_MAINNET_TOKEN_CAPS).toBe(`USDC:${circle}:usd`);
    expect(custodyLimitsFromEnv({}).tokens).toBeUndefined();
  });
  it("reads CODE:ISSUER:CLASS entries and the class caps (ZAR defaults R10 / R50) as exact decimals", () => {
    const t = parseTokenCaps({ CUSTODY_MAINNET_TOKEN_CAPS: `USDC:${circle}:usd, ZARP:${zarIssuer}:zar`, CUSTODY_CAP_USD_TX: "0.5", CUSTODY_CAP_USD_DAY: "2.0000001" });
    expect(t.get(`USDC:${circle}`)).toMatchObject({ txUnits: 5_000_000n, dayUnits: 20_000_001n });
    expect(t.get(`ZARP:${zarIssuer}`)).toMatchObject({ cls: "zar", txUnits: 100_000_000n, dayUnits: 500_000_000n });
    expect(parseTokenCaps({ CUSTODY_MAINNET_TOKEN_CAPS: "none" }).size).toBe(0);
  });
  it("fails start-up on malformed config", () => {
    for (const bad of ["USDC", `USDC:${circle}`, `USDC:${circle}:eur`, `USDC:${circle}:USD`, "USDC:GBAD:usd", `US DC:${circle}:usd`, `USDC:${circle}:usd,USDC:${circle}:usd`, `USDC:${circle}:usd,`, `:${circle}:usd`, `TOOLONGCODE123:${circle}:usd`])
      expect(() => parseTokenCaps({ CUSTODY_MAINNET_TOKEN_CAPS: bad }), bad).toThrow(/CUSTODY_MAINNET_TOKEN_CAPS/);
    for (const bad of ["0", "-1", "1e3", "1.12345678", "x", " ", "1,5", ".5"]) expect(() => parseTokenCaps({ CUSTODY_CAP_USD_DAY: bad }), bad).toThrow(/CUSTODY_CAP_USD_DAY/);
    expect(() => custodyLimitsFromEnv({ ...main, CUSTODY_CAP_ZAR_TX: "abc" })).toThrow(/CUSTODY_CAP_ZAR_TX/);
    expect(parseDecimal7("10.0000001", "X")).toBe(100_000_001n);
  });
});

describe("checkStellarTx token rules", () => {
  const me = Keypair.random().publicKey(), x = Keypair.random().publicKey();
  const circle = "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN";
  const usdc = new Asset("USDC", circle);
  const ops = (...o: any[]) => { const t = new TransactionBuilder(new Account(me, "1"), { fee: "100", networkPassphrase: Networks.PUBLIC }); o.forEach((v) => t.addOperation(v)); return t.setTimeout(60).build().operations as any[]; };
  const cap = 100_000_000n;
  const tokens = custodyLimitsFromEnv({ STELLAR_NETWORK: "public", MAINNET_CUSTODY: "on" }).tokens!;
  const ctx = { wallet: me, tokens };
  const refused = { status: 403, limit: "tx", error: TOKEN_REFUSED_ERROR };
  it("allows an allow-listed token within its per-transaction cap", () => {
    expect(checkStellarTx(cap, ops(Operation.payment({ destination: x, asset: usdc, amount: "1" })), ctx)).toBeNull();
    expect(TOKEN_REFUSED_ERROR).toBe("This token can't be sent from an Amma-held wallet yet.");
  });
  it("refuses over the per-transaction cap, also when several operations add up", () => {
    expect(checkStellarTx(cap, ops(Operation.payment({ destination: x, asset: usdc, amount: "1.0000001" })), ctx)).toMatchObject({ limit: "tx", error: "That is more than the 1 USD limit for one payment. This limit includes the Amma fee." });
    expect(checkStellarTx(cap, ops(...Array(2).fill(0).map(() => Operation.payment({ destination: x, asset: usdc, amount: "0.6" }))), ctx)).toMatchObject({ limit: "tx" });
  });
  it("refuses an unknown token, a lookalike with another issuer, and any token when no list is given", () => {
    expect(checkStellarTx(cap, ops(Operation.payment({ destination: x, asset: new Asset("USDC", x), amount: "0.1" })), ctx)).toEqual(refused);
    expect(checkStellarTx(cap, ops(Operation.payment({ destination: x, asset: new Asset("FOO", circle), amount: "0.1" })), ctx)).toEqual(refused);
    expect(checkStellarTx(cap, ops(Operation.payment({ destination: x, asset: usdc, amount: "0.1" })), { wallet: me })).toEqual(refused);
  });
  it("shares one per-transaction cap across all tokens of a class (usd, zar)", () => {
    const usdx = new Asset("USDX", x), zarp = new Asset("ZARP", x);
    const two = custodyLimitsFromEnv({ STELLAR_NETWORK: "public", MAINNET_CUSTODY: "on", CUSTODY_MAINNET_TOKEN_CAPS: `USDC:${circle}:usd,USDX:${x}:usd,ZARP:${x}:zar` }).tokens!;
    const c2 = { wallet: me, tokens: two };
    expect(checkStellarTx(cap, ops(Operation.payment({ destination: x, asset: usdc, amount: "0.6" }), Operation.payment({ destination: x, asset: usdx, amount: "0.6" })), c2)).toMatchObject({ limit: "tx", error: "That is more than the 1 USD limit for one payment. This limit includes the Amma fee." });
    expect(checkStellarTx(cap, ops(Operation.payment({ destination: x, asset: usdc, amount: "0.5" }), Operation.payment({ destination: x, asset: usdx, amount: "0.5" })), c2)).toBeNull();
    // Different classes do not share: $1 plus R10 in one transaction is fine.
    expect(checkStellarTx(cap, ops(Operation.payment({ destination: x, asset: usdc, amount: "1" }), Operation.payment({ destination: x, asset: zarp, amount: "10" })), c2)).toBeNull();
    expect(checkStellarTx(cap, ops(Operation.payment({ destination: x, asset: zarp, amount: "10.0000001" })), c2)).toMatchObject({ error: "That is more than the 10 ZAR limit for one payment. This limit includes the Amma fee." });
  });
  it("treats asset codes as case-sensitive: usdc is not USDC", () => {
    expect(checkStellarTx(cap, ops(Operation.payment({ destination: x, asset: new Asset("usdc", circle), amount: "0.1" })), ctx)).toEqual(refused);
  });
  it("counts a path payment by its source asset (sendAmount / sendMax), not the destination asset", () => {
    const send = Operation.pathPaymentStrictSend({ sendAsset: usdc, sendAmount: "2", destination: x, destAsset: Asset.native(), destMin: "0.1" });
    const recv = Operation.pathPaymentStrictReceive({ sendAsset: usdc, sendMax: "2", destination: x, destAsset: Asset.native(), destAmount: "0.1" });
    expect(checkStellarTx(cap, ops(send), ctx)).toMatchObject({ limit: "tx", error: expect.stringMatching(/1 USD limit/) });
    expect(checkStellarTx(cap, ops(recv), ctx)).toMatchObject({ limit: "tx" });
    expect(checkStellarTx(cap, ops(Operation.pathPaymentStrictSend({ sendAsset: usdc, sendAmount: "0.5", destination: x, destAsset: Asset.native(), destMin: "0.1" })), ctx)).toBeNull();
    // Receiving an unlisted token while spending XLM is not a token outflow.
    expect(checkStellarTx(cap, ops(Operation.pathPaymentStrictSend({ sendAsset: Asset.native(), sendAmount: "1", destination: x, destAsset: new Asset("FOO", x), destMin: "0.1" })), ctx)).toBeNull();
    expect([...tokenOutflows(ops(send, recv))]).toEqual([[`USDC:${circle}`, 40_000_000n]]);
  });
  it("keeps allowing changeTrust (also for unlisted tokens, and limit 0) and the native rules", () => {
    expect(checkStellarTx(cap, ops(Operation.changeTrust({ asset: new Asset("FOO", x) }), Operation.changeTrust({ asset: usdc, limit: "0" })), ctx)).toBeNull();
    expect(checkStellarTx(cap, ops(Operation.payment({ destination: x, asset: Asset.native(), amount: "10" })), { wallet: me })).toBeNull();
    expect(checkStellarTx(cap, ops(Operation.payment({ destination: x, asset: Asset.native(), amount: "10.0000001" })), { wallet: me })).toMatchObject({ limit: "tx" });
  });
});
