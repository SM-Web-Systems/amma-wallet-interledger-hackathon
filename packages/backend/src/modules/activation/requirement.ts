/**
 * Activation requirement per task (stage 4 of the business activation plan).
 *
 * A task is either "signed call only" (the partner's signed call is enough, today's behaviour) or "holds an NFT from contract X
 * on network Y". For the NFT rule Amma reads the chain itself before any XLM is sent or any credit drawn: the learner's own
 * Amma-held Stellar address must hold at least one token of that SEP-50 contract. If not, the call is refused with
 * REQUIREMENT_NOT_MET and nothing is charged.
 *
 * The chain read happens before the intake transaction, never inside it: a slow RPC must not hold the intake lock. The
 * transaction then re-reads the task and only accepts a result checked against the same contract and network.
 *
 * The task's rule is read with to_jsonb(t), so this works before and after activation-requirements-v1 is applied: no column,
 * no rule. Once a rule is set it is always enforced; there is no switch that can make the server ignore it.
 */
import * as StellarSdk from "@stellar/stellar-sdk";
import { sql } from "drizzle-orm";
import { sorobanTargetFor, type Sep50Network } from "../nft/sep50-network";
import { rowsOf, type Executor } from "./errors";

export type TaskRequirement = { kind: "signed_call" } | { kind: "holds_nft"; contract: string; network: Sep50Network };

/** What one holder read found. "refused" means the contract would not answer (wrong id, or no SEP-50 balance method). */
export type Holding = "holds" | "none" | "refused";
/** Throws when the chain can't be read, so an RPC fault is never taken as "doesn't hold". */
export type NftHolding = (contract: string, network: Sep50Network, address: string) => Promise<Holding>;

export type RequirementCheck =
  | { kind: "holds_nft"; contract: string; network: Sep50Network; outcome: "met" | "not_met" | "unavailable"; reason?: string };

const CONTRACT = /^C[A-Z2-7]{55}$/;

/** The task's rule as stored, or signed_call when the column isn't there yet or the row says so. */
export function requirementOf(row: { requirement_kind?: string | null; requirement_contract?: string | null; requirement_network?: string | null }): TaskRequirement {
  if (row.requirement_kind === "holds_nft" && row.requirement_contract && (row.requirement_network === "public" || row.requirement_network === "testnet")) {
    return { kind: "holds_nft", contract: row.requirement_contract, network: row.requirement_network };
  }
  if (row.requirement_kind && row.requirement_kind !== "signed_call") {
    // A rule this build doesn't understand is never read as "no rule".
    return { kind: "holds_nft", contract: "unreadable", network: "public" };
  }
  return { kind: "signed_call" };
}

/** Columns for a partner_tasks row aliased t; null when activation-requirements-v1 isn't applied. */
export const REQUIREMENT_COLUMNS = sql`to_jsonb(t)->>'requirement_kind' AS requirement_kind, to_jsonb(t)->>'requirement_contract' AS requirement_contract, to_jsonb(t)->>'requirement_network' AS requirement_network`;

/**
 * The outside-the-transaction half: reads the task's rule and, for an NFT rule, the chain. Returns null when there is nothing to
 * check (signed call only, unknown task, a replayed idempotency key, or a user not linked to this partner); the transaction
 * then gives its usual answer. Never throws for a chain fault: that is outcome "unavailable".
 */
export async function preCheckRequirement(
  db: Executor, holding: NftHolding | undefined,
  input: { tenantId: number; taskKey: string; userId: number; idempotencyKey: string },
): Promise<RequirementCheck | null> {
  const one = async <T,>(q: ReturnType<typeof sql>) => rowsOf<T>(await db.execute(q))[0];
  if (await one(sql`SELECT 1 FROM partner_task_completions WHERE tenant_id = ${input.tenantId} AND idempotency_key = ${input.idempotencyKey}`)) return null;
  const task = await one<{ requirement_kind: string | null; requirement_contract: string | null; requirement_network: string | null }>(sql`
    SELECT ${REQUIREMENT_COLUMNS} FROM partner_tasks t WHERE t.tenant_id = ${input.tenantId} AND t.task_key = ${input.taskKey} AND t.is_active = true`);
  if (!task) return null;
  const rule = requirementOf(task);
  if (rule.kind === "signed_call") return null;
  // Only for a user this partner already has: a partner can't use the rule to ask the chain about strangers.
  if (!(await one(sql`SELECT 1 FROM tenant_users WHERE tenant_id = ${input.tenantId} AND user_id = ${input.userId}`))) return null;
  const base = { kind: "holds_nft" as const, contract: rule.contract, network: rule.network };
  if (!CONTRACT.test(rule.contract)) return { ...base, outcome: "not_met", reason: "rule_unreadable" };
  if (!holding) return { ...base, outcome: "unavailable", reason: "no_checker" };
  // The learner's own Amma-held Stellar address. A Stellar key is the same on every network, so any index-0 wallet counts.
  const addresses = rowsOf<{ public_key: string }>(await db.execute(sql`
    SELECT DISTINCT public_key FROM user_wallets WHERE user_id = ${input.userId} AND chain = 'stellar' AND derivation_index = 0 AND is_active = true`))
    .map((r) => r.public_key).filter((a) => StellarSdk.StrKey.isValidEd25519PublicKey(a));
  if (!addresses.length) return { ...base, outcome: "not_met", reason: "no_stellar_address" };
  let refused = false;
  for (const address of addresses) {
    let found: Holding;
    try { found = await holding(rule.contract, rule.network, address); } catch { return { ...base, outcome: "unavailable", reason: "chain_unreadable" }; }
    if (found === "holds") return { ...base, outcome: "met" };
    if (found === "refused") refused = true;
  }
  return { ...base, outcome: "not_met", reason: refused ? "contract_refused" : "no_token" };
}

// Any valid account id: a simulation is never signed or submitted. Same one the NFT reads use.
const SIMULATION_SOURCE = "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF";
const READ_TIMEOUT_MS = 5_000;

/**
 * The real holder read: SEP-50 balance(owner) simulated on the contract's own network (never a transaction, never a fee).
 * Throws on an RPC fault or after 5 seconds.
 */
export function sorobanNftHolding(env: Record<string, string | undefined> = process.env): NftHolding {
  const servers = new Map<string, StellarSdk.rpc.Server>();
  return async (contract, network, address) => {
    const target = sorobanTargetFor(network, env);
    let server = servers.get(target.rpcUrl);
    if (!server) { server = new StellarSdk.rpc.Server(target.rpcUrl); servers.set(target.rpcUrl, server); }
    const tx = new StellarSdk.TransactionBuilder(new StellarSdk.Account(SIMULATION_SOURCE, "0"), { fee: "100", networkPassphrase: target.passphrase })
      .addOperation(new StellarSdk.Contract(contract).call("balance", new StellarSdk.Address(address).toScVal())).setTimeout(30).build();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const result = await Promise.race([
        server.simulateTransaction(tx),
        new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("timeout")), READ_TIMEOUT_MS); }),
      ]);
      if (!StellarSdk.rpc.Api.isSimulationSuccess(result) || !result.result?.retval) return "refused";
      return holdingFrom(StellarSdk.scValToNative(result.result.retval));
    } finally { if (timer) clearTimeout(timer); }
  };
}

/** A SEP-50 balance is a u32; anything above zero holds. */
export function holdingFrom(value: unknown): Holding {
  if (typeof value === "number" || typeof value === "bigint") return BigInt(value) > 0n ? "holds" : "none";
  return "refused";
}
