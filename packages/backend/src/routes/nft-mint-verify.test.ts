/**
 * POST /api/v1/nfts/mint (any signed-in user) may only index a SEP-50 token that exists on chain with that owner.
 * Review finding: a non-existent token id (e.g. 2147483647) used to be indexed, which showed a fake NFT and could
 * stall owner discovery.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const svc = vi.hoisted(() => ({ getCollection: vi.fn(), querySep50OwnerOf: vi.fn(), indexToken: vi.fn() }));
vi.mock("../modules/nft/nft.service", () => ({ nftService: svc }));
vi.mock("../lib/audit", () => ({ auditLog: vi.fn() }));
vi.mock("../db", () => ({ db: {}, schema: {} }));
vi.mock("../middleware/auth", () => ({ authMiddleware: async (request: any) => { request.user = { userId: 54, type: "user" }; } }));
vi.mock("../middleware/admin-auth", () => ({ verifyInternalAdmin: async () => {} }));

import Fastify from "fastify";
import { nftRoutes } from "./nft";

const OWNER = "GBCXALJNT67JWF2LOWDXJRIHEO7UWNLT6AO3YXBKJMPBFZTEEPBALACA";
const post = async (tokenId: number) => {
  const app = Fastify(); await app.register(nftRoutes); await app.ready();
  const r = await app.inject({ method: "POST", url: "/api/v1/nfts/mint", payload: { collectionId: 5, tokenId, owner: OWNER } });
  await app.close(); return r;
};

describe("POST /api/v1/nfts/mint checks the token on chain", () => {
  beforeEach(() => {
    Object.values(svc).forEach((f) => f.mockReset());
    svc.getCollection.mockResolvedValue({ id: 5, contractId: "CDPKSOOE4UZFM4TS52H7LMP2TYNLJBFAMT6M4E2H67KZEAH6UF54H524", network: "public" });
    svc.indexToken.mockResolvedValue({ id: 99 });
  });

  it("refuses a token that does not exist on chain and indexes nothing", async () => {
    svc.querySep50OwnerOf.mockResolvedValue(null);
    const r = await post(2147483647);
    expect(r.statusCode).toBe(400);
    expect(svc.indexToken).not.toHaveBeenCalled();
  });

  it("refuses a token owned by someone else", async () => {
    svc.querySep50OwnerOf.mockResolvedValue("GOTHER");
    expect((await post(9)).statusCode).toBe(400);
    expect(svc.indexToken).not.toHaveBeenCalled();
  });

  it("refuses when the chain cannot be checked", async () => {
    svc.querySep50OwnerOf.mockRejectedValue(new Error("rpc down"));
    expect((await post(9)).statusCode).toBe(503);
    expect(svc.indexToken).not.toHaveBeenCalled();
  });

  it("indexes a real token with the right owner, read on the collection's own network", async () => {
    svc.querySep50OwnerOf.mockResolvedValue(OWNER);
    expect((await post(9)).statusCode).toBe(200);
    expect(svc.querySep50OwnerOf).toHaveBeenCalledWith(expect.any(String), 9, "public");
    expect(svc.indexToken).toHaveBeenCalledTimes(1);
  });
});
