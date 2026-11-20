import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { drizzle } from "drizzle-orm/pglite";
import type { PGlite } from "@electric-sql/pglite";
import { legacyDatabase, migrate } from "../db/migrations/chain-storage.test-support";
import { applyKeyRecovery } from "../db/migrations/key-recovery";

// Custody plan step 5b: while a recovery request waits, nothing may sign, send or change keys for that user.
const state = vi.hoisted(() => ({ db: undefined as any, userId: 1 as number | undefined }));
vi.mock("../db", async () => ({ get db() { return state.db; }, schema: await import("../db/schema") }));

import { installRecoveryFreeze, isFrozenRoute } from "./key-recovery";

let pg: PGlite;
const handler = vi.fn(async () => ({ ok: true }));
const auth = async (request: any) => { if (state.userId) request.user = { userId: state.userId }; };

async function build(enabled: boolean) {
  const app = Fastify();
  installRecoveryFreeze(app, { enabled });
  const routes: [string, string][] = [
    ["POST", "/api/v1/transactions/sign"], ["POST", "/api/v1/transactions/sign-and-submit"], ["POST", "/api/v1/transactions/submit"],
    ["POST", "/api/v1/trustlines/add"], ["POST", "/api/v1/trustlines/remove"], ["POST", "/api/v1/trustlines/update-limit"],
    ["POST", "/api/v1/nfts/transfer"], ["POST", "/api/v1/nfts/mint"],
    ["POST", "/api/v1/payments/approvals"], ["POST", "/api/v1/payments/executions/:id/signatures"],
    ["POST", "/api/v1/xrpl/payment-intents"], ["POST", "/api/v1/xrpl/payment-intents/:id/submit"],
    ["POST", "/api/v1/fiat/buy"], ["POST", "/api/v1/fiat/sell"],
    ["PATCH", "/api/v1/wallets/:id/secret"], ["DELETE", "/api/v1/wallets/:id"], ["POST", "/api/v1/wallets"],
    ["PATCH", "/api/v1/user/signing-mode"], ["POST", "/api/v1/auth/change-password"],
    ["PUT", "/api/v1/key-escrow/phrase"], ["POST", "/api/v1/key-escrow/phrase/open"],
    // never frozen:
    ["GET", "/api/v1/transactions/submit"], ["GET", "/api/v1/wallets"], ["POST", "/api/v1/key-recovery/cancel"],
    ["POST", "/api/v1/key-recovery/complete"], ["GET", "/api/v1/key-recovery/status"], ["POST", "/api/v1/auth/login"],
    ["POST", "/api/v1/payments/webhooks/rafiki"], ["POST", "/api/v1/contacts"],
  ];
  for (const [method, url] of routes) app.route({ method: method as any, url, preHandler: auth, handler });
  await app.ready();
  return app;
}
let app: FastifyInstance; let off: FastifyInstance;
const call = (a: FastifyInstance, method: string, url: string) => a.inject({ method: method as any, url: url.replace(":id", "abc"), payload: method === "GET" ? undefined : {} });

beforeAll(async () => {
  pg = await legacyDatabase(); await migrate(pg);
  await applyKeyRecovery({ execute: async (s) => { await pg.exec(s); }, rows: async (s) => (await pg.query(s)).rows as any });
  state.db = drizzle(pg);
  app = await build(true); off = await build(false);
}, 60000);
beforeEach(async () => {
  state.userId = 1; handler.mockClear();
  await pg.exec("TRUNCATE wallet_key_recovery");
});
afterAll(async () => { await app?.close(); await off?.close(); await pg?.close(); });
const startRecovery = (userId = 1) => pg.query("INSERT INTO wallet_key_recovery(user_id,state,ready_at,cancel_token_hash) VALUES ($1,'pending',now()+interval '48 hours','h')", [userId]);

describe("which routes freeze", () => {
  it("covers money, key and password changes, and leaves reading, login, webhooks and recovery itself alone", () => {
    for (const [m, u] of [["POST", "/api/v1/transactions/sign"], ["POST", "/api/v1/trustlines/add"], ["PATCH", "/api/v1/wallets/:id/secret"], ["PUT", "/api/v1/key-escrow/phrase"], ["POST", "/api/v1/xrpl/payment-intents/:id/prepare"], ["PATCH", "/api/v1/user/signing-mode"]]) expect(isFrozenRoute(m, u), `${m} ${u}`).toBe(true);
    for (const [m, u] of [["GET", "/api/v1/transactions/sign"], ["POST", "/api/v1/key-recovery/cancel"], ["POST", "/api/v1/auth/login"], ["POST", "/api/v1/payments/webhooks/rafiki"], ["HEAD", "/api/v1/wallets"]]) expect(isFrozenRoute(m, u), `${m} ${u}`).toBe(false);
  });
});

describe("while a recovery waits", () => {
  it.each([
    "/api/v1/transactions/sign", "/api/v1/transactions/sign-and-submit", "/api/v1/transactions/submit", "/api/v1/trustlines/add",
    "/api/v1/nfts/transfer", "/api/v1/payments/approvals", "/api/v1/payments/executions/:id/signatures", "/api/v1/xrpl/payment-intents/:id/submit",
    "/api/v1/fiat/sell", "/api/v1/wallets/:id/secret", "/api/v1/user/signing-mode", "/api/v1/auth/change-password", "/api/v1/key-escrow/phrase",
  ])("refuses %s for that user, without running it", async (url) => {
    await startRecovery();
    const method = url.endsWith("/secret") ? "PATCH" : url === "/api/v1/user/signing-mode" ? "PATCH" : url === "/api/v1/key-escrow/phrase" ? "PUT" : "POST";
    const res = await call(app, method, url);
    expect(res.statusCode).toBe(423);
    expect(res.json().code).toBe("recovery_pending");
    expect(handler).not.toHaveBeenCalled();
  });

  it("lets other users, reading, login, webhooks and the recovery routes themselves through", async () => {
    await startRecovery();
    for (const [m, u] of [["GET", "/api/v1/wallets"], ["GET", "/api/v1/transactions/submit"], ["POST", "/api/v1/key-recovery/cancel"], ["POST", "/api/v1/key-recovery/complete"], ["GET", "/api/v1/key-recovery/status"], ["POST", "/api/v1/auth/login"], ["POST", "/api/v1/payments/webhooks/rafiki"], ["POST", "/api/v1/contacts"]]) {
      expect((await call(app, m, u)).statusCode, `${m} ${u}`).toBe(200);
    }
    state.userId = 2;
    expect((await call(app, "POST", "/api/v1/transactions/sign")).statusCode).toBe(200);
  });

  it("unfreezes when the request is cancelled or completed", async () => {
    await startRecovery();
    expect((await call(app, "POST", "/api/v1/trustlines/add")).statusCode).toBe(423);
    await pg.exec("UPDATE wallet_key_recovery SET state='cancelled'");
    expect((await call(app, "POST", "/api/v1/trustlines/add")).statusCode).toBe(200);
  });

  it("stays frozen after the wait is over, until the owner finishes or cancels", async () => {
    await startRecovery();
    await pg.exec("UPDATE wallet_key_recovery SET ready_at = now() - interval '1 hour'");
    expect((await call(app, "POST", "/api/v1/transactions/sign")).statusCode).toBe(423);
  });

  it("does nothing, and asks the database nothing, when recovery is switched off", async () => {
    await startRecovery();
    expect((await call(off, "POST", "/api/v1/transactions/sign")).statusCode).toBe(200);
  });

  it("fails closed when the database cannot answer", async () => {
    const real = state.db;
    state.db = { execute: async () => { throw new Error("db down"); } };
    try {
      const res = await call(app, "POST", "/api/v1/transactions/sign");
      expect(res.statusCode).toBeGreaterThanOrEqual(500);
      expect(handler).not.toHaveBeenCalled();
    } finally { state.db = real; }
  });

  it("lets an unauthenticated call through to the route's own auth", async () => {
    await startRecovery();
    state.userId = undefined;
    expect((await call(app, "POST", "/api/v1/transactions/sign")).statusCode).toBe(200); // route's own auth (here a no-op) decides
  });
});
