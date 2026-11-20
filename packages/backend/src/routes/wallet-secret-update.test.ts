import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { drizzle } from "drizzle-orm/pglite";
import type { PGlite } from "@electric-sql/pglite";
import { legacyDatabase, migrateWithCustodyV2 } from "../db/migrations/chain-storage.test-support";

// Replacing the server copy of a Stellar wallet's encrypted secret after the
// person moves from a short PIN to a 12+ character passphrase.
const state = vi.hoisted(() => ({ db: undefined as any }));
vi.mock("../db", async () => ({ get db() { return state.db; }, schema: await import("../db/schema") }));
vi.mock("../config", () => ({ config: { STELLAR_NETWORK: "testnet" } }));
vi.mock("../middleware/auth", () => ({ authMiddleware: async (request: any) => { request.user = { userId: 1, type: "user" }; } }));
vi.mock("../middleware/tenant-api-key", () => ({ attachTenantApiKey: async () => {}, requireScope: () => async () => {} }));
vi.mock("../services/billing.service", () => ({ checkWalletBilling: vi.fn(), checkWalletBillingTx: vi.fn(), writeBillingDebit: vi.fn(), upsertTenantUser: vi.fn(), maybeNotifyDeficit: vi.fn() }));

import { walletRoutes } from "./wallets";
import { encryptSecret, decryptSecret } from "../lib/decrypt-secret";

let pg: PGlite;
let app: FastifyInstance;
// Same shape the web app produces: base64(salt 16 + iv 12 + AES-GCM(56-char secret) 72).
const blob = Buffer.alloc(100, 7).toString("base64");
const secretOf = async (id: number) => (await pg.query("SELECT encrypted_secret AS s FROM user_wallets WHERE id=$1", [id])).rows[0] as { s: string | null };

beforeAll(async () => {
  pg = await legacyDatabase(); await migrateWithCustodyV2(pg);
  state.db = drizzle(pg);
  app = Fastify();
  await app.register(walletRoutes);
  await app.ready();
}, 90000);
beforeEach(async () => {
  await pg.exec(`TRUNCATE user_wallets RESTART IDENTITY;
    INSERT INTO user_wallets(id,user_id,name,public_key,chain,network,is_active,encrypted_secret) VALUES
    (1,1,'Stellar','G${"A".repeat(55)}','stellar','testnet',true,'old'),
    (2,1,'XRP','r-example','xrpl','testnet',true,NULL),
    (3,2,'Other user','G-other','stellar','testnet',true,'old'),
    (4,1,'Mainnet','G-public','stellar','public',true,'old');`);
});
afterAll(async () => { await app?.close(); await pg?.close(); });

describe("PATCH /api/v1/wallets/:id/secret", () => {
  it("replaces the caller's Stellar secret and never echoes it back", async () => {
    const res = await app.inject({ method: "PATCH", url: "/api/v1/wallets/1/secret", payload: { encryptedSecret: blob } });
    expect(res.statusCode).toBe(200);
    expect(res.body).not.toContain(blob);
    expect(res.json()).toEqual({ ok: true });
    expect((await secretOf(1)).s).toBe(blob);
  });

  it.each([2, 3, 4])("refuses wallet %i (other chain, user or network)", async (id) => {
    const res = await app.inject({ method: "PATCH", url: `/api/v1/wallets/${id}/secret`, payload: { encryptedSecret: blob } });
    expect(res.statusCode).toBe(404);
    expect((await secretOf(id)).s).toBe(id === 2 ? null : "old");
  });

  it.each([
    ["missing", {}],
    ["not base64", { encryptedSecret: "not base64!".repeat(10) }],
    ["too short to hold a secret", { encryptedSecret: Buffer.alloc(40).toString("base64") }],
    ["too long", { encryptedSecret: Buffer.alloc(2000).toString("base64") }],
  ])("rejects a %s payload", async (_label, payload) => {
    const res = await app.inject({ method: "PATCH", url: "/api/v1/wallets/1/secret", payload });
    expect(res.statusCode).toBe(400);
    expect((await secretOf(1)).s).toBe("old");
  });
});

// Delegated-mode wallets: the browser holds no ciphertext, so the server
// re-encrypts with the person's current PIN (which it already receives on
// every delegated signature) and the new passphrase.
describe("POST /api/v1/wallets/active/passphrase (delegated signing)", () => {
  const SECRET = "SBGWSG6BTNCKCOB3DIFBGCVMUPQFYPA2G4O34RMTB343OYPXU5DJDVMN";
  const NEXT = "lamp river garden 42";
  const CURRENT = "old harbour lights 7";
  beforeEach(async () => {
    await pg.query("INSERT INTO users(id,email,password_hash,signing_mode) VALUES (1,'a@example.invalid','x','delegated') ON CONFLICT (id) DO UPDATE SET signing_mode='delegated'");
    await pg.query("UPDATE user_wallets SET encrypted_secret=$1 WHERE id=1", [await encryptSecret(SECRET, "123456")]);
  });

  it("refuses to swap a legacy PIN for a passphrase (the wallet moves into custody instead) and changes nothing", async () => {
    const before = (await secretOf(1)).s;
    const res = await app.inject({ method: "POST", url: "/api/v1/wallets/active/passphrase", payload: { currentPin: "123456", newPassphrase: NEXT } });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ code: "pin-retired", custodyAvailable: false });
    expect((await secretOf(1)).s).toBe(before);
  }, 20000);

  it("still re-encrypts a wallet that already uses a passphrase", async () => {
    await pg.query("UPDATE user_wallets SET encrypted_secret=$1 WHERE id=1", [await encryptSecret(SECRET, CURRENT)]);
    const res = await app.inject({ method: "POST", url: "/api/v1/wallets/active/passphrase", payload: { currentPin: CURRENT, newPassphrase: NEXT } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });
    const stored = (await secretOf(1)).s!;
    expect(await decryptSecret(stored, NEXT)).toBe(SECRET);
    await expect(decryptSecret(stored, CURRENT)).rejects.toThrow();
  }, 20000);

  it("refuses a wrong current PIN and changes nothing", async () => {
    const before = (await secretOf(1)).s;
    const res = await app.inject({ method: "POST", url: "/api/v1/wallets/active/passphrase", payload: { currentPin: "654321", newPassphrase: NEXT } });
    expect(res.statusCode).toBe(403);
    expect((await secretOf(1)).s).toBe(before);
  }, 20000);

  it.each(["short", "123456789012345"])("refuses a weak new passphrase %s", async (next) => {
    const res = await app.inject({ method: "POST", url: "/api/v1/wallets/active/passphrase", payload: { currentPin: "123456", newPassphrase: next } });
    expect(res.statusCode).toBe(400);
  });

  it("is only for delegated signing", async () => {
    await pg.query("UPDATE users SET signing_mode='self' WHERE id=1");
    const res = await app.inject({ method: "POST", url: "/api/v1/wallets/active/passphrase", payload: { currentPin: "123456", newPassphrase: NEXT } });
    expect(res.statusCode).toBe(403);
  });
});
