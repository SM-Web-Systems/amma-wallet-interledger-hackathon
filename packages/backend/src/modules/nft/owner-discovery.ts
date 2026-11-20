/**
 * Finds SEP-50 (Soroban) NFTs that were minted on-chain without anyone telling AmmaWallet.
 *
 * Why: the owner lookup (GET /api/v1/nfts/owner/:publicKey) only reads the nft_tokens index. The LMS mints certificates
 * straight to the Soroban contract and never calls POST /api/v1/nfts/mint, and nothing ran the collection sync, so the
 * index never had the learner's certificate and the wallet showed "No NFTs found".
 *
 * What: for every registered SEP-50 collection, read total_supply and index the token ids above the highest one already
 * indexed yet (owner_of plus token_uri, and the metadata JSON). Only ids missing from the index are read, at most once a
 * minute per collection, so the cost is a few RPC simulations per new certificate, not per page view.
 */

export interface Sep50Collection {
  id: number;
  contractId: string;
  network: string;
}

/** What a token read returns: the value, or "missing" when the contract says the token does not exist. */
export type Read<T> = { found: true; value: T } | { found: false };

export interface DiscoveryDeps {
  listSep50Collections(): Promise<Sep50Collection[]>;
  /** Token ids already in the index for this collection. */
  indexedTokenIds(collectionId: number): Promise<Set<number>>;
  /** Indexed tokens whose metadata never arrived (e.g. a slow IPFS gateway), to retry a few per scan. */
  tokensWithoutMetadata(collectionId: number, limit: number): Promise<{ tokenId: number; owner: string; metadataUri: string }[]>;
  /** Throws when the RPC can't be reached, so a network fault is never read as "no tokens". */
  totalSupply(c: Sep50Collection): Promise<number>;
  /** Throws on RPC faults; { found: false } when the token does not exist (burned, or ids start at 1). */
  ownerOf(c: Sep50Collection, tokenId: number): Promise<Read<string>>;
  tokenUri(c: Sep50Collection, tokenId: number): Promise<string | null>;
  fetchMetadata(uri: string): Promise<{ name?: string; description?: string; image?: string; attributes?: unknown } | null>;
  index(token: {
    collectionId: number; tokenId: number; owner: string; metadataUri?: string;
    name?: string; description?: string; image?: string; attributes?: unknown;
  }): Promise<void>;
  now(): number;
  warn(msg: string, detail?: Record<string, unknown>): void;
}

export interface DiscoveryOptions {
  /** A collection is scanned at most once in this window. */
  minIntervalMs: number;
  /** New ids read per scan, so one call never runs long; the rest wait for the next scan. */
  maxPerScan: number;
  concurrency: number;
  /** Tokens per scan whose missing metadata is fetched again. */
  metadataRetryPerScan?: number;
}

export const DEFAULT_DISCOVERY_OPTIONS: DiscoveryOptions = { minIntervalMs: 60_000, maxPerScan: 200, concurrency: 4 };

export function createOwnerDiscovery(deps: DiscoveryDeps, opts: DiscoveryOptions = DEFAULT_DISCOVERY_OPTIONS) {
  const lastScan = new Map<number, number>();
  const inFlight = new Map<number, Promise<number>>();

  /** Metadata that failed earlier (slow gateway, timeout) is fetched again, a few tokens per scan. */
  async function retryMetadata(c: Sep50Collection): Promise<void> {
    const limit = opts.metadataRetryPerScan ?? 10;
    if (limit <= 0) return;
    const missing = await deps.tokensWithoutMetadata(c.id, limit).catch(() => []);
    for (const t of missing) {
      const meta = await deps.fetchMetadata(t.metadataUri).catch(() => null);
      if (!meta) continue;
      await deps.index({ collectionId: c.id, tokenId: t.tokenId, owner: t.owner, metadataUri: t.metadataUri,
        name: meta.name, description: meta.description, image: meta.image, attributes: meta.attributes });
    }
  }

  async function scanCollection(c: Sep50Collection, owner?: string): Promise<number> {
    const supply = await deps.totalSupply(c);
    // Read the ids in 0..total_supply (ids may start at 0 or 1) that are not indexed yet. Not "above the highest indexed
    // id": a bogus high id in the index (e.g. from /nfts/mint) would otherwise stop discovery for good.
    const have = await deps.indexedTokenIds(c.id);
    const ids: number[] = [];
    for (let id = 0; id <= supply && ids.length < opts.maxPerScan; id++) if (!have.has(id)) ids.push(id);
    if (ids.length === 0) { await retryMetadata(c); return 0; }

    // Read owners in order with a small worker pool. An RPC fault stops the scan before anything above it is indexed,
    // so the cursor (highest indexed id) never jumps over a token we failed to read.
    const owners: Array<Read<string> | undefined> = new Array(ids.length);
    let next = 0;
    let fault: unknown = null;
    const worker = async () => {
      while (fault === null && next < ids.length) {
        const i = next++;
        try {
          owners[i] = await deps.ownerOf(c, ids[i]);
        } catch (err) {
          fault = err;
        }
      }
    };
    await Promise.all(Array.from({ length: Math.max(1, opts.concurrency) }, worker));

    let indexed = 0;
    for (let i = 0; i < ids.length; i++) {
      const read = owners[i];
      if (read === undefined) break; // not read because of a fault: stop here, retry next scan
      if (!read.found) continue;
      const tokenId = ids[i];
      const metadataUri = (await deps.tokenUri(c, tokenId).catch(() => null)) ?? undefined;
      let meta: Awaited<ReturnType<DiscoveryDeps["fetchMetadata"]>> = null;
      // Every new token gets its metadata (at most maxPerScan per scan; URIs come from a registered contract),
      // so a certificate first found during someone else's lookup is not stored without its name and image.
      if (metadataUri) meta = await deps.fetchMetadata(metadataUri).catch(() => null);
      await deps.index({
        collectionId: c.id, tokenId, owner: read.value, metadataUri,
        name: meta?.name, description: meta?.description, image: meta?.image, attributes: meta?.attributes,
      });
      indexed++;
    }
    await retryMetadata(c);
    if (fault !== null) {
      deps.warn("[nft] owner discovery stopped on an RPC fault; it resumes on the next scan", {
        collectionId: c.id, error: fault instanceof Error ? fault.message : String(fault),
      });
    }
    return indexed;
  }

  /** Scans each collection that is due; returns how many tokens were newly indexed. Never throws. */
  async function refresh(owner?: string): Promise<number> {
    let collections: Sep50Collection[];
    try {
      collections = await deps.listSep50Collections();
    } catch (err) {
      deps.warn("[nft] owner discovery could not list collections", { error: err instanceof Error ? err.message : String(err) });
      return 0;
    }
    const results = await Promise.all(collections.map(async (c) => {
      const running = inFlight.get(c.id);
      if (running) return running.catch(() => 0);
      const last = lastScan.get(c.id);
      if (last !== undefined && deps.now() - last < opts.minIntervalMs) return 0;
      lastScan.set(c.id, deps.now());
      const p = scanCollection(c, owner).catch((err) => {
        deps.warn("[nft] owner discovery failed for a collection", { collectionId: c.id, error: err instanceof Error ? err.message : String(err) });
        return 0;
      }).finally(() => inFlight.delete(c.id));
      inFlight.set(c.id, p);
      return p;
    }));
    return results.reduce((a, b) => a + b, 0);
  }

  /**
   * Waits for refresh at most budgetMs; a slower scan keeps running and its tokens appear on the next lookup.
   * The LMS proxy gives the whole lookup 5 s, so the route uses a shorter budget.
   */
  async function refreshWithin(budgetMs: number, owner?: string): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      refresh(owner),
      new Promise<void>((resolve) => { timer = setTimeout(resolve, budgetMs); }),
    ]);
    if (timer) clearTimeout(timer);
  }

  return { refresh, refreshWithin };
}
