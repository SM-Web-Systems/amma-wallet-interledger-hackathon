import { describe, it, expect, vi, beforeEach, afterAll } from "vitest";
import Fastify from "fastify";

// The self-serve business page API: off unless BUSINESS_PAGE=on, refused on mainnet, and only ever a business's own data
// through its own API key (funding:read).
const overview = vi.hoisted(() => vi.fn());
vi.mock("../services/business-overview", () => ({ getBusinessOverview: overview }));
vi.mock("../db", () => ({ db: { execute: vi.fn() }, schema: {} }));
const keyCtx = vi.hoisted(() => ({ value: null as null | { tenantId: number | null; scopes: string[] } }));
vi.mock("../middleware/tenant-api-key", () => ({
  requireTenantApiKey: async (req: any, reply: any) => {
    if (!keyCtx.value) return reply.status(401).send({ error: "API key required" });
    req.tenantApiKeyContext = keyCtx.value;
  },
  requireScope: (scope: string) => async (req: any, reply: any) => {
    if (!req.tenantApiKeyContext?.scopes?.includes(scope)) return reply.status(403).send({ error: `Scope ${scope} required` });
  },
}));

import { businessPageOn, businessPageRoutes } from "./business-page";
import { requiredMarkers } from "../db/schema-gate";

describe("BUSINESS_PAGE switch", () => {
  it("is off by default and for anything but on", () => {
    expect(businessPageOn({})).toBe(false);
    for (const v of ["", "off", "true", "ON "]) expect(businessPageOn({ BUSINESS_PAGE: v, STELLAR_NETWORK: "testnet" })).toBe(false);
  });
  it("is on for on on testnet", () => {
    expect(businessPageOn({ BUSINESS_PAGE: "on", STELLAR_NETWORK: "testnet" })).toBe(true);
  });
  it("is refused on mainnet (start-up error), by network or by mainnet custody", () => {
    expect(() => businessPageOn({ BUSINESS_PAGE: "on", STELLAR_NETWORK: "public" })).toThrow(/testnet only/);
    expect(() => businessPageOn({ BUSINESS_PAGE: "on", STELLAR_NETWORK: "testnet", MAINNET_CUSTODY: "on" })).toThrow(/testnet only/);
    expect(businessPageOn({ BUSINESS_PAGE: "off", STELLAR_NETWORK: "public" })).toBe(false); // off is always fine
  });
  it("needs the business tables when on", () => {
    const off = requiredMarkers({});
    const on = requiredMarkers({ BUSINESS_PAGE: "on" } as NodeJS.ProcessEnv);
    expect(on.length).toBeGreaterThan(off.length);
    expect(on.filter((m) => !off.includes(m)).join(" ")).toMatch(/fee-sweeps-v1/);
    expect(on.filter((m) => !off.includes(m)).join(" ")).toMatch(/business-deposits-v1/);
  });
});

describe("GET /api/v1/tenant/business/overview", () => {
  const build = async (enabled: boolean) => {
    const app = Fastify();
    await app.register(businessPageRoutes, { enabled, network: "testnet" });
    return app;
  };
  const apps: Awaited<ReturnType<typeof build>>[] = [];
  afterAll(async () => { for (const a of apps) await a.close(); });
  beforeEach(() => { overview.mockReset().mockResolvedValue({ network: "testnet", depositAddress: "GABC", memo: null }); keyCtx.value = null; });

  it("does not exist when the switch is off", async () => {
    const app = await build(false); apps.push(app);
    keyCtx.value = { tenantId: 1, scopes: ["funding:read"] };
    expect((await app.inject({ method: "GET", url: "/api/v1/tenant/business/overview" })).statusCode).toBe(404);
    expect(overview).not.toHaveBeenCalled();
  });

  it("needs an API key with funding:read", async () => {
    const app = await build(true); apps.push(app);
    expect((await app.inject({ method: "GET", url: "/api/v1/tenant/business/overview" })).statusCode).toBe(401);
    keyCtx.value = { tenantId: 1, scopes: ["activation:write"] };
    expect((await app.inject({ method: "GET", url: "/api/v1/tenant/business/overview" })).statusCode).toBe(403);
    expect(overview).not.toHaveBeenCalled();
  });

  it("refuses a legacy key with no business behind it", async () => {
    const app = await build(true); apps.push(app);
    keyCtx.value = { tenantId: null, scopes: ["funding:read"] };
    expect((await app.inject({ method: "GET", url: "/api/v1/tenant/business/overview" })).statusCode).toBe(403);
  });

  it("returns the overview of the key's own business on testnet, uncached", async () => {
    const app = await build(true); apps.push(app);
    keyCtx.value = { tenantId: 7, scopes: ["funding:read"] };
    const res = await app.inject({ method: "GET", url: "/api/v1/tenant/business/overview?tenantId=1" });
    expect(res.statusCode).toBe(200);
    expect(overview).toHaveBeenCalledWith(expect.anything(), 7, "testnet"); // never a tenant id from the request
    expect(res.json()).toMatchObject({ depositAddress: "GABC", memo: null });
    expect(res.headers["cache-control"]).toBe("no-store");
  });
});
