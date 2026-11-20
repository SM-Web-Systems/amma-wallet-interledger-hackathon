import type { SQL } from "drizzle-orm";

/** An expected refusal. Only the short code and status reach a client; nothing else is ever serialised. */
export class ActivationError extends Error {
  constructor(public code: string, public status: number, public retryable = false, public retryAfter?: number, /** Internal reason for the audit row only; never sent to a partner. */ public reason?: string) { super(code); }
}

/** The one shape both drivers return rows in (postgres-js returns an array, PGlite an object with rows). */
export const rowsOf = <T,>(result: unknown): T[] => (((result as { rows?: unknown })?.rows ?? result) as T[]);

export type Executor = { execute: (query: SQL) => Promise<unknown> };
export type ActivationDb = Executor & { transaction: <T>(fn: (tx: any) => Promise<T>) => Promise<T> };

// postgres-js does not serialise Date parameters (PGlite does), so every timestamp parameter is an ISO string.
export const iso = (d: Date): string => d.toISOString();

export const stroopsToXlm = (s: bigint): string => `${s / 10_000_000n}.${(s % 10_000_000n).toString().padStart(7, "0")}`;
