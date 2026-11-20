import { hashes } from "xrpl";
import {assertSubmissionAllowed,type SubmissionGate} from "./submission-control";
import { XrplReadAdapter, type ReadConnectionFactory } from "./read-adapter";
import { PaymentError } from "./payment";
import { transactionHash, XrplReadError } from "./validation";

/** Never signs, autofills, creates a replacement or interprets submit as finality. */
export class XrplPaymentAdapter extends XrplReadAdapter {
  constructor(env:NodeJS.ProcessEnv=process.env,factory?:ReadConnectionFactory,private readonly submissionGate:SubmissionGate=()=>assertSubmissionAllowed(env)){super(env,factory);}
  protected stopRetry(cause: unknown): boolean { return cause instanceof PaymentError || super.stopRetry(cause); }
  async submitSigned(blob: string, lastLedgerSequence: number, anchor?: { index: number; hash: string }): Promise<{ provisionalResult: string }> {
    if (!/^[A-F0-9]{100,4096}$/.test(blob) || blob.length % 2) throw new PaymentError("INVALID_SIGNED_BLOB", 400);
    const expectedHash = hashes.hashSignedTx(blob);
    return this.withEndpoint(async (read, ledger, submit) => {
      if (ledger.validatedLedgerIndex > lastLedgerSequence) throw new PaymentError("PAYMENT_UNRESOLVED", 409);
      if(anchor){
        if(ledger.validatedLedgerIndex<anchor.index)throw new XrplReadError("STALE_LEDGER",true);
        const original=await read({command:"ledger",ledger_index:anchor.index,transactions:false,expand:false});
        if(original.validated!==true||original.ledger_index!==anchor.index||transactionHash(original.ledger_hash)!==anchor.hash)throw new XrplReadError("LEDGER_RESET");
      }
      this.submissionGate();
      const response = await submit(blob);
      if (typeof response.engine_result !== "string" || !/^[A-Za-z][A-Za-z0-9_]{1,63}$/.test(response.engine_result)) throw new PaymentError("INVALID_SUBMISSION_RESPONSE", 503, true);
      const tx = response.tx_json;
      if (tx && typeof tx === "object" && "hash" in tx && String(tx.hash).toUpperCase() !== expectedHash) throw new PaymentError("INVALID_SUBMISSION_RESPONSE", 503, true);
      return { provisionalResult: response.engine_result };
    });
  }
}
