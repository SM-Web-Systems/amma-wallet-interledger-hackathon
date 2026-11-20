import { describe, expect, it, vi } from "vitest";
vi.mock("../db", () => ({ db: {}, schema: {} }));
vi.mock("../lib/mailer", () => ({ sendEmail: vi.fn() }));
import { controlArgs } from "./business-controls-cli";

describe("business controls operator commands", () => {
  it("reads the cap, and needs the owner's alert address for anything that emails", () => {
    const a = controlArgs(["set-daily-cap", "--tenant=1", "--cap=25", "--by=owner"], {});
    expect([a.command, a.tenant(), a.cap(), a.by()]).toEqual(["set-daily-cap", 1, 25, "owner"]);
    expect(() => controlArgs(["set-daily-cap", "--cap=lots"], {}).cap()).toThrow("--cap");
    expect(() => controlArgs(["pause"], {}).owner()).toThrow("BUSINESS_ESCALATION_EMAIL");
    expect(controlArgs(["pause"], { BUSINESS_ESCALATION_EMAIL: "owner@example.test" }).owner()).toBe("owner@example.test");
  });
});
