/** Stable, user-safe error codes. Messages never include keys, mnemonics or raw RPC payloads. */
export class EvmError extends Error {
  readonly code: string;
  readonly retryable: boolean;
  constructor(code: string, retryable = false) {
    super(code.replaceAll("_", " ").toLowerCase());
    this.code = code;
    this.retryable = retryable;
    this.name = "EvmError";
  }
}
export const fail = (code: string, retryable = false): never => { throw new EvmError(code, retryable); };
export function ensure(condition: unknown, code: string): asserts condition { if (!condition) fail(code); }
