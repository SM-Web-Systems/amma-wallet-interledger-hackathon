// @vitest-environment node
import { describe, it, expect, vi, afterEach } from "vitest";
import { StellarSdk, buildPaymentTx } from "./stellar";
import { planDestination, destinationOperation, NEW_ACCOUNT_MIN_MESSAGE, ACTIVATE_FIRST_MESSAGE } from "./destination-account";

const notFound = () => Object.assign(new Error("Not Found"), { response: { status: 404 } });
const srv = (impl: () => Promise<unknown>) => ({ loadAccount: vi.fn(impl) }) as never;
afterEach(() => vi.restoreAllMocks());

describe("planDestination", () => {
  it("pays an existing account", async () => {
    expect(await planDestination(srv(async () => ({})), "GDEST", true, "0.5")).toEqual({ kind: "payment" });
  });
  it("creates an account that does not exist, for native XLM of at least 1", async () => {
    expect(await planDestination(srv(async () => { throw notFound(); }), "GDEST", true, "1")).toEqual({ kind: "createAccount" });
    expect(await planDestination(srv(async () => { throw notFound(); }), "GDEST", true, "25.5")).toEqual({ kind: "createAccount" });
  });
  it("explains a new account needs at least 1 XLM", async () => {
    expect(await planDestination(srv(async () => { throw notFound(); }), "GDEST", true, "0.9999999"))
      .toEqual({ kind: "error", message: "A new account needs at least 1 XLM to be created." });
    expect(NEW_ACCOUNT_MIN_MESSAGE).toBe("A new account needs at least 1 XLM to be created.");
  });
  it("tells the sender a token cannot go to an account that does not exist", async () => {
    expect(await planDestination(srv(async () => { throw notFound(); }), "GDEST", false, "50"))
      .toEqual({ kind: "error", message: "The recipient must activate their account first." });
    expect(ACTIVATE_FIRST_MESSAGE).toBe("The recipient must activate their account first.");
  });
  it("falls back to a normal payment when the lookup fails for another reason (the server explains any rejection)", async () => {
    expect(await planDestination(srv(async () => { throw new Error("network down"); }), "GDEST", true, "5")).toEqual({ kind: "payment" });
  });
  it("recognises the SDK's NotFoundError", async () => {
    const err = new StellarSdk.NotFoundError("Not Found", { status: 404, title: "Resource Missing" });
    expect(await planDestination(srv(async () => { throw err; }), "GDEST", true, "5")).toEqual({ kind: "createAccount" });
  });
});

describe("destinationOperation", () => {
  const dest = StellarSdk.Keypair.random().publicKey();
  it("builds createAccount with the amount as starting balance", () => {
    const op = destinationOperation({ kind: "createAccount" }, { destination: dest, asset: StellarSdk.Asset.native(), amount: "3" }, StellarSdk.Operation);
    const tx = new StellarSdk.TransactionBuilder(new StellarSdk.Account(StellarSdk.Keypair.random().publicKey(), "1"), { fee: "100", networkPassphrase: StellarSdk.Networks.PUBLIC }).addOperation(op).setTimeout(30).build();
    expect(tx.operations[0]).toMatchObject({ type: "createAccount", destination: dest, startingBalance: "3.0000000" });
  });
  it("builds a payment otherwise", () => {
    const op = destinationOperation({ kind: "payment" }, { destination: dest, asset: StellarSdk.Asset.native(), amount: "3" }, StellarSdk.Operation);
    const tx = new StellarSdk.TransactionBuilder(new StellarSdk.Account(StellarSdk.Keypair.random().publicKey(), "1"), { fee: "100", networkPassphrase: StellarSdk.Networks.PUBLIC }).addOperation(op).setTimeout(30).build();
    expect(tx.operations[0]).toMatchObject({ type: "payment", destination: dest, amount: "3.0000000" });
  });
});

describe("buildPaymentTx to an account that does not exist yet (self-custody)", () => {
  async function run(amount: string, assetCode = "XLM") {
    const kp = StellarSdk.Keypair.random();
    const dest = StellarSdk.Keypair.random().publicKey();
    vi.spyOn(StellarSdk.Horizon.Server.prototype, "loadAccount").mockImplementation(async (id: string) => {
      if (id === dest) throw notFound();
      return Object.assign(new StellarSdk.Account(kp.publicKey(), "1"), { balances: [{ asset_type: "native", balance: "1000" }], subentry_count: 0 }) as never;
    });
    let submitted: unknown;
    vi.spyOn(StellarSdk.Horizon.Server.prototype, "submitTransaction").mockImplementation(async (tx) => { submitted = tx; return {} as never; });
    const issuer = StellarSdk.Keypair.random().publicKey();
    const done = buildPaymentTx(kp.secret(), dest, amount, assetCode, assetCode === "XLM" ? undefined : issuer);
    return { done, get tx() { return submitted as StellarSdk.Transaction; }, dest };
  }
  it("sends createAccount with the amount", async () => {
    const r = await run("5");
    await r.done;
    expect(r.tx.operations).toHaveLength(1);
    expect(r.tx.operations[0]).toMatchObject({ type: "createAccount", destination: r.dest, startingBalance: "5.0000000" });
  });
  it("refuses less than 1 XLM with the plain message, sending nothing", async () => {
    const r = await run("0.5");
    await expect(r.done).rejects.toThrow("A new account needs at least 1 XLM to be created.");
    expect(r.tx).toBeUndefined();
  });
  it("refuses a token", async () => {
    const r = await run("5", "USD");
    await expect(r.done).rejects.toThrow("The recipient must activate their account first.");
  });
});
