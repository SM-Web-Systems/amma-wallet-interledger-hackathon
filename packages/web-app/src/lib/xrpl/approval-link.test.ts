import { describe,it,expect } from "vitest";
import { parseApprovalTarget,approvalReturnPath } from "./approval-link";
const id="12345678-1234-4123-8123-123456789abc";
describe("approval selectors and login return paths",()=>{
  it("carries selectors only and does not supply an approval or payment fields",()=>{
    expect(parseApprovalTarget("")).toBeNull();expect(parseApprovalTarget(`?walletId=12&intentId=${id}`)).toEqual({walletId:"12",intentId:id});
    expect(approvalReturnPath(`/xrpl?intentId=${id}&walletId=12`)).toBe(`/xrpl?walletId=12&intentId=${id}`);
  });
  it.each([`?walletId=01&intentId=${id}`,`?walletId=1&intentId=${id}&amountDrops=1`,`?walletId=1&intentId=${id}&approved=true`,`?walletId=1&intentId=${id}&intentId=${id}`,"?walletId=1","?intentId=invalid"])("rejects malformed or injectable selector %s",query=>{expect(()=>parseApprovalTarget(query)).toThrow();});
  it.each(["https://evil.invalid/xrpl?walletId=1", "//evil.invalid", "/dashboard", "/xrpl?returnUrl=https://evil.invalid",null,{},"/xrpl?walletId=1&intentId="+id+"#evil"])("never creates an arbitrary login redirect",path=>{expect(approvalReturnPath(path)).toBeNull();});
});
