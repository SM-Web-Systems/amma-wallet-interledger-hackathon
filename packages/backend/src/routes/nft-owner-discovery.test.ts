/**
 * Regression test for "certificate NFTs don't appear in the wallet": the owner lookup must look on-chain for new
 * SEP-50 tokens before reading the index, and must still answer from the index when that look-up fails.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const svc = vi.hoisted(() => ({
  discoverForOwner: vi.fn(),
  getTokensByOwner: vi.fn(),
  scanClassicNfts: vi.fn(),
}));
vi.mock("../modules/nft/nft.service", () => ({ nftService: svc }));
vi.mock("../lib/audit", () => ({ auditLog: vi.fn() }));
vi.mock("../db", () => ({ db: {}, schema: {} }));
vi.mock("../middleware/auth", () => ({ authMiddleware: async () => {} }));
vi.mock("../middleware/admin-auth", () => ({ verifyInternalAdmin: async () => {} }));

import Fastify from "fastify";
import * as StellarSdk from "@stellar/stellar-sdk";
import { nftRoutes } from "./nft";

const LEARNER = StellarSdk.Keypair.random().publicKey();
const CERT = { token: { id: 1, tokenId: 4, owner: LEARNER }, collection: { contractId: "C...", name: "Certificates" } };

describe("GET /api/v1/nfts/owner/:publicKey finds certificates minted on-chain", () => {
  let app: any;
  beforeEach(async () => {
    Object.values(svc).forEach((f) => f.mockReset());
    svc.getTokensByOwner.mockResolvedValue({ tokens: [CERT], total: 1 });
    svc.scanClassicNfts.mockResolvedValue([]);
    app = Fastify();
    await app.register(nftRoutes);
    await app.ready();
  });

  it("runs owner discovery before reading the index, so a fresh certificate is listed", async () => {
    const order: string[] = [];
    svc.discoverForOwner.mockImplementation(async () => { order.push("discover"); });
    svc.getTokensByOwner.mockImplementation(async () => { order.push("index"); return { tokens: [CERT], total: 1 }; });

    const res = await app.inject({ method: "GET", url: `/api/v1/nfts/owner/${LEARNER}` });

    expect(res.statusCode).toBe(200);
    expect(order).toEqual(["discover", "index"]);
    expect(svc.discoverForOwner).toHaveBeenCalledWith(LEARNER, expect.any(Number));
    expect(res.json().indexed.tokens[0].token.tokenId).toBe(4);
  });

  it("skips discovery for an address that isn't a Stellar account (no RPC spend on junk input)", async () => {
    await app.inject({ method: "GET", url: "/api/v1/nfts/owner/not-an-address" });
    expect(svc.discoverForOwner).not.toHaveBeenCalled();
    expect(svc.getTokensByOwner).toHaveBeenCalled();
  });
});
