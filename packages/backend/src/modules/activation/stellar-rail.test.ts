import { describe, expect, it } from "vitest";
import { Account, Keypair, Networks, Operation, TransactionBuilder } from "@stellar/stellar-sdk";
import { assertHorizonNetwork, horizonRail, TX_VALID_SECONDS, type HorizonLike } from "./stellar-rail";

const treasury = Keypair.random();
const destination = Keypair.random().publicKey();
const response = (status: number, codes?: object) => Object.assign(new Error(`Request failed with status code ${status}`), { response: { status, data: codes ? { extras: { result_codes: codes } } : {} } });
const server = (over: Partial<HorizonLike> = {}): HorizonLike => ({
  loadAccount: async () => Object.assign(new Account(treasury.publicKey(), "4242"), { balances: [{ asset_type: "native", balance: "250.5000000" }] }),
  submitTransaction: async () => ({}),
  transactions: () => ({ transaction: () => ({ call: async () => ({ successful: true }) }) }),
  ledgers: () => ({ order: () => ({ limit: () => ({ call: async () => ({ records: [{ closed_at: "2026-11-16T10:00:00Z" }] }) }) }) }),
  ...over,
});
const rail = (s = server()) => horizonRail(s, treasury.secret(), Networks.TESTNET);

describe("horizonRail.buildPayment (fee sweeps)", () => {
  it("builds one signed XLM payment, or a createAccount for a new address, for exactly the amount", async () => {
    const now = 1_800_000_000;
    const pay = await rail().buildPayment!(destination, 2_000_000_000n, now, false);
    const tx: any = TransactionBuilder.fromXDR(pay.envelope, Networks.TESTNET);
    expect(tx.operations).toEqual([expect.objectContaining({ type: "payment", destination, amount: "200.0000000" })]);
    expect(tx.operations[0].asset.isNative()).toBe(true);
    expect(tx.source).toBe(treasury.publicKey());
    expect(tx.timeBounds).toEqual({ minTime: "0", maxTime: String(now + TX_VALID_SECONDS) });
    expect(tx.hash().toString("hex")).toBe(pay.hash);
    expect(treasury.verify(tx.hash(), tx.signatures[0].signature())).toBe(true);
    const create: any = TransactionBuilder.fromXDR((await rail().buildPayment!(destination, 2_000_000_000n, now, true)).envelope, Networks.TESTNET);
    expect(create.operations[0]).toMatchObject({ type: "createAccount", destination, startingBalance: "200.0000000" });
  });
});

describe("horizonRail.build", () => {
  it("builds one signed createAccount of exactly the grant, valid for two minutes, with a known hash", async () => {
    const now = 1_800_000_000;
    const built = await rail().build(destination, 11_000_000n, now);
    expect(built.maxTime).toBe(now + TX_VALID_SECONDS);
    const tx: any = TransactionBuilder.fromXDR(built.envelope, Networks.TESTNET);
    expect(tx.operations).toHaveLength(1);
    expect(tx.operations[0]).toMatchObject({ type: "createAccount", destination, startingBalance: "1.1000000" });
    expect(tx.source).toBe(treasury.publicKey());
    expect(tx.operations[0].source).toBeUndefined();
    expect(tx.timeBounds).toEqual({ minTime: "0", maxTime: String(now + 120) });
    expect(tx.sequence).toBe("4243");
    expect(tx.fee).toBe("100");
    expect(tx.memo.type).toBe("none");
    expect(tx.hash().toString("hex")).toBe(built.hash);
    expect(tx.signatures).toHaveLength(1);
    expect(treasury.verify(tx.hash(), tx.signatures[0].signature())).toBe(true);
    expect(built.envelope).not.toContain(treasury.secret());
  });
  it("uses the amount it is given, down to the stroop", async () => {
    const tx: any = TransactionBuilder.fromXDR((await rail().build(destination, 12_345_678n, 1_800_000_000)).envelope, Networks.TESTNET);
    expect(tx.operations[0].startingBalance).toBe("1.2345678");
  });
  it("derives its address from the secret and never exposes the secret", () => {
    const r = rail();
    expect(r.treasuryAddress).toBe(treasury.publicKey());
    expect(JSON.stringify(Object.entries(r).map(([k, v]) => [k, typeof v === "function" ? "fn" : v]))).not.toContain(treasury.secret());
  });
});

describe("horizonRail.submit", () => {
  const build = async (r = rail()) => (await r.build(destination, 11_000_000n, Math.floor(Date.now() / 1000))).envelope;
  it("accepts", async () => { const r = rail(); expect(await r.submit(await build(r))).toEqual({ accepted: true }); });
  it.each([
    [{ transaction: "tx_failed", operations: ["op_already_exists"] }, "already-exists"],
    [{ transaction: "tx_bad_seq" }, "bad-seq"],
    [{ transaction: "tx_too_late" }, "too-late"],
    [{ transaction: "tx_insufficient_fee" }, "fee"],
    [{ transaction: "tx_failed", operations: ["op_underfunded"] }, "treasury-underfunded"],
    [{ transaction: "tx_failed", operations: ["op_low_reserve"] }, "low-reserve"],
    [{ transaction: "tx_something_new" }, "rejected"],
  ])("a 400 with %j is a definitive %s", async (codes, expected) => {
    const r = rail(server({ submitTransaction: async () => { throw response(400, codes); } }));
    expect(await r.submit(await build(r))).toEqual({ accepted: false, code: expected });
  });
  it.each([[504], [500], [502], [503], [undefined]])("status %s leaves the outcome unknown and throws", async (status) => {
    const r = rail(server({ submitTransaction: async () => { throw status ? response(status) : new Error("socket hang up"); } }));
    await expect(r.submit(await build(r))).rejects.toBeTruthy();
  });
  it("a 400 without result codes is not treated as definitive", async () => {
    const r = rail(server({ submitTransaction: async () => { throw response(400); } }));
    await expect(r.submit(await build(r))).rejects.toBeTruthy();
  });
});

describe("horizonRail reads", () => {
  it("reads balances in stroops and treats 404 as no account", async () => {
    expect(await rail().treasuryStroops()).toBe(2_505_000_000n);
    expect(await rail().account(destination)).toEqual({ exists: true, stroops: 2_505_000_000n });
    const missing = rail(server({ loadAccount: async () => { throw response(404); } }));
    expect(await missing.account(destination)).toEqual({ exists: false, stroops: 0n });
    const down = rail(server({ loadAccount: async () => { throw response(503); } }));
    await expect(down.account(destination)).rejects.toBeTruthy();
    await expect(down.treasuryStroops()).rejects.toBeTruthy();
  });
  it("looks a transaction up by hash: success, failed, missing, or unknown", async () => {
    const look = (call: () => Promise<{ successful: boolean }>) => rail(server({ transactions: () => ({ transaction: () => ({ call }) }) })).lookup("abc");
    expect(await look(async () => ({ successful: true }))).toBe("success");
    expect(await look(async () => ({ successful: false }))).toBe("failed");
    expect(await look(async () => { throw response(404); })).toBe("missing");
    await expect(look(async () => { throw response(500); })).rejects.toBeTruthy();
  });
  it("requires nothing else of the SDK than createAccount", () => { expect(typeof Operation.createAccount).toBe("function"); });
});

describe("horizonRail.ledgerClosedAt", () => {
  it("returns the close time of the newest ledger in unix seconds", async () => {
    expect(await rail().ledgerClosedAt()).toBe(Date.parse("2026-11-16T10:00:00Z") / 1000);
  });
  it("asks for the newest ledger only, and throws when there is none or Horizon fails", async () => {
    const seen: unknown[] = [];
    const s = server({ ledgers: () => ({ order: (d) => { seen.push(d); return { limit: (n) => { seen.push(n); return { call: async () => ({ records: [] }) }; } }; } }) });
    await expect(rail(s).ledgerClosedAt()).rejects.toBeTruthy();
    expect(seen).toEqual(["desc", 1]);
    await expect(rail(server({ ledgers: () => { throw response(503); } })).ledgerClosedAt()).rejects.toBeTruthy();
  });
});

describe("assertHorizonNetwork", () => {
  const serves = (passphrase: unknown, ok = true) => (async () => ({ ok, json: async () => ({ network_passphrase: passphrase }) })) as unknown as typeof fetch;
  it("passes when Horizon serves the expected network", async () => {
    await expect(assertHorizonNetwork("https://horizon-testnet.stellar.org/", Networks.TESTNET, serves(Networks.TESTNET))).resolves.toBeUndefined();
  });
  it("refuses a Horizon on the other network, in both directions", async () => {
    await expect(assertHorizonNetwork("https://h", Networks.PUBLIC, serves(Networks.TESTNET))).rejects.toThrow("different Stellar network");
    await expect(assertHorizonNetwork("https://h", Networks.TESTNET, serves(Networks.PUBLIC))).rejects.toThrow("different Stellar network");
  });
  it("fails closed when it cannot tell: HTTP error, network error, missing field, bad JSON", async () => {
    await expect(assertHorizonNetwork("https://h", Networks.TESTNET, serves(Networks.TESTNET, false))).rejects.toThrow("could not confirm");
    await expect(assertHorizonNetwork("https://h", Networks.TESTNET, (async () => { throw new Error("ECONNREFUSED https://h secret"); }) as unknown as typeof fetch)).rejects.toThrow("could not confirm");
    await expect(assertHorizonNetwork("https://h", Networks.TESTNET, serves(undefined))).rejects.toThrow("different Stellar network");
    await expect(assertHorizonNetwork("https://h", Networks.TESTNET, (async () => ({ ok: true, json: async () => { throw new Error("bad"); } })) as unknown as typeof fetch)).rejects.toThrow("could not confirm");
  });
  it("asks the root of the configured URL and puts nothing from the answer in the error", async () => {
    let url = "";
    const f = (async (u: string) => { url = u; return { ok: true, json: async () => ({ network_passphrase: "Some Other Network ; secret-ish" }) }; }) as unknown as typeof fetch;
    const error = await assertHorizonNetwork("https://h.example/", Networks.TESTNET, f).catch((e) => e as Error);
    expect(url).toBe("https://h.example/");
    expect((error as Error).message).not.toContain("secret-ish");
  });
});
