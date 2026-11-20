/**
 * Self-serve business page API (BUSINESS_PAGE=on, testnet only).
 *
 * GET /api/v1/tenant/business/overview: the calling business's credits, deposits (credited or held), fees and bundle
 * purchases, plus deposit instructions. Authenticated with the business's own tenant API key (funding:read); the tenant is
 * always the key's, never one from the request. Off by default: the route does not exist unless the switch is on, and the
 * switch is refused on mainnet at start-up.
 */
import { FastifyInstance } from "fastify";
import { db } from "../db";
import { requireTenantApiKey, requireScope } from "../middleware/tenant-api-key";
import { getBusinessOverview } from "../services/business-overview";
import type { StellarNetwork } from "../services/business-wallets";

type Env = Record<string, string | undefined>;

/** BUSINESS_PAGE=on turns the page on. Throws on mainnet: it is testnet only until the owner releases it there. */
export function businessPageOn(env: Env = process.env): boolean {
  if (env.BUSINESS_PAGE !== "on") return false;
  if (env.STELLAR_NETWORK === "public" || env.MAINNET_CUSTODY === "on") {
    throw new Error("BUSINESS_PAGE is testnet only in this release; mainnet needs the owner's go and its own release.");
  }
  return true;
}

export async function businessPageRoutes(app: FastifyInstance, opts: { enabled: boolean; network: StellarNetwork }) {
  if (!opts.enabled) return;
  app.get(
    "/api/v1/tenant/business/overview",
    {
      preHandler: [requireTenantApiKey, requireScope("funding:read")],
      config: { rateLimit: { max: 30, timeWindow: "1 minute" } },
      schema: {
        tags: ["Tenant"],
        description: "The calling business's credits, deposits, fees, bundle purchases and deposit instructions (testnet only, BUSINESS_PAGE=on).",
        security: [{ apiKey: [] }],
      },
    },
    async (request, reply) => {
      const tenantId = request.tenantApiKeyContext?.tenantId;
      if (!tenantId) return reply.status(403).send({ error: "This page needs a business API key." });
      reply.header("cache-control", "no-store");
      return getBusinessOverview(db as never, tenantId, opts.network);
    },
  );
}
