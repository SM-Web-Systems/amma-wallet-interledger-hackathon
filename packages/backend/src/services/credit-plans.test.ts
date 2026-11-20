import { describe, expect, it } from "vitest";
import {
  annualPaidUntil, bundleQuote, depositQuote, isBillable, managementFloor, matchDeposit, monthlyManagementCharge,
  nextCredit, projectedGrowth, type CatalogBundle, type ManagedWallet,
} from "./credit-plans";

const catalog: CatalogBundle[] = [100, 200, 500, 1000].flatMap((users) => [
  { slug: `monthly-${users}`, plan: "monthly" as const, users },
  { slug: `annual-${users}`, plan: "annual" as const, users },
]);
const d = (s: string) => new Date(s);

describe("bundle prices", () => {
  it("monthly is 3.4 XLM per user: 340 / 680 / 1700 / 3400", () => {
    expect(bundleQuote("monthly", 1).perUser).toBe("3.4000000");
    expect([100, 200, 500, 1000].map((u) => bundleQuote("monthly", u).total)).toEqual(["340.0000000", "680.0000000", "1700.0000000", "3400.0000000"]);
  });

  it("annual is 4.1 XLM per user: 410 / 820 / 2050 / 4100", () => {
    expect(bundleQuote("annual", 1).perUser).toBe("4.1000000");
    expect([100, 200, 500, 1000].map((u) => bundleQuote("annual", u).total)).toEqual(["410.0000000", "820.0000000", "2050.0000000", "4100.0000000"]);
  });

  it("splits a 100-user monthly bundle into 110 funding, 200 fee and 30 management", () => {
    expect(bundleQuote("monthly", 100)).toMatchObject({ funding: "110.0000000", platformFee: "200.0000000", management: "30.0000000" });
  });

  it("refuses a non-whole or out-of-range user count", () => {
    for (const bad of [0, -1, 1.5, 1_000_001, Number.NaN]) expect(() => bundleQuote("monthly", bad)).toThrow();
  });
});

describe("deposits", () => {
  it("adds the 100 XLM registration fee and the 1 XLM reserve to the first deposit only", () => {
    expect(depositQuote("monthly", 100, { firstDeposit: true }).depositTotal).toBe("441.0000000");
    expect(depositQuote("monthly", 100, { firstDeposit: false }).depositTotal).toBe("340.0000000");
  });

  it("waives the registration fee when the business has it waived (the LMS)", () => {
    const q = depositQuote("monthly", 5, { firstDeposit: true, waiveRegistrationFee: true });
    expect(q.depositTotal).toBe("18.0000000");
    expect(depositQuote("annual", 5, { firstDeposit: true, waiveRegistrationFee: true }).depositTotal).toBe("21.5000000");
  });

  it("sends the fee (and annual management, and registration) to the fee address and keeps the rest in the pots", () => {
    const monthly = depositQuote("monthly", 100, { firstDeposit: true });
    expect(monthly).toMatchObject({ toFeeAddress: "300.0000000", toFundingPot: "110.0000000", toManagementPot: "30.0000000", reserve: "1.0000000" });
    const annual = depositQuote("annual", 100, { firstDeposit: false });
    expect(annual).toMatchObject({ toFeeAddress: "300.0000000", toFundingPot: "110.0000000", toManagementPot: "0.0000000" });
  });

  it("every stroop of a deposit is accounted for", () => {
    for (const plan of ["monthly", "annual"] as const) for (const firstDeposit of [true, false]) {
      const q = depositQuote(plan, 37, { firstDeposit });
      const parts = [q.toFeeAddress, q.toFundingPot, q.toManagementPot, q.reserve].map((x) => Math.round(Number(x) * 1e7)).reduce((a, b) => a + b, 0);
      expect(parts).toBe(Math.round(Number(q.depositTotal) * 1e7));
    }
  });

  it("matches an exact bundle price and holds anything else for escalation", () => {
    expect(matchDeposit("340", catalog, { firstDeposit: false })).toMatchObject({ kind: "bundle", slug: "monthly-100" });
    expect(matchDeposit("441.0000000", catalog, { firstDeposit: true })).toMatchObject({ kind: "bundle", slug: "monthly-100" });
    expect(matchDeposit("340", catalog, { firstDeposit: true })).toEqual({ kind: "unmatched", reason: "no_bundle_matches_amount" });
    expect(matchDeposit("100", catalog, { firstDeposit: false })).toEqual({ kind: "unmatched", reason: "no_bundle_matches_amount" });
    expect(matchDeposit("2050", catalog, { firstDeposit: false })).toMatchObject({ kind: "bundle", slug: "annual-500" });
  });

  it("refuses a malformed amount instead of guessing", () => {
    expect(() => matchDeposit("1e3", catalog, { firstDeposit: false })).toThrow();
    expect(() => matchDeposit("340.12345678", catalog, { firstDeposit: false })).toThrow();
  });
});

describe("credits", () => {
  it("uses yearly credits first, then monthly", () => {
    expect(nextCredit({ annual: 2, monthly: 5 })).toBe("annual");
    expect(nextCredit({ annual: 0, monthly: 5 })).toBe("monthly");
    expect(nextCredit({ annual: 0, monthly: 0 })).toBeNull();
  });
});

describe("monthly wallet management fee", () => {
  const monthly = (activatedAt: string, deletedAt?: string): ManagedWallet => ({ plan: "monthly", activatedAt: d(activatedAt), deletedAt: deletedAt ? d(deletedAt) : null });
  const annual = (activatedAt: string): ManagedWallet => ({ plan: "annual", activatedAt: d(activatedAt), paidUntil: annualPaidUntil(d(activatedAt)) });

  it("charges every live monthly wallet from its activation month, sign-ins or not", () => {
    const w = monthly("2026-11-20T10:00:00Z");
    expect(isBillable(w, d("2026-10-01T00:00:00Z"))).toBe(false);
    expect(isBillable(w, d("2026-11-01T00:00:00Z"))).toBe(true);
    expect(isBillable(w, d("2027-06-01T00:00:00Z"))).toBe(true);
  });

  it("stops charging a deleted wallet from the month after it was deleted", () => {
    const w = monthly("2026-01-05T00:00:00Z", "2026-05-10T00:00:00Z");
    expect(isBillable(w, d("2026-05-01T00:00:00Z"))).toBe(true);
    expect(isBillable(w, d("2026-06-01T00:00:00Z"))).toBe(false);
  });

  it("doesn't charge an annual wallet inside its prepaid year, then drops it to monthly", () => {
    const w = annual("2026-11-20T10:00:00Z");
    expect(w.paidUntil?.toISOString()).toBe("2027-11-20T10:00:00.000Z");
    expect(isBillable(w, d("2027-11-01T00:00:00Z"))).toBe(false);
    expect(isBillable(w, d("2027-12-01T00:00:00Z"))).toBe(true);
  });

  it("totals 0.1 XLM per billable wallet", () => {
    const wallets = [monthly("2026-11-02T00:00:00Z"), monthly("2026-11-30T23:59:59Z"), monthly("2026-12-01T00:00:00Z"), annual("2026-11-02T00:00:00Z")];
    expect(monthlyManagementCharge(wallets, d("2026-11-15T00:00:00Z"))).toEqual({ billableWallets: 2, amount: "0.2000000" });
  });
});

describe("2-month floor with growth", () => {
  it("averages month-on-month growth and clamps it to 0..50 %", () => {
    expect(projectedGrowth([300, 350, 400])).toBeCloseTo(0.1548, 3);
    expect(projectedGrowth([400, 300])).toBe(0);
    expect(projectedGrowth([10, 100])).toBe(0.5);
    expect(projectedGrowth([])).toBe(0);
    expect(projectedGrowth([0, 0, 5])).toBe(0);
  });

  it("is zero for a new business with no wallets yet", () => {
    expect(managementFloor({ wallets: [], activationsPerMonth: [], unusedCredits: { annual: 0, monthly: 100 }, now: d("2026-11-16T00:00:00Z") }).floor).toBe("0.0000000");
  });

  it("covers 2 months of live wallets plus expected new monthly wallets", () => {
    const wallets: ManagedWallet[] = Array.from({ length: 34 }, () => ({ plan: "monthly", activatedAt: d("2026-11-20T00:00:00Z") }));
    const result = managementFloor({ wallets, activationsPerMonth: [10, 20], unusedCredits: { annual: 0, monthly: 66 }, now: d("2026-11-25T00:00:00Z") });
    // Growth capped at 50 %: 30 new in December, then 45 expected in January but only 36 credits left. The 34 existing count in both.
    expect(result.projectedWallets).toEqual([64, 100]);
    expect(result.floor).toBe("16.4000000");
  });

  it("never expects more new wallets than the credits left, and spends yearly credits first", () => {
    const result = managementFloor({ wallets: [], activationsPerMonth: [50, 50], unusedCredits: { annual: 60, monthly: 20 }, now: d("2026-11-25T00:00:00Z") });
    // month 1: 50 annual; month 2: 10 annual + 20 monthly (credit-limited), so only 20 monthly wallets ever.
    expect(result.projectedWallets).toEqual([0, 20]);
  });

  it("counts an annual wallet once its prepaid year has ended inside the window", () => {
    const wallets: ManagedWallet[] = [{ plan: "annual", activatedAt: d("2025-12-10T00:00:00Z"), paidUntil: annualPaidUntil(d("2025-12-10T00:00:00Z")) }];
    expect(managementFloor({ wallets, activationsPerMonth: [], unusedCredits: { annual: 0, monthly: 0 }, now: d("2026-11-25T00:00:00Z") }).projectedWallets).toEqual([0, 1]);
  });
});
