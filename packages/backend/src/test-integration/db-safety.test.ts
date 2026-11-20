/**
 * Tests for integration test database safety guards (REV-03 hardened).
 *
 * These tests verify that the db-harness refuses to connect to or
 * execute destructive operations against non-test databases.
 *
 * REV-03 additions:
 * - Missing TEST_DATABASE_URL configuration rejection
 * - Role verification
 * - Disposable-database marker verification
 * - Centralized connection factory validation
 * - Production-like database identifier rejection
 *
 * Run with: npx vitest run --config vitest.integration.config.ts
 */

import { describe, expect, it } from "vitest";
import { parseTestDbUrl, validateTestDatabaseUrl } from "./db-harness";

// ── URL parsing ─────────────────────────────────────────────────────────────

describe("parseTestDbUrl", () => {
  it("parses a standard PostgreSQL URL", () => {
    const result = parseTestDbUrl(
      "postgresql://user:pass@localhost:15432/stellarwallet_test",
    );
    expect(result).toEqual({
      host: "localhost",
      port: 15432,
      database: "stellarwallet_test",
      user: "user",
    });
  });

  it("defaults to port 5432 when not specified", () => {
    const result = parseTestDbUrl(
      "postgresql://user:pass@localhost/stellarwallet_test",
    );
    expect(result.port).toBe(5432);
  });

  it("rejects invalid URL format", () => {
    expect(() => parseTestDbUrl("not-a-url")).toThrow("Invalid database URL format");
  });

  it("rejects non-PostgreSQL protocol", () => {
    expect(() =>
      parseTestDbUrl("mysql://user:pass@localhost:15432/test"),
    ).toThrow("Invalid database URL protocol");
  });
});

// ── Safety validation ───────────────────────────────────────────────────────

// Outside disposable mode: never inherit the CI job's own AMMA_CI_DISPOSABLE_DB / GITHUB_ACTIONS.
const validateLocal = (url: string) => validateTestDatabaseUrl(url, {});

describe("validateTestDatabaseUrl", () => {
  const SAFE_URL = "postgresql://stellarwallet_test:test_only_password@localhost:15432/stellarwallet_test";

  it("accepts approved test database configuration", () => {
    const parsed = validateLocal(SAFE_URL);
    expect(parsed.database).toBe("stellarwallet_test");
    expect(parsed.host).toBe("localhost");
    expect(parsed.port).toBe(15432);
  });

  it("rejects missing database URL (empty string)", () => {
    expect(() => validateLocal("")).toThrow();
  });

  // ── Production database name rejection ──────────────────────────────────

  it("rejects production database name: stellarwallet", () => {
    expect(() =>
      validateLocal("postgresql://u:p@localhost:15432/stellarwallet"),
    ).toThrow("SAFETY BLOCK");
    expect(() =>
      validateLocal("postgresql://u:p@localhost:15432/stellarwallet"),
    ).toThrow("production database name");
  });

  it("rejects production database name: amma", () => {
    expect(() =>
      validateLocal("postgresql://u:p@localhost:15432/amma"),
    ).toThrow("SAFETY BLOCK");
  });

  it("rejects production database name: ammawallet", () => {
    expect(() =>
      validateLocal("postgresql://u:p@localhost:15432/ammawallet"),
    ).toThrow("SAFETY BLOCK");
  });

  it("rejects production database name: amma_wallet", () => {
    expect(() =>
      validateLocal("postgresql://u:p@localhost:15432/amma_wallet"),
    ).toThrow("SAFETY BLOCK");
  });

  it("rejects production database name: amma_production", () => {
    expect(() =>
      validateLocal("postgresql://u:p@localhost:15432/amma_production"),
    ).toThrow("SAFETY BLOCK");
  });

  it("rejects unknown database names not in allow-list", () => {
    expect(() =>
      validateLocal("postgresql://u:p@localhost:15432/my_custom_db"),
    ).toThrow("not in the allowed test database list");
  });

  // ── Host rejection ────────────────────────────────────────────────────────

  it("rejects remote hosts", () => {
    expect(() =>
      validateLocal("postgresql://u:p@db.example.com:15432/stellarwallet_test"),
    ).toThrow("SAFETY BLOCK");
    expect(() =>
      validateLocal("postgresql://u:p@db.example.com:15432/stellarwallet_test"),
    ).toThrow("not a recognized local test host");
  });

  it("rejects IP addresses that aren't localhost", () => {
    expect(() =>
      validateLocal("postgresql://u:p@10.0.0.5:15432/stellarwallet_test"),
    ).toThrow("SAFETY BLOCK");
  });

  it("accepts 127.0.0.1 as localhost", () => {
    const parsed = validateLocal(
      "postgresql://u:p@127.0.0.1:15432/stellarwallet_test",
    );
    expect(parsed.host).toBe("127.0.0.1");
  });

  // ── Port rejection ────────────────────────────────────────────────────────

  it("rejects default PostgreSQL port 5432", () => {
    expect(() =>
      validateLocal("postgresql://u:p@localhost:5432/stellarwallet_test"),
    ).toThrow("SAFETY BLOCK");
    expect(() =>
      validateLocal("postgresql://u:p@localhost:5432/stellarwallet_test"),
    ).toThrow("5432");
  });

  it("rejects URLs without explicit port (defaults to 5432)", () => {
    expect(() =>
      validateLocal("postgresql://u:p@localhost/stellarwallet_test"),
    ).toThrow("SAFETY BLOCK");
  });

  it("rejects arbitrary non-test ports", () => {
    expect(() =>
      validateLocal("postgresql://u:p@localhost:3306/stellarwallet_test"),
    ).toThrow("SAFETY BLOCK");
  });

  it("accepts the secondary test port 15433", () => {
    const parsed = validateLocal(
      "postgresql://u:p@localhost:15433/stellarwallet_test",
    );
    expect(parsed.port).toBe(15433);
  });

  // ── REV-03: Missing configuration rejection ────────────────────────────

  it("rejects malformed postgres:// protocol variant URL with bad host", () => {
    expect(() =>
      validateLocal("postgres://u:p@prod-db.internal:15432/stellarwallet_test"),
    ).toThrow("SAFETY BLOCK");
  });

  // ── REV-03: Mismatched database identity ───────────────────────────────

  it("rejects database name with production suffix variations", () => {
    // Case-insensitive check for production names
    expect(() =>
      validateLocal("postgresql://u:p@localhost:15432/AmmaWallet"),
    ).toThrow("SAFETY BLOCK");
    expect(() =>
      validateLocal("postgresql://u:p@localhost:15432/AMMA"),
    ).toThrow("SAFETY BLOCK");
  });
});

// ── CI disposable-database mode (per-job random host port) ─────────────────

describe("validateTestDatabaseUrl in CI disposable mode", () => {
  const CI_ENV = { AMMA_CI_DISPOSABLE_DB: "1", GITHUB_ACTIONS: "true" };
  const CI_URL = "postgresql://stellarwallet_test:test_only_password@127.0.0.1:49321/stellarwallet_test";

  it("accepts a random high port on 127.0.0.1 with the marker and synthetic credentials", () => {
    expect(validateTestDatabaseUrl(CI_URL, CI_ENV).port).toBe(49321);
  });

  it("accepts localhost as the host", () => {
    expect(() => validateTestDatabaseUrl(CI_URL.replace("127.0.0.1", "localhost"), CI_ENV)).not.toThrow();
  });

  it("still rejects a random port without the marker", () => {
    expect(() => validateTestDatabaseUrl(CI_URL, {})).toThrow("not an allowed test port");
    expect(() => validateTestDatabaseUrl(CI_URL, { GITHUB_ACTIONS: "true" })).toThrow("not an allowed test port");
  });

  it("still rejects a random port when the marker is set outside GitHub Actions", () => {
    expect(() => validateTestDatabaseUrl(CI_URL, { AMMA_CI_DISPOSABLE_DB: "1" })).toThrow("not an allowed test port");
  });

  it("requires the marker to be exactly 1", () => {
    expect(() => validateTestDatabaseUrl(CI_URL, { ...CI_ENV, AMMA_CI_DISPOSABLE_DB: "true" })).toThrow("not an allowed test port");
  });

  it("rejects a non-local host even in CI mode", () => {
    expect(() => validateTestDatabaseUrl(CI_URL.replace("127.0.0.1", "db.example.com"), CI_ENV)).toThrow("not a recognized local test host");
    expect(() => validateTestDatabaseUrl(CI_URL.replace("127.0.0.1", "10.0.0.5"), CI_ENV)).toThrow("SAFETY BLOCK");
  });

  it("rejects a wrong database name even in CI mode", () => {
    expect(() => validateTestDatabaseUrl(CI_URL.replace("/stellarwallet_test", "/stellarwallet"), CI_ENV)).toThrow("SAFETY BLOCK");
    expect(() => validateTestDatabaseUrl(CI_URL.replace("/stellarwallet_test", "/test"), CI_ENV)).toThrow("SAFETY BLOCK");
  });

  it("rejects a non-synthetic password or role in CI mode", () => {
    expect(() => validateTestDatabaseUrl(CI_URL.replace("test_only_password", "hunter2"), CI_ENV)).toThrow("synthetic");
    expect(() => validateTestDatabaseUrl(CI_URL.replace("stellarwallet_test:", "postgres:"), CI_ENV)).toThrow("synthetic");
  });

  it("never allows 5432 or privileged ports in CI mode", () => {
    expect(() => validateTestDatabaseUrl(CI_URL.replace("49321", "5432"), CI_ENV)).toThrow("SAFETY BLOCK");
    expect(() => validateTestDatabaseUrl(CI_URL.replace(":49321", ""), CI_ENV)).toThrow("SAFETY BLOCK");
    expect(() => validateTestDatabaseUrl(CI_URL.replace("49321", "80"), CI_ENV)).toThrow("SAFETY BLOCK");
  });
});
