import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";

const authSrc = readFileSync(join(__dirname, "auth.ts"), "utf-8");

describe("P0-1-F3 / WA-08: email password reset is recorded with the right user id", () => {
  it("records password_reset inside the reset transaction with record.user_id", () => {
    const resetSection = authSrc.split('"/api/v1/auth/reset-password",')[1]?.split('"/api/v1/auth/verify-email"')[0];
    expect(resetSection).toBeDefined();
    expect(resetSection).toContain("const userId = Number(record.user_id);");
    expect(resetSection).toContain('applyPasswordReset(tx, { userId, passwordHash: newHash, method: "email"');
    expect(resetSection).not.toContain("record.userId");
    expect(resetSection).not.toContain('auditLog("password_reset"');
  });
});
