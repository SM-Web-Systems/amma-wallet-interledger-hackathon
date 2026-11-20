/**
 * The business's own activation controls (BUSINESS_CONTROLS=on, testnet only; stage 5).
 *
 *   GET  /api/v1/tenant/business/controls            pause state, daily cap, balance floor, latest alerts
 *   POST /api/v1/tenant/business/controls/pause      stop new activations (in-flight ones finish; learners keep wallets)
 *   POST /api/v1/tenant/business/controls/resume
 *   PUT  /api/v1/tenant/business/controls/daily-cap  { "dailyCap": 0..1000 }
 *
 * Authenticated with the business's own tenant API key and the activation:control scope; the business is always the key's,
 * never one from the request. Pause and resume email the business and the owner. The route does not exist unless the switch is on.
 */
import type { FastifyInstance } from "fastify";
import { db as realDb } from "../db";
import { requireScope, requireTenantApiKey } from "../middleware/tenant-api-key";
import type { ActivationDb } from "../modules/activation/errors";
import { controlsPresent, controlsView, DAILY_CAP_MAX, pauseActivations, resumeActivations, setDailyCap } from "../services/business-controls";
import type { Mailer } from "../services/business-deposits";

export interface BusinessControlRouteOptions { enabled: boolean; ownerEmail: string; mail: Mailer; db?: ActivationDb; now?: () => Date }

export async function businessControlRoutes(app: FastifyInstance, opts: BusinessControlRouteOptions) {
  if (!opts.enabled) return;
  const db = opts.db ?? (realDb as unknown as ActivationDb);
  const now = opts.now ?? (() => new Date());
  const guard = { preHandler: [requireTenantApiKey, requireScope("activation:control")], config: { rateLimit: { max: 30, timeWindow: "1 minute" } } };
  const tenantOf = (request: any): number | null => request.tenantApiKeyContext?.source === "db" ? request.tenantApiKeyContext.tenantId ?? null : null;
  const who = (request: any) => `api-key:${request.tenantApiKeyContext?.keyId ?? "?"}`;

  app.get("/api/v1/tenant/business/controls", guard, async (request, reply) => {
    const tenantId = tenantOf(request);
    if (!tenantId) return reply.status(403).send({ error: "This needs a business API key." });
    reply.header("cache-control", "no-store");
    return controlsView(db, tenantId);
  });

  for (const action of ["pause", "resume"] as const) {
    app.post(`/api/v1/tenant/business/controls/${action}`, guard, async (request, reply) => {
      const tenantId = tenantOf(request);
      if (!tenantId) return reply.status(403).send({ error: "This needs a business API key." });
      if (!(await controlsPresent(db))) return reply.status(503).send({ error: "Controls aren't set up on this server yet." });
      const deps = { mail: opts.mail, ownerEmail: opts.ownerEmail, now: now() };
      const r = action === "pause" ? await pauseActivations(db, deps, { tenantId, by: who(request) }) : await resumeActivations(db, deps, { tenantId, by: who(request) });
      return reply.send({ paused: action === "pause", changed: r.changed });
    });
  }

  app.put("/api/v1/tenant/business/controls/daily-cap", guard, async (request, reply) => {
    const tenantId = tenantOf(request);
    if (!tenantId) return reply.status(403).send({ error: "This needs a business API key." });
    const body = request.body as { dailyCap?: unknown } | undefined;
    const keys = body && typeof body === "object" ? Object.keys(body) : [];
    const cap = body?.dailyCap;
    if (keys.length !== 1 || typeof cap !== "number" || !Number.isInteger(cap) || cap < 0 || cap > DAILY_CAP_MAX) {
      return reply.status(400).send({ error: `Send { "dailyCap": n } with a whole number from 0 to ${DAILY_CAP_MAX}.` });
    }
    if (!(await controlsPresent(db))) return reply.status(503).send({ error: "Controls aren't set up on this server yet." });
    try { return reply.send(await setDailyCap(db, { now: now() }, { tenantId, dailyCap: cap, by: who(request) })); }
    catch (e) { if (e instanceof RangeError) return reply.status(409).send({ error: e.message }); throw e; }
  });
}
