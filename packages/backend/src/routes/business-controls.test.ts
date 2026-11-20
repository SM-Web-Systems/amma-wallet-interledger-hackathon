import { describe, it, expect, vi, beforeEach } from "vitest";
import Fastify from "fastify";

// The business's own controls: only through its own DB API key with activation:control, off unless the switch is on.
const svc = vi.hoisted(() => ({
  controlsPresent: vi.fn(async () => true), controlsView: vi.fn(async (_db: unknown, tenantId: number) => ({ tenantId })),
  pauseActivations: vi.fn(async () => ({ changed: true })), resumeActivations: vi.fn(async () => ({ changed: false })),
  setDailyCap: vi.fn(async () => ({ before: 50, after: 10 })), DAILY_CAP_MAX: 1000,
}));
vi.mock("../services/business-controls", () => svc);
vi.mock("../db", () => ({ db: { execute: vi.fn() }, schema: {} }));
const keyCtx = vi.hoisted(() => ({ value: null as null | { source: string; tenantId: number | null; keyId: number | null; scopes: string[] } }));
vi.mock("../middleware/tenant-api-key", () => ({
  requireTenantApiKey: async (req: any, reply: any) => { if (!keyCtx.value) return reply.status(401).send({ error: "API key required" }); req.tenantApiKeyContext = keyCtx.value; },
  requireScope: (scope: string) => async (req: any, reply: any) => { if (!req.tenantApiKeyContext?.scopes?.includes(scope)) return reply.status(403).send({ error: `Scope ${scope} required` }); },
}));

import { businessControlRoutes } from "./business-controls";

const app = async (enabled = true) => {
  const a = Fastify();
  await a.register(businessControlRoutes, { enabled, ownerEmail: "owner@example.test", mail: async () => true, db: {} as any });
  return a;
};
beforeEach(() => { keyCtx.value = { source: "db", tenantId: 7, keyId: 3, scopes: ["activation:control"] }; vi.clearAllMocks(); });

describe("business controls API", () => {
  it("doesn't exist when the switch is off", async () => {
    expect((await (await app(false)).inject({ method: "GET", url: "/api/v1/tenant/business/controls" })).statusCode).toBe(404);
  });

  it("needs a key with activation:control, and a business key (not a legacy env key)", async () => {
    keyCtx.value = null;
    expect((await (await app()).inject({ method: "GET", url: "/api/v1/tenant/business/controls" })).statusCode).toBe(401);
    keyCtx.value = { source: "db", tenantId: 7, keyId: 3, scopes: ["funding:read"] };
    expect((await (await app()).inject({ method: "POST", url: "/api/v1/tenant/business/controls/pause" })).statusCode).toBe(403);
    keyCtx.value = { source: "env", tenantId: null, keyId: null, scopes: ["activation:control"] };
    expect((await (await app()).inject({ method: "POST", url: "/api/v1/tenant/business/controls/pause" })).statusCode).toBe(403);
    expect(svc.pauseActivations).not.toHaveBeenCalled();
  });

  it("acts on the key's own business only, and says who did it", async () => {
    const a = await app();
    expect((await a.inject({ method: "GET", url: "/api/v1/tenant/business/controls?tenantId=1" })).json()).toEqual({ tenantId: 7 });
    expect((await a.inject({ method: "POST", url: "/api/v1/tenant/business/controls/pause", payload: { tenantId: 1 } })).json()).toEqual({ paused: true, changed: true });
    expect(svc.pauseActivations).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ ownerEmail: "owner@example.test" }), { tenantId: 7, by: "api-key:3" });
    expect((await a.inject({ method: "POST", url: "/api/v1/tenant/business/controls/resume" })).json()).toEqual({ paused: false, changed: false });
  });

  it("takes exactly { dailyCap } as a whole number from 0 to 1000", async () => {
    const a = await app();
    for (const payload of [{}, { dailyCap: "10" }, { dailyCap: -1 }, { dailyCap: 1001 }, { dailyCap: 1.5 }, { dailyCap: 10, tenantId: 1 }]) {
      expect((await a.inject({ method: "PUT", url: "/api/v1/tenant/business/controls/daily-cap", payload })).statusCode).toBe(400);
    }
    const ok = await a.inject({ method: "PUT", url: "/api/v1/tenant/business/controls/daily-cap", payload: { dailyCap: 10 } });
    expect(ok.json()).toEqual({ before: 50, after: 10 });
    expect(svc.setDailyCap).toHaveBeenCalledWith(expect.anything(), expect.anything(), { tenantId: 7, dailyCap: 10, by: "api-key:3" });
  });

  it("says plainly when the server isn't set up yet", async () => {
    svc.controlsPresent.mockResolvedValueOnce(false);
    expect((await (await app()).inject({ method: "POST", url: "/api/v1/tenant/business/controls/pause" })).statusCode).toBe(503);
  });
});
