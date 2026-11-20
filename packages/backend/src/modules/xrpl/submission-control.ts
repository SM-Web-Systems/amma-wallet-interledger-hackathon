import { openSync, readSync, fstatSync, closeSync } from "node:fs";
import { isAbsolute } from "node:path";
import { PaymentError } from "./payment";

export type SubmissionGate = () => void;
export type SubmissionAvailability = { available: boolean; code: "AVAILABLE" | "XRPL_PAYMENTS_DISABLED" | "XRPL_SUBMISSION_PAUSED" | "XRPL_CONTROL_UNAVAILABLE" };

/** Operator-owned read-only mount, reread at every admission and actual RPC send. */
export function submissionAvailability(env: NodeJS.ProcessEnv = process.env): SubmissionAvailability {
  if (env.XRPL_ENABLED !== "true" || env.XRPL_PAYMENTS_ENABLED !== "true") return {available:false,code:"XRPL_PAYMENTS_DISABLED"};
  const path=env.XRPL_SUBMISSION_CONTROL_FILE;
  if(!path||!isAbsolute(path))return {available:false,code:"XRPL_CONTROL_UNAVAILABLE"};
  let fd: number | undefined;
  try {
    fd=openSync(path,"r");
    const stat=fstatSync(fd);
    if(!stat.isFile()||stat.size<1||stat.size>256)return {available:false,code:"XRPL_CONTROL_UNAVAILABLE"};
    const buffer=Buffer.alloc(257),size=readSync(fd,buffer,0,257,0);
    if(size>256)return {available:false,code:"XRPL_CONTROL_UNAVAILABLE"};
    const input=JSON.parse(buffer.subarray(0,size).toString("utf8"));
    if(!input||typeof input!=="object"||Array.isArray(input)||Object.keys(input).sort().join()!=="paused,schemaVersion"||input.schemaVersion!==1||typeof input.paused!=="boolean")return {available:false,code:"XRPL_CONTROL_UNAVAILABLE"};
    return input.paused?{available:false,code:"XRPL_SUBMISSION_PAUSED"}:{available:true,code:"AVAILABLE"};
  } catch {return {available:false,code:"XRPL_CONTROL_UNAVAILABLE"};}
  finally {if(fd!==undefined)closeSync(fd);}
}
export function assertSubmissionAllowed(env: NodeJS.ProcessEnv = process.env): void {
  const result=submissionAvailability(env);
  if(!result.available)throw new PaymentError(result.code,503,true);
}
export function gateAvailability(gate: SubmissionGate): SubmissionAvailability {
  try {gate();return {available:true,code:"AVAILABLE"};}
  catch(cause){return {available:false,code:cause instanceof PaymentError&&["XRPL_PAYMENTS_DISABLED","XRPL_SUBMISSION_PAUSED"].includes(cause.code)?cause.code as "XRPL_PAYMENTS_DISABLED"|"XRPL_SUBMISSION_PAUSED":"XRPL_CONTROL_UNAVAILABLE"};}
}
