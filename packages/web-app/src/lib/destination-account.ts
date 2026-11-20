import type * as StellarSdk from "@stellar/stellar-sdk";

export const NEW_ACCOUNT_MIN_MESSAGE = "A new account needs at least 1 XLM to be created.";
export const ACTIVATE_FIRST_MESSAGE = "The recipient must activate their account first.";

export type DestinationPlan = { kind: "payment" } | { kind: "createAccount" } | { kind: "error"; message: string };

const isNotFound = (e: unknown): boolean => (e as { response?: { status?: number } } | null)?.response?.status === 404;

/**
 * A Stellar payment to an account that does not exist yet always fails (op_no_destination). Native XLM must
 * create the account instead (createAccount, starting balance at least 1 XLM); a token cannot reach it at all.
 * Any lookup failure other than "not found" falls back to a payment: the server explains a rejection.
 */
export async function planDestination(
  srv: { loadAccount(id: string): Promise<unknown> },
  destination: string,
  isNative: boolean,
  amount: string,
): Promise<DestinationPlan> {
  try {
    await srv.loadAccount(destination);
    return { kind: "payment" };
  } catch (e) {
    if (!isNotFound(e)) return { kind: "payment" };
  }
  if (!isNative) return { kind: "error", message: ACTIVATE_FIRST_MESSAGE };
  if (!(Number(amount) >= 1)) return { kind: "error", message: NEW_ACCOUNT_MIN_MESSAGE };
  return { kind: "createAccount" };
}

/** The operation that delivers `amount` to the destination, for a plan that is not an error. */
export function destinationOperation(
  plan: { kind: "payment" } | { kind: "createAccount" },
  o: { destination: string; asset: StellarSdk.Asset; amount: string },
  Operation: Pick<typeof StellarSdk.Operation, "payment" | "createAccount">,
) {
  return plan.kind === "createAccount"
    ? Operation.createAccount({ destination: o.destination, startingBalance: o.amount })
    : Operation.payment({ destination: o.destination, asset: o.asset, amount: o.amount });
}
