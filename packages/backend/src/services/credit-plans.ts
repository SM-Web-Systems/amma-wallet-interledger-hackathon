/**
 * Business credit plans: pricing, deposit matching and wallet management fees (owner decisions of 16 Nov 2026).
 *
 * Pure functions only, no database or network access, so every money rule is unit-tested here and the
 * deposit watcher, activation intake and monthly job (later stages) all call the same code.
 *
 * Per user in a bundle:
 *   monthly plan: 1.1 wallet funding + 2 platform fee + 0.3 management (3 months at 0.1) = 3.4 XLM
 *   annual plan:  1.1 wallet funding + 2 platform fee + 1.0 management (12 months, discounted) = 4.1 XLM
 * First deposit only: + 1 XLM account reserve + 100 XLM registration fee (the fee can be waived per business).
 *
 * Where each part goes when a deposit confirms:
 *   funding (1.1 each)            -> the business's funding pot, drawn 1.1 per activation
 *   monthly management (0.3 each) -> the business's management pot, charged 0.1 per live wallet per month
 *   platform fee, annual management, registration fee -> swept to the business's fee address (owner's hardware wallet)
 *   reserve (1)                   -> stays locked on the business wallet
 * No refunds: businesses buy credits.
 */

export type Plan = "monthly" | "annual";

// All amounts are XLM decimal strings; the arithmetic below is exact (stroops, 7 decimals).
export const PRICING = {
  fundingPerUser: "1.1",
  platformFeePerUser: "2",
  monthlyManagementFee: "0.1",
  managementPerUser: { monthly: "0.3", annual: "1" } as Record<Plan, string>,
  includedMonths: { monthly: 3, annual: 12 } as Record<Plan, number>,
  registrationFee: "100",
  accountReserve: "1",
  floorMonths: 2,
  maxMonthlyGrowth: 0.5,
} as const;

const MAX_USERS = 1_000_000;
const SCALE = 10_000_000n;

export function toStroops(amount: string): bigint {
  if (!/^-?\d{1,12}(\.\d{1,7})?$/.test(amount)) throw new Error("Invalid XLM amount");
  const negative = amount.startsWith("-");
  const [whole, frac = ""] = (negative ? amount.slice(1) : amount).split(".");
  const stroops = BigInt(whole) * SCALE + BigInt(frac.padEnd(7, "0"));
  return negative ? -stroops : stroops;
}

export function fromStroops(stroops: bigint): string {
  const negative = stroops < 0n;
  const abs = negative ? -stroops : stroops;
  return `${negative ? "-" : ""}${abs / SCALE}.${(abs % SCALE).toString().padStart(7, "0")}`;
}

const times = (amount: string, n: number) => toStroops(amount) * BigInt(n);

function assertUsers(users: number) {
  if (!Number.isInteger(users) || users < 1 || users > MAX_USERS) throw new Error("users must be a whole number from 1 to 1000000");
}

export interface BundleQuote {
  plan: Plan;
  users: number;
  perUser: string;
  funding: string;
  platformFee: string;
  management: string;
  total: string;
}

export function bundleQuote(plan: Plan, users: number): BundleQuote {
  assertUsers(users);
  const funding = times(PRICING.fundingPerUser, users);
  const platformFee = times(PRICING.platformFeePerUser, users);
  const management = times(PRICING.managementPerUser[plan], users);
  const perUser = toStroops(PRICING.fundingPerUser) + toStroops(PRICING.platformFeePerUser) + toStroops(PRICING.managementPerUser[plan]);
  return {
    plan, users, perUser: fromStroops(perUser),
    funding: fromStroops(funding), platformFee: fromStroops(platformFee), management: fromStroops(management),
    total: fromStroops(funding + platformFee + management),
  };
}

export interface DepositQuote extends BundleQuote {
  registrationFee: string;
  reserve: string;
  depositTotal: string;
  /** What moves to the fee address once the deposit confirms. */
  toFeeAddress: string;
  /** What stays in the business's pots. */
  toFundingPot: string;
  toManagementPot: string;
}

export function depositQuote(plan: Plan, users: number, opts: { firstDeposit: boolean; waiveRegistrationFee?: boolean }): DepositQuote {
  const bundle = bundleQuote(plan, users);
  const registration = opts.firstDeposit && !opts.waiveRegistrationFee ? toStroops(PRICING.registrationFee) : 0n;
  const reserve = opts.firstDeposit ? toStroops(PRICING.accountReserve) : 0n;
  // Annual management is earned up front (no refunds) and swept with the fee; monthly management stays as a float.
  const annualManagement = plan === "annual" ? toStroops(bundle.management) : 0n;
  return {
    ...bundle,
    registrationFee: fromStroops(registration),
    reserve: fromStroops(reserve),
    depositTotal: fromStroops(toStroops(bundle.total) + registration + reserve),
    toFeeAddress: fromStroops(toStroops(bundle.platformFee) + annualManagement + registration),
    toFundingPot: bundle.funding,
    toManagementPot: plan === "monthly" ? bundle.management : fromStroops(0n),
  };
}

export interface CatalogBundle { slug: string; plan: Plan; users: number }

export type DepositMatch =
  | { kind: "bundle"; slug: string; quote: DepositQuote }
  | { kind: "unmatched"; reason: "no_bundle_matches_amount" | "amount_matches_more_than_one_bundle" };

/**
 * A deposit is credited only when it equals exactly one bundle's price (with the first-deposit extras on the first one).
 * Anything else is held as an unallocated deposit and escalated to the owner by email.
 */
export function matchDeposit(amount: string, catalog: CatalogBundle[], opts: { firstDeposit: boolean; waiveRegistrationFee?: boolean }): DepositMatch {
  const received = toStroops(amount);
  const hits = catalog
    .map((b) => ({ slug: b.slug, quote: depositQuote(b.plan, b.users, opts) }))
    .filter((h) => toStroops(h.quote.depositTotal) === received);
  if (hits.length === 1) return { kind: "bundle", ...hits[0] };
  return { kind: "unmatched", reason: hits.length ? "amount_matches_more_than_one_bundle" : "no_bundle_matches_amount" };
}

/** Yearly credits are used first, then monthly. Null means no credit is left. */
export function nextCredit(credits: { annual: number; monthly: number }): Plan | null {
  if (credits.annual > 0) return "annual";
  if (credits.monthly > 0) return "monthly";
  return null;
}

/** First instant of the calendar month (UTC) `months` after the one `date` falls in. */
export function monthStart(date: Date, months = 0): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + months, 1));
}

/** An annual wallet's management is prepaid until this instant; after it the wallet drops to monthly. */
export function annualPaidUntil(activatedAt: Date): Date {
  return new Date(Date.UTC(activatedAt.getUTCFullYear(), activatedAt.getUTCMonth() + PRICING.includedMonths.annual, activatedAt.getUTCDate(),
    activatedAt.getUTCHours(), activatedAt.getUTCMinutes(), activatedAt.getUTCSeconds(), activatedAt.getUTCMilliseconds()));
}

export interface ManagedWallet {
  plan: Plan;
  activatedAt: Date;
  /** Annual wallets only: when the prepaid year ends. */
  paidUntil?: Date | null;
  deletedAt?: Date | null;
}

/**
 * A wallet is charged 0.1 XLM for a calendar month when it was activated before the month ends, was not deleted before the
 * month starts, and is not inside a prepaid annual year at the start of the month. Sign-ins play no part.
 * (Monthly wallets are charged from their activation month; their 0.3 covers that month and the next two.)
 */
export function isBillable(wallet: ManagedWallet, month: Date): boolean {
  const start = monthStart(month);
  const end = monthStart(month, 1);
  if (wallet.activatedAt >= end) return false;
  if (wallet.deletedAt && wallet.deletedAt < start) return false;
  if (wallet.plan === "annual" && wallet.paidUntil && wallet.paidUntil > start) return false;
  return true;
}

export function monthlyManagementCharge(wallets: ManagedWallet[], month: Date): { billableWallets: number; amount: string } {
  const billableWallets = wallets.filter((w) => isBillable(w, month)).length;
  return { billableWallets, amount: fromStroops(times(PRICING.monthlyManagementFee, billableWallets)) };
}

/**
 * Average month-on-month growth of activations over the recent months (oldest first), clamped to 0..50 %
 * so a dip never lowers the floor and one spike can't demand a huge balance.
 */
export function projectedGrowth(activationsPerMonth: number[]): number {
  const rates: number[] = [];
  for (let i = 1; i < activationsPerMonth.length; i++) {
    const before = activationsPerMonth[i - 1];
    if (before > 0) rates.push(activationsPerMonth[i] / before - 1);
  }
  if (!rates.length) return 0;
  const average = rates.reduce((a, b) => a + b, 0) / rates.length;
  return Math.min(PRICING.maxMonthlyGrowth, Math.max(0, average));
}

export interface FloorInput {
  wallets: ManagedWallet[];
  /** Activations in each of the last few calendar months, oldest first. */
  activationsPerMonth: number[];
  /** Credits still unused; new activations can't exceed them. */
  unusedCredits: { annual: number; monthly: number };
  now: Date;
}

/**
 * The management pot must never dip below 2 months of fees: the wallets billable in each of the next 2 months,
 * plus the monthly-plan wallets expected to be activated in that time at the projected growth rate.
 * Annual wallets count from 2 months before their year ends, so the balance is ready when they drop to monthly.
 */
export function managementFloor(input: FloorInput): { floor: string; projectedWallets: number[] } {
  const growth = projectedGrowth(input.activationsPerMonth);
  const recent = input.activationsPerMonth.length ? input.activationsPerMonth[input.activationsPerMonth.length - 1] : 0;
  // Annual credits are used first, so expected new monthly-plan wallets start only once annual credits run out.
  let annualLeft = input.unusedCredits.annual;
  let monthlyLeft = input.unusedCredits.monthly;
  let expectedNewMonthly = 0;
  const projectedWallets: number[] = [];
  let total = 0n;
  for (let m = 1; m <= PRICING.floorMonths; m++) {
    const month = monthStart(input.now, m);
    const existing = input.wallets.filter((w) => isBillable(w, month)).length;
    let expected = Math.round(recent * Math.pow(1 + growth, m));
    const fromAnnual = Math.min(annualLeft, expected);
    annualLeft -= fromAnnual; expected -= fromAnnual;
    const fromMonthly = Math.min(monthlyLeft, expected);
    monthlyLeft -= fromMonthly;
    expectedNewMonthly += fromMonthly;
    const count = existing + expectedNewMonthly;
    projectedWallets.push(count);
    total += times(PRICING.monthlyManagementFee, count);
  }
  return { floor: fromStroops(total), projectedWallets };
}
