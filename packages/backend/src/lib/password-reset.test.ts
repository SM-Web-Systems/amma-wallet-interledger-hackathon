import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";

const state = vi.hoisted(() => ({ db: undefined as any }));
vi.mock("../db", async () => ({ get db() { return state.db; }, schema: await import("../db/schema") }));
vi.mock("../config", () => ({ config: { JWT_SECRET: "x", JWT_REFRESH_SECRET: "y", JWT_REFRESH_EXPIRES_IN: 604800 } }));

import { applyPasswordReset, claimResetToken } from "./password-reset";
import { revokeAllUserTokens } from "./auth";

let pg: PGlite;
let db: ReturnType<typeof drizzle>;
const q = async (text: string) => (await pg.query(text)).rows as any[];

beforeAll(async () => {
  pg = new PGlite();
  db = drizzle(pg);
  state.db = db;
  await pg.exec(`
    CREATE TABLE users (id SERIAL PRIMARY KEY, password_hash TEXT, failed_login_attempts INT NOT NULL DEFAULT 0, last_failed_login TIMESTAMPTZ, updated_at TIMESTAMPTZ);
    CREATE TABLE password_reset_tokens (id SERIAL PRIMARY KEY, user_id INT NOT NULL REFERENCES users(id), token TEXT NOT NULL UNIQUE, expires_at TIMESTAMPTZ NOT NULL, used_at TIMESTAMPTZ);
    CREATE TABLE refresh_tokens (id SERIAL PRIMARY KEY, user_id INT NOT NULL REFERENCES users(id), token TEXT NOT NULL, expires_at TIMESTAMPTZ NOT NULL);
    CREATE TABLE token_registry (jti TEXT PRIMARY KEY, token_type TEXT NOT NULL, sub TEXT NOT NULL, client_id TEXT NOT NULL, issued_at TIMESTAMPTZ NOT NULL DEFAULT now(), expires_at TIMESTAMPTZ NOT NULL DEFAULT now() + interval '1 day', revoked_at TIMESTAMPTZ);
    CREATE TABLE audit_logs (id SERIAL PRIMARY KEY, user_id INT, action TEXT NOT NULL, detail JSONB DEFAULT '{}', ip_address TEXT, user_agent TEXT, created_at TIMESTAMPTZ DEFAULT now());
  `);
});
beforeEach(async () => {
  await pg.exec(`TRUNCATE users, password_reset_tokens, refresh_tokens, token_registry, audit_logs RESTART IDENTITY CASCADE;
    INSERT INTO users (id, password_hash, failed_login_attempts, last_failed_login) VALUES (1, 'old', 10, now()), (2, 'old2', 3, now());
    INSERT INTO password_reset_tokens (user_id, token, expires_at) VALUES (1, 'a', now() + interval '1 hour'), (1, 'b', now() + interval '1 hour'), (2, 'c', now() + interval '1 hour');
    INSERT INTO refresh_tokens (user_id, token, expires_at) VALUES (1, 'r1', now() + interval '1 day'), (2, 'r2', now() + interval '1 day');
    INSERT INTO token_registry (jti, token_type, sub, client_id) VALUES ('j1', 'refresh', '1', 'c'), ('j2', 'refresh', '2', 'c');`);
});

const reset = (q2: any, userId = 1, method: "email" | "sms" = "email") =>
  applyPasswordReset(q2, { userId, passwordHash: "new", method, ip: "1.2.3.4", userAgent: "ua" });

describe("applyPasswordReset (WA-08)", () => {
  it("sets the hash and clears the login lock", async () => {
    await reset(db);
    expect(await q("SELECT password_hash, failed_login_attempts, last_failed_login FROM users WHERE id = 1")).toEqual([{ password_hash: "new", failed_login_attempts: 0, last_failed_login: null }]);
    expect((await q("SELECT failed_login_attempts FROM users WHERE id = 2"))[0].failed_login_attempts).toBe(3);
  });
  it("voids the other unused reset links of that user only", async () => {
    await reset(db);
    expect(await q("SELECT token FROM password_reset_tokens WHERE used_at IS NULL")).toEqual([{ token: "c" }]);
  });
  it("signs out that user's refresh tokens and OAuth tokens, and nobody else's", async () => {
    await reset(db);
    expect(await q("SELECT user_id FROM refresh_tokens")).toEqual([{ user_id: 2 }]);
    expect(await q("SELECT jti, revoked_at IS NOT NULL AS revoked FROM token_registry ORDER BY jti")).toEqual([{ jti: "j1", revoked: true }, { jti: "j2", revoked: false }]);
  });
  it("writes the audit row with the method", async () => {
    await reset(db, 1, "sms");
    expect(await q("SELECT user_id, action, detail, ip_address, user_agent FROM audit_logs")).toEqual([{ user_id: 1, action: "password_reset", detail: { method: "sms" }, ip_address: "1.2.3.4", user_agent: "ua" }]);
  });
  it("rolls everything back, including the password and the sessions, when the last step fails", async () => {
    await pg.exec("ALTER TABLE audit_logs ADD CONSTRAINT never CHECK (action <> 'password_reset')");
    await expect(db.transaction((tx) => reset(tx))).rejects.toThrow();
    await pg.exec("ALTER TABLE audit_logs DROP CONSTRAINT never");
    expect((await q("SELECT password_hash, failed_login_attempts FROM users WHERE id = 1"))[0]).toEqual({ password_hash: "old", failed_login_attempts: 10 });
    expect(await q("SELECT id FROM refresh_tokens WHERE user_id = 1")).toHaveLength(1);
    expect((await q("SELECT revoked_at FROM token_registry WHERE jti = 'j1'"))[0].revoked_at).toBeNull();
    expect(await q("SELECT id FROM password_reset_tokens WHERE used_at IS NOT NULL")).toHaveLength(0);
  });
});

describe("claimResetToken (WA-08)", () => {
  it("lets only one of two parallel claims win", async () => {
    const wins = await Promise.all([db.transaction((tx) => claimResetToken(tx, 1, 1)), db.transaction((tx) => claimResetToken(tx, 1, 1))]);
    expect(wins.filter(Boolean)).toHaveLength(1);
  });
  it("refuses a link that has expired", async () => {
    await pg.exec("UPDATE password_reset_tokens SET expires_at = now() - interval '1 minute' WHERE id = 1");
    expect(await claimResetToken(db, 1, 1)).toBe(false);
  });
  it("refuses a link that was already used", async () => {
    expect(await claimResetToken(db, 1, 1)).toBe(true);
    expect(await claimResetToken(db, 1, 1)).toBe(false);
  });
});

describe("revokeAllUserTokens is unchanged (WA-08)", () => {
  it("still only deletes refresh tokens, so logout and change-password behave as before", async () => {
    await revokeAllUserTokens(1);
    expect(await q("SELECT user_id FROM refresh_tokens")).toEqual([{ user_id: 2 }]);
    expect((await q("SELECT revoked_at FROM token_registry WHERE jti = 'j1'"))[0].revoked_at).toBeNull();
    expect((await q("SELECT failed_login_attempts FROM users WHERE id = 1"))[0].failed_login_attempts).toBe(10);
    expect(await q("SELECT id FROM password_reset_tokens WHERE used_at IS NOT NULL")).toHaveLength(0);
    expect(await q("SELECT id FROM audit_logs")).toHaveLength(0);
  });
});
