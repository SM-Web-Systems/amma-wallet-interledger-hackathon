import { afterAll, beforeAll, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import postgres from "postgres";
import { acceptanceUrl, assertFixture } from "./database";
import { postgresDatabase } from "../src/modules/payments/runtime";
import { PaymentStore } from "../src/modules/payments/store";

// Real PostgreSQL 16 concurrency for the Interledger customer ledger. Runs in a
// private schema of the isolated acceptance database; nothing outside it is touched.
const schema = `payacc_${randomUUID().replace(/-/g, "").slice(0, 12)}`;
const asset = { chain: "stellar" as const, network: "testnet", code: "XLM", scale: 7 };
let admin: ReturnType<typeof postgres>, pg: ReturnType<typeof postgres>, store: PaymentStore;

beforeAll(async () => {
  const url = acceptanceUrl();
  admin = postgres(url, { max: 1, onnotice: () => {} });
  await assertFixture(admin);
  await admin.unsafe(`CREATE SCHEMA ${schema}`);
  pg = postgres(url, { max: 12, onnotice: () => {}, connection: { search_path: schema, statement_timeout: 10000, lock_timeout: 5000 } });
  await pg.unsafe(readFileSync(resolve("src/db/migrations/payments-v1.sql"), "utf8"));
  store = new PaymentStore(postgresDatabase(pg));
});
afterAll(async () => {
  await pg?.end({ timeout: 5 });
  if (admin) { await admin.unsafe(`DROP SCHEMA IF EXISTS ${schema} CASCADE`); await admin.end({ timeout: 5 }); }
});

async function funded(owner: number, amount: string) {
  return store.db.transaction(async tx => {
    const customer = await store.account(tx, owner, asset);
    const clearing = await store.account(tx, 0, asset, "clearing");
    await store.transfer(tx, clearing, customer, asset, amount, `fund:${randomUUID()}`);
    return customer;
  });
}
const balance = async (id: string) => (await pg`SELECT balance::text AS b FROM payment_accounts WHERE id=${id}`)[0].b as string;
const settled = async <T>(work: Promise<T>[]) => (await Promise.allSettled(work)).map(r => r.status);

it("never overdraws a customer account under 20 concurrent reservations", async () => {
  const customer = await funded(101, "10");
  const statuses = await settled(Array.from({ length: 20 }, (_, i) => store.db.transaction(async tx => {
    const hold = await store.account(tx, 101, asset, "reserved", `leg-${i}`);
    await store.transfer(tx, customer, hold, asset, "1", `reserve:${i}`);
  })));
  expect(statuses.filter(s => s === "fulfilled")).toHaveLength(10);
  expect(await balance(customer)).toBe("0");
  const [{ held }] = await pg`SELECT coalesce(sum(balance),0)::text AS held FROM payment_accounts WHERE owner_id=101 AND kind='reserved'`;
  expect(held).toBe("10");
});

it("posts one ledger row and one debit when the same reference races on 10 connections", async () => {
  const customer = await funded(102, "100");
  const reference = `reserve:${randomUUID()}`;
  await settled(Array.from({ length: 10 }, () => store.db.transaction(async tx => {
    const hold = await store.account(tx, 102, asset, "reserved", "same-leg");
    await store.transfer(tx, customer, hold, asset, "7", reference);
  })));
  expect((await pg`SELECT count(*)::int AS n FROM payment_ledger WHERE reference=${reference}`)[0].n).toBe(1);
  expect(await balance(customer)).toBe("93");
  // A later retry with identical parameters is an idempotent no-op.
  await store.db.transaction(async tx => store.transfer(tx, customer, await store.account(tx, 102, asset, "reserved", "same-leg"), asset, "7", reference));
  expect(await balance(customer)).toBe("93");
});

it("does not deadlock on opposite-direction transfers between the same two accounts", async () => {
  const a = await funded(103, "500"), b = await funded(104, "500");
  const statuses = await settled(Array.from({ length: 40 }, (_, i) => store.db.transaction(async tx =>
    i % 2 ? store.transfer(tx, a, b, asset, "3", `ab:${i}`) : store.transfer(tx, b, a, asset, "3", `ba:${i}`))));
  expect(statuses.every(s => s === "fulfilled")).toBe(true);
  expect(BigInt(await balance(a)) + BigInt(await balance(b))).toBe(1000n);
});

it("keeps the posted ledger append-only and balanced", async () => {
  await expect(pg`UPDATE payment_ledger SET amount=amount+1`).rejects.toThrow(/append-only/);
  await expect(pg`DELETE FROM payment_ledger`).rejects.toThrow(/append-only/);
  const rows = await pg`SELECT a.id, a.balance::text AS balance,
      coalesce((SELECT sum(amount) FROM payment_ledger WHERE credit_account=a.id),0)
    - coalesce((SELECT sum(amount) FROM payment_ledger WHERE debit_account=a.id),0) AS net
    FROM payment_accounts a`;
  for (const row of rows) expect(String(row.net)).toBe(row.balance);
});

it("stores documents, assets and job bodies as JSON objects that read back as objects", async () => {
  // postgres.js serializes a string bound to a jsonb parameter as a JSON string
  // scalar, so canonical() text must not reach jsonb columns as a JS string.
  const id = randomUUID(), body = { id, amount: "1234567", asset };
  const account = await store.db.transaction(async tx => {
    await store.put(tx, "invoice", id, 7, body);
    await store.enqueue(tx, id, 7, "execution", { id });
    return store.account(tx, 7, asset);
  });
  expect(await store.get(store.db, "invoice", id, 7)).toEqual(body);
  const [types] = await pg`SELECT (SELECT jsonb_typeof(body) FROM payment_documents WHERE id=${id}) AS document,
    (SELECT jsonb_typeof(body) FROM payment_jobs WHERE id=${id}) AS job,
    (SELECT jsonb_typeof(asset) FROM payment_accounts WHERE id=${account}) AS asset`;
  expect(types).toEqual({ document: "object", job: "object", asset: "object" });
  expect((await store.balances(7))[0].asset).toEqual(asset);
});
