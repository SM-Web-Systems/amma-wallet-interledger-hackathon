import { sql, type SQL } from "drizzle-orm";
import { appLog } from "../../lib/app-log";
import type { CustodyFlags } from "../../lib/custody-flags";
import { stellarFriendbot } from "./stellar-friendbot";
import { xrplFaucet } from "./xrpl-faucet";
import { assertTreasuryKey, sepoliaClientsFromEnv, sepoliaDrip } from "./sepolia-drip";

export interface FundingAdapter { chain: "stellar" | "xrpl" | "evm"; fund(address: string): Promise<{ amount: string; reference: string }> }
export type WelcomeDb = { query: (sql: string, params?: unknown[]) => Promise<any[]>; transaction?: <T>(fn: (tx: WelcomeDb) => Promise<T>) => Promise<T> };

const MAX_ATTEMPTS = 3;
const HOUR = 3_600_000;

/** Only short codes ever reach a row or a log. */
function errorCode(e: unknown): string {
  let found = "faucet-unavailable";
  for (let cur: any = e, i = 0; cur && i < 8; cur = cur.cause, i++) {
    if (cur.name === "TreasuryLow") return "treasury-low";
    if (cur.name === "TimeoutError" || cur.name === "AbortError") found = "timeout";
  }
  return found;
}

export class WelcomeFunding {
  private adapters: Map<string, FundingAdapter>;
  private now: () => Date;
  constructor(private opts: { adapters: FundingAdapter[]; flags: CustodyFlags; db: WelcomeDb; now?: () => Date }) {
    this.adapters = new Map(opts.adapters.map((a) => [a.chain, a]));
    this.now = opts.now ?? (() => new Date());
  }

  /** Onboarding: queue rows for exactly the custody-created addresses, then process. Never throws. */
  async enqueue(userId: number, wallets: { stellar: string; xrpl: string; evm: string }): Promise<void> {
    await this.guard(async () => {
      const now = this.now();
      for (const chain of ["stellar", "xrpl", "evm"] as const)
        await this.opts.db.query(`INSERT INTO welcome_funding (user_id, chain, address, state, created_at, updated_at) VALUES ($1,$2,$3,'queued',$4,$4) ON CONFLICT (user_id, chain) DO NOTHING`, [userId, chain, wallets[chain], now]);
      await this.process(userId);
    });
  }

  /** Status call: process existing rows only, never insert. Never throws. */
  async retry(userId: number): Promise<void> { await this.guard(() => this.process(userId)); }

  private async guard(fn: () => Promise<void>): Promise<void> {
    try { await fn(); } catch { appLog().error({ code: "internal" }, "welcome_funding_failed"); }
  }

  private async process(userId: number): Promise<void> {
    const { db, flags } = this.opts;
    const now = this.now();
    const cutoff = new Date(now.getTime() - HOUR);
    const rows = await db.query(
      `SELECT id, chain, address, state FROM welcome_funding WHERE user_id = $1 AND attempts < $2 AND (
         (state IN ('queued','failed') AND (attempts = 0 OR updated_at < $3)) OR (state = 'skipped' AND (error = 'email-unverified' OR (error = 'daily-cap' AND updated_at < $4)))) ORDER BY id`, [userId, MAX_ATTEMPTS, cutoff, new Date(now.getTime() - 24 * HOUR)]);
    if (!rows.length) return;
    const user = (await db.query(`SELECT is_email_verified FROM users WHERE id = $1`, [userId]))[0];
    const verified = user?.is_email_verified === true;
    const dayAgo = new Date(now.getTime() - 24 * HOUR);
    const set = (id: number, state: string, error: string | null, extra: { amount?: string; reference?: string } = {}, d: WelcomeDb = db) =>
      d.query(`UPDATE welcome_funding SET state=$2, error=$3, amount=COALESCE($4, amount), reference=COALESCE($5, reference), updated_at=$6 WHERE id=$1`, [id, state, error, extra.amount ?? null, extra.reference ?? null, now]);
    for (const row of rows) {
      if (!verified) { await set(row.id, "skipped", "email-unverified"); continue; }
      const adapter = this.adapters.get(row.chain);
      if (!adapter) { await set(row.id, "skipped", "not-configured"); continue; }
      // Claim the row so two overlapping runs never fund it twice.
      const claim = async (d: WelcomeDb) => (await d.query(
        `UPDATE welcome_funding SET state = 'queued', attempts = attempts + 1, updated_at = $2 WHERE id = $1 AND attempts < $3 AND (
           (state IN ('queued','failed') AND (attempts = 0 OR updated_at < $4)) OR
           (state = 'skipped' AND (error = 'email-unverified' OR (error = 'daily-cap' AND updated_at < $5)))) RETURNING id`, [row.id, now, MAX_ATTEMPTS, cutoff, dayAgo])).length > 0;
      let ok: boolean;
      if (row.chain === "evm") {
        // The daily cap protects the Sepolia treasury only. Count and claim under one lock; in-flight claims count too.
        const body = async (d: WelcomeDb) => {
          await d.query(`SELECT pg_advisory_xact_lock(hashtext('welcome-funding-evm'))`);
          const cap = await d.query(`SELECT count(*)::int AS n FROM welcome_funding WHERE chain = 'evm' AND id <> $2 AND updated_at > $1 AND (state IN ('sent','confirmed') OR (state = 'queued' AND attempts > 0))`, [dayAgo, row.id]);
          if (Number(cap[0]?.n ?? 0) >= flags.dailyCap) { await set(row.id, "skipped", "daily-cap", {}, d); return false; }
          return claim(d);
        };
        ok = db.transaction ? await db.transaction(body) : await body(db);
      } else ok = await claim(db);
      if (!ok) continue;
      try {
        const r = await adapter.fund(row.address);
        await set(row.id, "sent", null, { amount: r.amount, reference: r.reference || undefined });
      } catch (e) {
        const code = errorCode(e);
        appLog().error({ chain: row.chain, code }, "welcome_funding_failed");
        await set(row.id, "failed", code);
      }
    }
  }
}

/** Adapters from env. Sepolia needs both variables; an invalid treasury key stops start-up without echoing it. */
export function welcomeAdaptersFromEnv(env: Record<string, string | undefined>, flags: CustodyFlags): FundingAdapter[] {
  const adapters: FundingAdapter[] = [stellarFriendbot(), xrplFaucet()];
  const rpc = env.WELCOME_SEPOLIA_RPC_URL, key = env.WELCOME_SEPOLIA_TREASURY_KEY;
  if (rpc && key) { assertTreasuryKey(key); adapters.push(sepoliaDrip(sepoliaClientsFromEnv(rpc, key), flags.sepoliaWei)); }
  return adapters;
}

/** Adapter from the app's drizzle db to the plain query interface ($1 placeholders). */
// postgres-js through drizzle does not serialise Date parameters (PGlite does), so send ISO strings.
function toParam(v: unknown): any { return v instanceof Date ? v.toISOString() : v; }

export function drizzleWelcomeDb(db: { execute: (q: SQL) => Promise<any>; transaction?: <T>(fn: (tx: any) => Promise<T>) => Promise<T> }): WelcomeDb {
  return {
    async query(text, params = []) {
      const parts = text.split(/\$(\d+)/);
      const chunks: SQL[] = parts.map((p, i) => (i % 2 === 0 ? sql.raw(p) : sql`${toParam(params[Number(p) - 1])}`));
      const res = await db.execute(sql.join(chunks, sql.raw("")));
      return Array.isArray(res) ? res : (res?.rows ?? []);
    },
    transaction: db.transaction ? (fn) => db.transaction!((tx) => fn(drizzleWelcomeDb(tx))) : undefined,
  };
}
