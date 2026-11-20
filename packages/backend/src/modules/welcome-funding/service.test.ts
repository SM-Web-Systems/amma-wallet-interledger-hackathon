import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import { legacyDatabase, migrate } from "../../db/migrations/chain-storage.test-support";
import { applyKeyEscrow } from "../../db/migrations/key-escrow";
import { applyCustody } from "../../db/migrations/custody";
import { applyCustodyV2 } from "../../db/migrations/custody-v2";
import type { CustodyFlags } from "../../lib/custody-flags";
import { setAppLogger } from "../../lib/app-log";
import { drizzle } from "drizzle-orm/pglite";
import { WelcomeFunding, drizzleWelcomeDb, welcomeAdaptersFromEnv, type FundingAdapter } from "./service";
import { sepoliaDrip, TreasuryLow, type SepoliaClients } from "./sepolia-drip";
import { stellarFriendbot } from "./stellar-friendbot";
import { xrplFaucet } from "./xrpl-faucet";

const TREASURY_KEY = "0x" + "ab".repeat(32);
const flags: CustodyFlags = { serverSigning: true, welcomeFunding: true, sepoliaWei: 10n ** 16n, dailyCap: 50 };
let pg: PGlite;
let clock = new Date("2026-11-14T10:00:00Z");
const db: any = {
  query: async (sql: string, params?: unknown[]) => (await pg.query(sql, params as any[])).rows as any[],
  transaction: (fn: any) => pg.transaction((t) => fn({ query: async (sql: string, params?: unknown[]) => (await t.query(sql, params as any[])).rows })),
};
const rowsOf = async () => (await pg.query("SELECT * FROM welcome_funding ORDER BY user_id, chain")).rows as any[];

const W = { stellar: "GSTELLAR1", xrpl: "rXRPL1", evm: "0xEVM1" };
const W2 = { ...W, evm: "0xEVM2" };
const mkAdapter = (chain: FundingAdapter["chain"]) => ({ chain, fund: vi.fn(async (a: string) => ({ amount: "1 X", reference: `ref-${chain}-${a}` })) });
let adapters: ReturnType<typeof mkAdapter>[];
const svc = (f = flags) => new WelcomeFunding({ adapters, flags: f, db, now: () => clock });
const calls = () => adapters.reduce((n, a) => n + a.fund.mock.calls.length, 0);

beforeAll(async () => {
  pg = await legacyDatabase(); await migrate(pg);
  const conn = { execute: async (s: string) => { await pg.exec(s); }, rows: async (s: string) => (await pg.query(s)).rows as any };
  await applyKeyEscrow(conn); await applyCustody(conn); await applyCustodyV2(conn);
}, 60000);
afterAll(async () => { await pg?.close(); });
beforeEach(async () => {
  clock = new Date("2026-11-14T10:00:00Z");
  adapters = [mkAdapter("stellar"), mkAdapter("xrpl"), mkAdapter("evm")];
  await pg.exec(`TRUNCATE welcome_funding; DELETE FROM user_wallets; UPDATE users SET is_email_verified = true;
    INSERT INTO user_wallets (user_id, chain, network, public_key, name, is_active) VALUES
      (1,'stellar','testnet','GSTELLAR1','s',true),(1,'xrpl','testnet','rXRPL1','x',true),(1,'evm','sepolia','0xEVM1','e',true),
      (1,'stellar','testnet','GOLD','old',false)`);
});

describe("WelcomeFunding", () => {
  it("funds all three testnet wallets, preferring the active one", async () => {
    await svc().enqueue(1, W);
    const rows = await rowsOf();
    expect(rows.map((r) => [r.chain, r.state, r.address])).toEqual([["evm", "sent", "0xEVM1"], ["stellar", "sent", "GSTELLAR1"], ["xrpl", "sent", "rXRPL1"]]);
    expect(rows.every((r) => r.attempts === 1 && r.reference && r.amount)).toBe(true);
  });

  it("makes no adapter calls on a second run", async () => {
    await svc().enqueue(1, W); const first = calls(); await svc().enqueue(1, W); await svc().retry(1);
    expect(first).toBe(3); expect(calls()).toBe(3);
  });

  it("marks a throwing adapter failed with a short code, then retries after an hour", async () => {
    adapters[0].fund.mockRejectedValueOnce(new Error("raw faucet body <html>secret</html>"));
    await svc().enqueue(1, W);
    let stellar = (await rowsOf()).find((r) => r.chain === "stellar");
    expect(stellar).toMatchObject({ state: "failed", error: "faucet-unavailable", attempts: 1 });
    clock = new Date(clock.getTime() + 30 * 60_000); await svc().enqueue(1, W);
    expect((await rowsOf()).find((r) => r.chain === "stellar")!.state).toBe("failed");
    clock = new Date(clock.getTime() + 31 * 60_000); await svc().enqueue(1, W);
    stellar = (await rowsOf()).find((r) => r.chain === "stellar");
    expect(stellar).toMatchObject({ state: "sent", error: null, attempts: 2 });
  });

  it("finds a timeout in the cause chain", async () => {
    adapters[0].fund.mockRejectedValueOnce(Object.assign(new Error("wrapped"), { cause: Object.assign(new Error("t"), { name: "TimeoutError" }) }));
    const rec: string[] = []; setAppLogger({ info: (o, m) => rec.push(JSON.stringify([o, m])), warn: (o, m) => rec.push(JSON.stringify([o, m])), error: (o, m) => rec.push(JSON.stringify([o, m])) });
    await svc().enqueue(1, W);
    expect((await rowsOf()).find((r) => r.chain === "stellar")).toMatchObject({ state: "failed", error: "timeout" });
    expect(JSON.stringify(rec)).not.toContain("wrapped");
    setAppLogger(null);
  });

  it("maps timeouts and treasury-low to short codes and stops after 3 attempts", async () => {
    const t = Object.assign(new Error("x"), { name: "TimeoutError" });
    adapters[1].fund.mockRejectedValue(t); adapters[2].fund.mockRejectedValue(new TreasuryLow());
    for (let i = 0; i < 4; i++) { await svc().enqueue(1, W); clock = new Date(clock.getTime() + 2 * 3_600_000); }
    const rows = await rowsOf();
    expect(rows.find((r) => r.chain === "xrpl")).toMatchObject({ state: "failed", error: "timeout", attempts: 3 });
    expect(rows.find((r) => r.chain === "evm")).toMatchObject({ state: "failed", error: "treasury-low", attempts: 3 });
  });

  it("caps only the Sepolia treasury, and retries a cap skip after 24 hours", async () => {
    await pg.query(`INSERT INTO welcome_funding (user_id, chain, address, state, created_at, updated_at) VALUES (2,'evm','0xOTHER','sent',$1,$1)`, [new Date(clock.getTime() - 3_600_000)]);
    await svc({ ...flags, dailyCap: 1 }).enqueue(1, W);
    let rows = (await rowsOf()).filter((r) => r.user_id === 1);
    expect(rows.find((r) => r.chain === "evm")).toMatchObject({ state: "skipped", error: "daily-cap", attempts: 0 });
    expect(rows.filter((r) => r.chain !== "evm").every((r) => r.state === "sent")).toBe(true);
    expect(adapters[2].fund).not.toHaveBeenCalled();
    clock = new Date(clock.getTime() + 23 * 3_600_000); await svc({ ...flags, dailyCap: 1 }).enqueue(1, W);
    expect((await rowsOf()).find((r) => r.user_id === 1 && r.chain === "evm")!.state).toBe("skipped");
    clock = new Date(clock.getTime() + 2 * 3_600_000); await svc({ ...flags, dailyCap: 1 }).enqueue(1, W);
    rows = (await rowsOf()).filter((r) => r.user_id === 1);
    expect(rows.find((r) => r.chain === "evm")).toMatchObject({ state: "sent", attempts: 1 });
  });

  it("does not let overlapping runs exceed the Sepolia cap", async () => {
    await pg.exec(`INSERT INTO user_wallets (user_id, chain, network, public_key, name, is_active) VALUES (2,'evm','sepolia','0xEVM2','e',true)`);
    await Promise.all([svc({ ...flags, dailyCap: 1 }).enqueue(1, W), svc({ ...flags, dailyCap: 1 }).enqueue(2, W2)]);
    const evm = (await rowsOf()).filter((r) => r.chain === "evm");
    expect(evm.filter((r) => r.state === "sent")).toHaveLength(1);
    expect(adapters[2].fund).toHaveBeenCalledTimes(1);
  });

  it("skips unverified email without calls and funds once verified", async () => {
    await pg.exec("UPDATE users SET is_email_verified = false WHERE id = 1");
    await svc().enqueue(1, W);
    expect((await rowsOf()).map((r) => [r.state, r.error, r.attempts])).toEqual(Array(3).fill(["skipped", "email-unverified", 0]));
    expect(calls()).toBe(0);
    await pg.exec("UPDATE users SET is_email_verified = true WHERE id = 1");
    await svc().enqueue(1, W);
    expect((await rowsOf()).every((r) => r.state === "sent")).toBe(true);
  });

  it("funds only the addresses it is given, not other wallets the user added", async () => {
    await svc().enqueue(1, { stellar: "GCUSTODY", xrpl: "rCUSTODY", evm: "0xCUSTODY" });
    expect((await rowsOf()).map((r) => r.address).sort()).toEqual(["0xCUSTODY", "GCUSTODY", "rCUSTODY"]);
    expect(adapters[0].fund).toHaveBeenCalledWith("GCUSTODY");
  });

  it("retry never inserts rows, and processes existing failed rows", async () => {
    await svc().retry(1);
    expect(await rowsOf()).toEqual([]); expect(calls()).toBe(0);
    adapters[0].fund.mockRejectedValueOnce(new Error("x"));
    await svc().enqueue(1, W);
    clock = new Date(clock.getTime() + 2 * 3_600_000); await svc().retry(1);
    expect((await rowsOf()).find((r) => r.chain === "stellar")).toMatchObject({ state: "sent", attempts: 2 });
  });

  it("skips a chain with no adapter as not-configured", async () => {
    adapters = adapters.slice(0, 2);
    await svc().enqueue(1, W);
    expect((await rowsOf()).find((r) => r.chain === "evm")).toMatchObject({ state: "skipped", error: "not-configured" });
  });

  it("never throws to the caller and logs nothing sensitive", async () => {
    const rec: string[] = []; setAppLogger({ info: (o, m) => rec.push(JSON.stringify([o, m])), warn: (o, m) => rec.push(JSON.stringify([o, m])), error: (o, m) => rec.push(JSON.stringify([o, m])) });
    const broken = new WelcomeFunding({ adapters, flags, db: { query: async () => { throw new Error("db password=hunter2"); } } });
    await expect(broken.retry(1)).resolves.toBeUndefined();
    await expect(broken.enqueue(1, W)).resolves.toBeUndefined();
    expect(JSON.stringify(rec)).not.toContain("hunter2");
    expect(JSON.stringify(rec)).toContain("internal");
    setAppLogger(null);
  });
});

describe("sepolia drip", () => {
  const clients = (balance: bigint): SepoliaClients & { sent: any[] } => {
    const sent: any[] = [];
    return { sent, treasury: "0x0000000000000000000000000000000000000001", getBalance: async () => balance, sendTransaction: async (a) => { sent.push(a); return "0xhash"; } };
  };
  it("sends exactly the configured wei and returns the tx hash", async () => {
    const c = clients(10n ** 18n); const warn = vi.fn();
    const r = await sepoliaDrip(c, 10n ** 16n, warn).fund("0xabc");
    expect(c.sent).toEqual([{ to: "0xabc", value: 10n ** 16n }]);
    expect(r.reference).toBe("0xhash"); expect(warn).not.toHaveBeenCalled();
  });
  it("warns with the balance in ETH only when low, and refuses when below 2x", async () => {
    const warn = vi.fn();
    await sepoliaDrip(clients(10n ** 17n), 10n ** 16n, warn).fund("0xabc");
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("welcome_funding_treasury_low"));
    expect(warn.mock.calls[0][0]).toContain("ETH");
    const c = clients(10n ** 16n);
    await expect(sepoliaDrip(c, 10n ** 16n, warn).fund("0xabc")).rejects.toBeInstanceOf(TreasuryLow);
    expect(c.sent).toHaveLength(0);
  });
});

describe("http adapters", () => {
  it("friendbot uses the hash and never keeps the body", async () => {
    const f = vi.fn(async () => new Response(JSON.stringify({ hash: "abc", junk: "x" }), { status: 200 }));
    expect(await stellarFriendbot(f as any).fund("GADDR")).toEqual({ amount: "10000 XLM", reference: "abc" });
    expect(String((f.mock.calls[0] as any[])[0])).toBe("https://friendbot.stellar.org?addr=GADDR");
    const bad = vi.fn(async () => new Response("<html>nope</html>", { status: 500 }));
    await expect(stellarFriendbot(bad as any).fund("G")).rejects.toThrow("faucet-unavailable");
  });
  it("xrpl faucet reads amount and transactionHash with fallbacks", async () => {
    const f = vi.fn(async () => new Response(JSON.stringify({ amount: 100, transactionHash: "TX" }), { status: 200 }));
    expect(await xrplFaucet(f as any).fund("rAddr")).toEqual({ amount: "100", reference: "TX" });
    const f2 = vi.fn(async () => new Response(JSON.stringify({ hash: "H" }), { status: 200 }));
    expect(await xrplFaucet(f2 as any).fund("rAddr")).toEqual({ amount: "testnet XRP", reference: "H" });
    const call = f.mock.calls[0] as any[];
    expect(call[0]).toBe("https://faucet.altnet.rippletest.net/accounts"); expect(JSON.parse(call[1].body)).toEqual({ destination: "rAddr" });
  });
});

describe("adapter factory", () => {
  it("omits sepolia unless both variables are set", () => {
    expect(welcomeAdaptersFromEnv({}, flags).map((a) => a.chain)).toEqual(["stellar", "xrpl"]);
    expect(welcomeAdaptersFromEnv({ WELCOME_SEPOLIA_RPC_URL: "http://x" }, flags).map((a) => a.chain)).toEqual(["stellar", "xrpl"]);
    expect(welcomeAdaptersFromEnv({ WELCOME_SEPOLIA_RPC_URL: "http://x", WELCOME_SEPOLIA_TREASURY_KEY: TREASURY_KEY }, flags).map((a) => a.chain)).toEqual(["stellar", "xrpl", "evm"]);
  });
  it("rejects a malformed treasury key without echoing it", () => {
    const bad = "not-a-key-SECRETVALUE";
    let msg = "";
    try { welcomeAdaptersFromEnv({ WELCOME_SEPOLIA_RPC_URL: "http://x", WELCOME_SEPOLIA_TREASURY_KEY: bad }, flags); } catch (e) { msg = (e as Error).message; }
    expect(msg).toBeTruthy(); expect(msg).not.toContain("SECRETVALUE");
  });
  it("never puts the treasury key in a row or a log line, even when the network fails", async () => {
    const rec: string[] = []; setAppLogger({ info: (o, m) => rec.push(JSON.stringify([o, m])), warn: (o, m) => rec.push(JSON.stringify([o, m])), error: (o, m) => rec.push(JSON.stringify([o, m])) });
    const spies = (["log", "warn", "error", "info", "debug"] as const).map((m) => vi.spyOn(console, m).mockImplementation(() => {}));
    const rpc = (method: string): unknown => ({
      eth_chainId: "0xaa36a7", eth_getBalance: "0x" + (10n ** 20n).toString(16), eth_getTransactionCount: "0x1", eth_gasPrice: "0x3b9aca00",
      eth_estimateGas: "0x5208", eth_maxPriorityFeePerGas: "0x3b9aca00",
      eth_getBlockByNumber: { number: "0x1", hash: "0x" + "11".repeat(32), parentHash: "0x" + "00".repeat(32), timestamp: "0x1", baseFeePerGas: "0x3b9aca00", gasLimit: "0x1c9c380", gasUsed: "0x0", miner: "0x" + "00".repeat(20), transactions: [], nonce: "0x0000000000000000", difficulty: "0x0", totalDifficulty: "0x0", extraData: "0x", size: "0x1", sha3Uncles: "0x" + "00".repeat(32), stateRoot: "0x" + "00".repeat(32), receiptsRoot: "0x" + "00".repeat(32), transactionsRoot: "0x" + "00".repeat(32), logsBloom: "0x" + "00".repeat(256), mixHash: "0x" + "00".repeat(32), uncles: [] },
    } as Record<string, unknown>)[method];
    const seen: string[] = [];
    const answer = (req: any) => {
      seen.push(req.method);
      if (req.method === "eth_sendRawTransaction") return { jsonrpc: "2.0", id: req.id, error: { code: -32000, message: "connect refused" } };
      return { jsonrpc: "2.0", id: req.id, result: rpc(req.method) };
    };
    const fetchStub = vi.fn(async (_u: any, init: any) => {
      const req = JSON.parse(init?.body ?? "{}");
      return new Response(JSON.stringify(Array.isArray(req) ? req.map(answer) : answer(req)), { status: 200, headers: { "content-type": "application/json" } });
    });
    vi.stubGlobal("fetch", fetchStub);
    try {
      const real = welcomeAdaptersFromEnv({ WELCOME_SEPOLIA_RPC_URL: "http://127.0.0.1:9/", WELCOME_SEPOLIA_TREASURY_KEY: TREASURY_KEY }, flags);
      await new WelcomeFunding({ adapters: real, flags, db, now: () => clock }).enqueue(1, { ...W, evm: "0x" + "12".repeat(20) });
      const all = JSON.stringify(spies.flatMap((x) => x.mock.calls)) + JSON.stringify(rec) + JSON.stringify(await rowsOf());
      expect(all).not.toContain(TREASURY_KEY); expect(all).not.toContain("ab".repeat(32));
      expect((await rowsOf()).find((r) => r.chain === "evm")).toMatchObject({ state: "failed" });
      expect(seen).toContain("eth_sendRawTransaction");
    } finally { vi.unstubAllGlobals(); setAppLogger(null); spies.forEach((x) => x.mockRestore()); }
  });
});

describe("drizzle adapter", () => {
  it("runs parameterised queries over a drizzle db", async () => {
    const d = drizzleWelcomeDb(drizzle(pg) as any);
    await new WelcomeFunding({ adapters, flags, db: d, now: () => clock }).enqueue(1, W);
    expect((await rowsOf()).every((r) => r.state === "sent")).toBe(true);
    expect(await d.query("SELECT $1::int AS a, $2::text AS b", [7, "x"])).toEqual([{ a: 7, b: "x" }]);
  });
});

describe("drizzleWelcomeDb", () => {
  it("sends Date parameters as ISO strings (postgres-js does not serialise Date)", async () => {
    const seen: unknown[] = [];
    const { PgDialect } = await import("drizzle-orm/pg-core");
    const fake = { execute: async (q: any) => { seen.push(...new PgDialect().sqlToQuery(q).params); return []; } };
    const { drizzleWelcomeDb } = await import("./service");
    const when = new Date("2026-11-14T07:00:00.000Z");
    await drizzleWelcomeDb(fake as any).query("SELECT $1, $2", [when, 5]);
    expect(seen).toContain("2026-11-14T07:00:00.000Z");
    expect(seen.some((v) => v instanceof Date)).toBe(false);
  });
});
