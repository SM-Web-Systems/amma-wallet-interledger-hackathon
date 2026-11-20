import { XrplReadAdapter } from "./read-adapter";
import { XrplReadError } from "./validation";
import { encodeAccountID } from "xrpl";

// Explicit opt-in, read-only diagnostic; not imported by API startup or tests.
async function main() {
  const adapter = new XrplReadAdapter();
  const health = await adapter.getHealth();
  if (health.status === "disabled") throw new XrplReadError("XRPL_DISABLED");
  const fee = await adapter.getFee();
  // Genesis public address: no seed creation, funding or signing takes place.
  const account = await adapter.getAccount("rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh");
  // Encode a fixed public account ID; no keypair or private seed is generated.
  const unfunded = await adapter.getAccount(encodeAccountID(new Uint8Array(20).fill(42)));
  const missing = await adapter.lookupTransaction("0".repeat(64));
  const transaction = process.env.XRPL_SMOKE_TRANSACTION_HASH
    ? await adapter.lookupTransaction(process.env.XRPL_SMOKE_TRANSACTION_HASH) : undefined;
  // Do not print raw transaction memos, even though the ledger is public.
  const transactionSummary = transaction?.status === "validated"
    ? { status: transaction.status, transactionHash: transaction.transactionHash, ledgerIndex: transaction.ledgerIndex, ledgerHash: transaction.ledgerHash, resultCode: transaction.resultCode }
    : transaction;
  console.log(JSON.stringify({ sdk: "xrpl@5.3.0", health, fee, account, unfunded, missing, transaction: transactionSummary }, null, 2));
}
main().catch((error: unknown) => {
  console.error(JSON.stringify({ status: "failed", code: error instanceof XrplReadError ? error.code : "XRPL_UNAVAILABLE" }));
  process.exitCode = 1;
});
