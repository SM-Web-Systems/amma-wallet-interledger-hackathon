import {afterEach,describe,expect,it,vi} from "vitest";
vi.mock("./payment-service",()=>({XrplPaymentService:vi.fn()}));
import {startXrplRecoveryWorker} from "./recovery-worker";
import {readXrplRecoveryConfig} from "./config";
afterEach(()=>{vi.useRealTimers();});
describe("reconciliation scheduler",()=>{
  it("is off by default and accepts read-only recovery while payment broadcasting is disabled",()=>{
    expect(readXrplRecoveryConfig({})).toEqual({enabled:false,intervalMs:15000,batchSize:10});
    expect(readXrplRecoveryConfig({XRPL_ENABLED:"true",XRPL_RECONCILIATION_ENABLED:"true"}).enabled).toBe(true);
    expect(()=>readXrplRecoveryConfig({XRPL_RECONCILIATION_ENABLED:"true"})).toThrow();
    expect(()=>readXrplRecoveryConfig({XRPL_RECONCILIATION_INTERVAL_MS:"1"})).toThrow();
    expect(()=>readXrplRecoveryConfig({XRPL_RECONCILIATION_BATCH_SIZE:"100"})).toThrow();
  });
  it("does not instantiate or query a service while disabled",async()=>{
    const factory=vi.fn();await startXrplRecoveryWorker({enabled:false,intervalMs:15000,batchSize:10},()=>true,vi.fn(),factory)();expect(factory).not.toHaveBeenCalled();
  });
  it("runs at startup, never overlaps, reads the broadcast kill switch and stops cleanly",async()=>{
    vi.useFakeTimers();let resolve!:(count:number)=>void;let broadcast=false;
    const reconcileBatch=vi.fn().mockImplementationOnce(()=>new Promise<number>(done=>{resolve=done;})).mockResolvedValue(0);
    const stop=startXrplRecoveryWorker({enabled:true,intervalMs:15000,batchSize:3},()=>broadcast,vi.fn(),()=>({reconcileBatch}));
    expect(reconcileBatch).toHaveBeenCalledTimes(1);expect(reconcileBatch.mock.calls[0][1]).toBe(false);
    await vi.advanceTimersByTimeAsync(45000);expect(reconcileBatch).toHaveBeenCalledTimes(1);
    resolve(1);await vi.advanceTimersByTimeAsync(0);broadcast=true;await vi.advanceTimersByTimeAsync(15000);
    expect(reconcileBatch).toHaveBeenCalledTimes(2);expect(reconcileBatch.mock.calls[1][1]).toBe(true);
    await stop();await vi.advanceTimersByTimeAsync(60000);expect(reconcileBatch).toHaveBeenCalledTimes(2);
    expect(reconcileBatch.mock.calls[0][2].aborted).toBe(true);
  });
  it("sanitizes failures and retries later without leaking a blob or database error",async()=>{
    vi.useFakeTimers();const log=vi.fn(),reconcileBatch=vi.fn().mockRejectedValueOnce(new Error("sensitive raw details")).mockResolvedValue(0);
    const stop=startXrplRecoveryWorker({enabled:true,intervalMs:15000,batchSize:1},()=>false,log,()=>({reconcileBatch}));
    await vi.advanceTimersByTimeAsync(15000);expect(log).toHaveBeenCalledWith({event:"xrpl_reconciliation_unavailable"});expect(JSON.stringify(log.mock.calls)).not.toContain("sensitive");await stop();
  });
});
