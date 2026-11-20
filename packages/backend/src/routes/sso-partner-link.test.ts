import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import jwt from "jsonwebtoken";
import Fastify from "fastify";

const state = vi.hoisted(() => ({
  config: { SSO_SECRET: "test-sso-secret-at-least-32-chars-long!!", SSO_CALLBACK_WHITELIST: [] as string[], JWT_SECRET: "x" },
  key: undefined as undefined | { source: "db" | "env"; tenantId: number | null },
  links: [] as Record<string, unknown>[],
  linkFails: false,
  jtis: new Set<string>(),
}));

vi.mock("../db", () => ({
  db: {
    insert: () => ({
      values: (val: Record<string, any>) => ({
        onConflictDoNothing: () => {
          if ("jti" in val) {
            const fresh = !state.jtis.has(val.jti);
            state.jtis.add(val.jti);
            return { returning: async () => (fresh ? [{ jti: val.jti }] : []) };
          }
          if (state.linkFails) return Promise.reject(new Error("db down"));
          state.links.push(val);
          return Promise.resolve();
        },
      }),
    }),
    delete: () => ({ where: async () => undefined }),
  },
  schema: { ssoUsedJtis: { jti: "jti", expiresAt: "expires_at" }, tenantUsers: { tenantId: "tenantId" }, users: {}, userWallets: {} },
}));
vi.mock("../middleware/auth", () => ({ authMiddleware: async () => {} }));
vi.mock("../middleware/tenant-api-key", () => ({
  requireTenantApiKey: async (request: any) => { if (state.key) request.tenantApiKeyContext = state.key; },
  requireScope: () => async () => {},
}));
vi.mock("../config", () => ({ config: state.config }));

import { ssoRoutes } from "./sso";

const assertion = (sub = "7") => jwt.sign({ sub, email: "a@example.invalid", firstName: "A", lastName: "B", isEmailVerified: true, iss: "ammawallet", aud: "lms-amma-sso", jti: `jti-${Math.random()}` }, state.config.SSO_SECRET, { expiresIn: 60 });
const verify = async (sub?: string) => {
  const app = Fastify(); await app.register(ssoRoutes);
  try { return await app.inject({ method: "POST", url: "/api/v1/sso/verify", payload: { assertion: assertion(sub) } }); } finally { await app.close(); }
};

afterAll(() => { delete process.env.TASK_ACTIVATION; });

describe("sso/verify links the user to the partner", () => {
  beforeEach(() => { process.env.TASK_ACTIVATION = "on"; state.key = undefined; state.links.length = 0; state.linkFails = false; state.jtis.clear(); });

  it("records tenant_users(tenant, user, 'sso') for a DB tenant key", async () => {
    state.key = { source: "db", tenantId: 4 };
    const res = await verify("7");
    expect(res.statusCode).toBe(200);
    expect(res.json().userId).toBe("7");
    expect(state.links).toEqual([{ tenantId: 4, userId: 7, registeredVia: "sso" }]);
  });

  it("writes no link at all while task activation is off, so other tenant-user behaviour is unchanged", async () => {
    state.key = { source: "db", tenantId: 4 };
    for (const off of [undefined, "off", "false"]) {
      if (off === undefined) delete process.env.TASK_ACTIVATION; else process.env.TASK_ACTIVATION = off;
      expect((await verify()).statusCode).toBe(200);
    }
    expect(state.links).toEqual([]);
  });

  it("never links for the legacy env key, which has no tenant", async () => {
    state.key = { source: "env", tenantId: null };
    expect((await verify()).statusCode).toBe(200);
    expect(state.links).toEqual([]);
  });

  it("does not link for an assertion that is rejected", async () => {
    state.key = { source: "db", tenantId: 4 };
    const app = Fastify(); await app.register(ssoRoutes);
    const bad = await app.inject({ method: "POST", url: "/api/v1/sso/verify", payload: { assertion: "not-a-jwt" } });
    await app.close();
    expect(bad.statusCode).toBe(401);
    expect(state.links).toEqual([]);
  });

  it("does not link a replayed assertion a second time", async () => {
    state.key = { source: "db", tenantId: 4 };
    const app = Fastify(); await app.register(ssoRoutes);
    const token = assertion("7");
    const first = await app.inject({ method: "POST", url: "/api/v1/sso/verify", payload: { assertion: token } });
    const replay = await app.inject({ method: "POST", url: "/api/v1/sso/verify", payload: { assertion: token } });
    await app.close();
    expect([first.statusCode, replay.statusCode]).toEqual([200, 409]);
    expect(state.links).toHaveLength(1);
  });

  it("still signs the user in when the link cannot be recorded", async () => {
    state.key = { source: "db", tenantId: 4 };
    state.linkFails = true;
    expect((await verify()).statusCode).toBe(200);
  });
});
