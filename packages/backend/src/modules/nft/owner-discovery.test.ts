import { describe, it, expect, vi } from "vitest";
import { createOwnerDiscovery, type DiscoveryDeps, type Sep50Collection } from "./owner-discovery";

const LMS: Sep50Collection = { id: 7, contractId: "CDPKSOOE4UZFM4TS52H7LMP2TYNLJBFAMT6M4E2H67KZEAH6UF54H524", network: "public" };
const LEARNER = "GLEARNER";
const OTHER = "GOTHER";

/** An in-memory contract and index, so the test shows the learner's certificate going from "on-chain only" to "listed". */
function fakeChain(owners: Record<number, string>, supply = Object.keys(owners).length) {
  const indexed = new Map<number, { owner: string; name?: string; metadataUri?: string }>();
  let clock = 0;
  const deps: DiscoveryDeps = {
    listSep50Collections: vi.fn(async () => [LMS]),
    indexedTokenIds: vi.fn(async () => new Set(indexed.keys())),
    tokensWithoutMetadata: vi.fn(async (_id: number, limit: number) => [...indexed.entries()]
      .filter(([, t]) => !t.name && t.metadataUri).slice(0, limit).map(([tokenId, t]) => ({ tokenId, owner: t.owner, metadataUri: t.metadataUri! }))),
    totalSupply: vi.fn(async () => supply),
    ownerOf: vi.fn(async (_c, id) => (owners[id] ? { found: true as const, value: owners[id] } : { found: false as const })),
    tokenUri: vi.fn(async (_c, id) => `https://lms.example/cert/${id}.json`),
    fetchMetadata: vi.fn(async (uri: string) => ({ name: `Certificate ${uri.split("/").pop()}` })),
    index: vi.fn(async (t) => { indexed.set(t.tokenId, { owner: t.owner, name: t.name, metadataUri: t.metadataUri }); }),
    now: () => clock,
    warn: vi.fn(),
  };
  return { deps, indexed, tick: (ms: number) => { clock += ms; }, setSupply: (n: number) => { supply = n; } };
}

const opts = { minIntervalMs: 60_000, maxPerScan: 200, concurrency: 3 };

describe("SEP-50 owner discovery: certificates minted on-chain show in the wallet", () => {
  it("indexes a learner's certificate that was minted without any /nfts/mint call (the bug)", async () => {
    // Contract ids start at 1 here, as many Soroban NFT contracts do; id 0 does not exist.
    const chain = fakeChain({ 1: OTHER, 2: LEARNER }, 2);
    const d = createOwnerDiscovery(chain.deps, opts);

    expect(await d.refresh(LEARNER)).toBe(2);

    expect(chain.indexed.get(2)).toMatchObject({ owner: LEARNER, name: "Certificate 2.json", metadataUri: "https://lms.example/cert/2.json" });
    expect(chain.indexed.get(1)?.owner).toBe(OTHER);
  });

  it("fetches metadata for every newly indexed token, so no certificate is stored without its name", async () => {
    // Review finding: with owner-only metadata, a certificate first indexed during someone else's lookup stayed nameless.
    const chain = fakeChain({ 0: OTHER, 1: LEARNER, 2: OTHER }, 2);
    await createOwnerDiscovery(chain.deps, opts).refresh(LEARNER);
    expect(chain.deps.fetchMetadata).toHaveBeenCalledTimes(3);
    expect(chain.indexed.get(0)?.name).toBe("Certificate 0.json");
  });

  it("a bogus high token id in the index (e.g. from /nfts/mint) does not stop discovery of real tokens", async () => {
    const chain = fakeChain({ 0: OTHER, 1: LEARNER }, 1);
    chain.indexed.set(2147483647, { owner: "GBOGUS" });
    await createOwnerDiscovery(chain.deps, opts).refresh(LEARNER);
    expect(chain.indexed.get(1)?.owner).toBe(LEARNER);
    expect(chain.indexed.get(0)?.owner).toBe(OTHER);
  });

  it("fills a gap below already indexed ids instead of trusting the highest one", async () => {
    const chain = fakeChain({ 0: OTHER, 1: LEARNER, 2: OTHER }, 2);
    chain.indexed.set(2, { owner: OTHER });
    await createOwnerDiscovery(chain.deps, opts).refresh(LEARNER);
    expect(chain.indexed.get(1)?.owner).toBe(LEARNER);
  });

  it("reads only new token ids on later scans, and at most once a minute per collection", async () => {
    const chain = fakeChain({ 0: OTHER, 1: LEARNER, 2: OTHER, 3: LEARNER }, 1);
    const d = createOwnerDiscovery(chain.deps, opts);
    await d.refresh(LEARNER);
    expect([...chain.indexed.keys()]).toEqual([0, 1]);

    chain.setSupply(3);
    await d.refresh(LEARNER); // inside the minute: no RPC at all
    expect(chain.deps.totalSupply).toHaveBeenCalledTimes(1);

    chain.tick(60_000);
    (chain.deps.ownerOf as any).mockClear();
    await d.refresh(LEARNER);
    const readIds = (chain.deps.ownerOf as any).mock.calls.map((c: any[]) => c[1]).sort();
    expect(readIds).toEqual([2, 3]);
    expect(chain.indexed.get(3)?.owner).toBe(LEARNER);
  });

  it("an RPC fault never skips a token: nothing above the fault is indexed, and the next scan retries it", async () => {
    const chain = fakeChain({ 0: OTHER, 1: LEARNER, 2: OTHER }, 2);
    let fail = true;
    const realOwnerOf = chain.deps.ownerOf;
    chain.deps.ownerOf = vi.fn(async (c, id) => {
      if (id === 1 && fail) throw new Error("rpc timeout");
      return realOwnerOf(c, id);
    });
    const d = createOwnerDiscovery(chain.deps, { ...opts, concurrency: 1 });

    await d.refresh(LEARNER);
    expect([...chain.indexed.keys()]).toEqual([0]);
    expect(chain.deps.warn).toHaveBeenCalled();

    fail = false;
    chain.tick(60_000);
    await d.refresh(LEARNER);
    expect(chain.indexed.get(1)?.owner).toBe(LEARNER);
    expect(chain.indexed.get(2)?.owner).toBe(OTHER);
  });

  it("retries metadata later for tokens indexed without it (slow IPFS gateway)", async () => {
    const chain = fakeChain({ 0: OTHER, 1: LEARNER }, 1);
    let gatewayUp = false;
    const realFetch = chain.deps.fetchMetadata;
    chain.deps.fetchMetadata = vi.fn(async (uri: string) => (gatewayUp ? realFetch(uri) : Promise.reject(new Error("timeout"))));
    const d = createOwnerDiscovery(chain.deps, opts);
    await d.refresh(LEARNER);
    expect(chain.indexed.get(1)?.owner).toBe(LEARNER);
    expect(chain.indexed.get(1)?.name).toBeUndefined();
    gatewayUp = true;
    chain.tick(60_000);
    await d.refresh(LEARNER);
    expect(chain.indexed.get(1)?.name).toBe("Certificate 1.json");
    expect(chain.indexed.get(0)?.name).toBe("Certificate 0.json");
  });

  it("caps each scan so one lookup never reads thousands of tokens", async () => {
    const owners: Record<number, string> = {};
    for (let i = 0; i < 50; i++) owners[i] = OTHER;
    const chain = fakeChain(owners, 49);
    await createOwnerDiscovery(chain.deps, { ...opts, maxPerScan: 10 }).refresh();
    expect(chain.indexed.size).toBe(10);
  });

  it("never throws: an unreachable RPC leaves the index as it was", async () => {
    const chain = fakeChain({ 0: LEARNER });
    chain.deps.totalSupply = vi.fn(async () => { throw new Error("ECONNREFUSED"); });
    await expect(createOwnerDiscovery(chain.deps, opts).refresh(LEARNER)).resolves.toBe(0);
    expect(chain.indexed.size).toBe(0);
  });

  it("refreshWithin answers on time even when the RPC is slow", async () => {
    const chain = fakeChain({ 0: LEARNER });
    chain.deps.totalSupply = vi.fn(() => new Promise<number>(() => {})); // never answers
    const started = Date.now();
    await createOwnerDiscovery(chain.deps, opts).refreshWithin(50, LEARNER);
    expect(Date.now() - started).toBeLessThan(1000);
  });
});
