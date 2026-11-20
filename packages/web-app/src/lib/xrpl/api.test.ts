import { beforeEach, describe, expect, it, vi } from "vitest";
import { xrplWalletApi, xrplPaymentApi, setTokens, clearTokens } from "../api";
import type { PaymentInput } from "./payment";

beforeEach(() => { clearTokens(); vi.restoreAllMocks(); });
describe("XRP browser API boundary", () => {
  it("serializes only public metadata even when given extra runtime properties", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ id: "1" }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock); setTokens("unit-access-token", "unit-refresh-token");
    await xrplWalletApi.register({ name: "Test", address: "public-address", seed: "must-not-send", passphrase: "also-must-not-send" } as any);
    const request = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(JSON.parse(request[1].body as string)).toEqual({ name: "Test", address: "public-address" });
    expect(request[1].headers).toMatchObject({ Authorization: "Bearer unit-access-token" });
  });
  it("renders structured XRP errors without stringifying them as an object", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ error: { code: "XRPL_DISABLED", message: "XRP is disabled." } }), { status: 503 })));
    await expect(xrplWalletApi.list()).rejects.toThrow("XRP is disabled.");
  });
  it("whitelists payment-intent fields and sends the caller's stable idempotency key", async () => {
    const fetchMock=vi.fn(async()=>new Response(JSON.stringify({id:"intent"}),{status:200}));vi.stubGlobal("fetch",fetchMock);
    const value={schemaVersion:1,walletId:"1",chain:"xrpl",network:"testnet",destination:"public-address",destinationTag:0,amountDrops:"1",maxFeeDrops:"100",reference:"opaque-reference",seed:"never-send",approved:true};
    await xrplPaymentApi.create(value as PaymentInput,"same-key");
    const options=fetchMock.mock.calls[0][1] as RequestInit;const body=JSON.parse(options.body as string);
    expect(body).not.toHaveProperty("seed");expect(body).not.toHaveProperty("approved");expect(body.destinationTag).toBe(0);
    expect(options.headers).toMatchObject({"Idempotency-Key":"same-key"});
  });
  it("submits only the preparation ID and signed blob",async()=>{
    const fetchMock=vi.fn(async()=>new Response(JSON.stringify({id:"intent"}),{status:202}));vi.stubGlobal("fetch",fetchMock);
    await xrplPaymentApi.submit("intent","preparation","ABCD");
    const options=fetchMock.mock.calls[0][1] as RequestInit;
    expect(JSON.parse(options.body as string)).toEqual({preparationId:"preparation",blob:"ABCD"});
  });
});
