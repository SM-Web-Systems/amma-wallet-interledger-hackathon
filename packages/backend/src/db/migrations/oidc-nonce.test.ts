import { afterEach, describe, expect, it } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import { legacyDatabase, migrate } from "./chain-storage.test-support";
import { applyOidcNonce } from "./oidc-nonce";
import { evaluateSchema, readSchemaFacts } from "../schema-gate";

let pg: PGlite;
const connection = (tx: { exec(sql: string): Promise<unknown>; query<T>(sql: string): Promise<{ rows: T[] }> }) => ({
  execute: async (sql: string) => { await tx.exec(sql); },
  rows: async <T extends Record<string, unknown>>(sql: string) => (await tx.query<T>(sql)).rows,
});
const apply = () => pg.transaction((tx) => applyOidcNonce(connection(tx)));
afterEach(async () => { await pg?.close(); });

// Mirrors src/db/schema tokenRegistry (the table predates the guarded migrations).
const TOKEN_REGISTRY = `CREATE TABLE token_registry (
  jti text PRIMARY KEY, token_type text NOT NULL, sub text NOT NULL, client_id text NOT NULL,
  family_id text, code_challenge text, redirect_uri text, scope text,
  issued_at timestamptz NOT NULL, expires_at timestamptz NOT NULL, used_at timestamptz, revoked_at timestamptz,
  created_at timestamptz DEFAULT now())`;
const row = (jti: string, type: string, nonce: string | null) => pg.query(
  "INSERT INTO token_registry (jti, token_type, sub, client_id, issued_at, expires_at, nonce) VALUES ($1,$2,'1','crm',now(),now() + interval '5 minutes',$3)", [jti, type, nonce]);

describe("guarded oidc-nonce-v1 migration", { timeout: 30_000 }, () => {
  it("needs the marker table and token_registry, applies once and records its checksum", async () => {
    pg = await legacyDatabase();
    await expect(apply()).rejects.toThrow("chain-storage migration is required");
    await migrate(pg);
    await expect(apply()).rejects.toThrow("token_registry is missing");
    await pg.exec(TOKEN_REGISTRY);
    await pg.query("INSERT INTO token_registry (jti, token_type, sub, client_id, issued_at, expires_at) VALUES ('old','refresh','1','crm',now(),now())");
    expect(await apply()).toBe("applied");
    expect(await apply()).toBe("already-applied");
    expect((await pg.query("SELECT version FROM amma_chain_migrations WHERE version='oidc-nonce-v1'")).rows).toHaveLength(1);
    expect((await pg.query<{ nonce: string | null }>("SELECT nonce FROM token_registry WHERE jti='old'")).rows[0].nonce).toBeNull();
  });

  it("allows a nonce only on authorization codes and bounds its length", async () => {
    pg = await legacyDatabase(); await migrate(pg); await pg.exec(TOKEN_REGISTRY); await apply();
    await row("c1", "auth_code", "n-0S6_WzA2Mj");
    await row("c2", "auth_code", null);
    await expect(row("r1", "refresh", "abc")).rejects.toThrow();
    await expect(row("c3", "auth_code", "")).rejects.toThrow();
    await expect(row("c4", "auth_code", "x".repeat(513))).rejects.toThrow();
  });

  it("the schema gate refuses this build until the nonce column exists, then accepts the marker", async () => {
    pg = await legacyDatabase(); await migrate(pg); await pg.exec(TOKEN_REGISTRY);
    const rows = async <T extends Record<string, unknown>>(sql: string) => (await pg.query<T>(sql)).rows;
    expect(evaluateSchema(await readSchemaFacts(rows), {}).problems).toContain("missing column token_registry.nonce");
    await apply();
    const after = evaluateSchema(await readSchemaFacts(rows), {}).problems;
    expect(after).not.toContain("missing column token_registry.nonce");
    expect(after.filter((p) => p.includes("oidc-nonce"))).toEqual([]);
  });

  it("detects drift when the recorded migration's column was dropped", async () => {
    pg = await legacyDatabase(); await migrate(pg); await pg.exec(TOKEN_REGISTRY); await apply();
    await pg.exec("ALTER TABLE token_registry DROP COLUMN nonce");
    await expect(apply()).rejects.toThrow("schema drift");
  });
});
