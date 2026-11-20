import { describe, expect, it } from "vitest";
import { formatCountdown, remainingMs } from "../lockout";

describe("formatCountdown", () => {
  it("shows minutes and two-digit seconds", () => {
    expect(formatCountdown(5 * 60_000)).toBe("5:00");
    expect(formatCountdown(4 * 60_000 + 32_000)).toBe("4:32");
    expect(formatCountdown(30_000)).toBe("0:30");
    expect(formatCountdown(9_000)).toBe("0:09");
  });
  it("rounds a part-second up, so it never shows 0:00 while still locked", () => {
    expect(formatCountdown(1)).toBe("0:01");
    expect(formatCountdown(59_001)).toBe("1:00");
  });
  it("shows hours for the longest wait", () => {
    expect(formatCountdown(3_600_000)).toBe("1:00:00");
    expect(formatCountdown(3_599_000)).toBe("59:59");
  });
  it("is 0:00 for nothing left or a bad value", () => {
    expect(formatCountdown(0)).toBe("0:00");
    expect(formatCountdown(-5)).toBe("0:00");
    expect(formatCountdown(Number.NaN)).toBe("0:00");
  });
});

describe("remainingMs", () => {
  it("counts down to the unlock time and stops at zero", () => {
    expect(remainingMs(10_000, 4_000)).toBe(6_000);
    expect(remainingMs(10_000, 10_000)).toBe(0);
    expect(remainingMs(10_000, 12_000)).toBe(0);
    expect(remainingMs(0, 12_000)).toBe(0);
  });
});
