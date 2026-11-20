import { config } from "../../config";
import { db } from "../../db";
import * as schema from "../../db/schema";
import { eq, and, desc, sql, isNotNull, isNull } from "drizzle-orm";
import * as StellarSdk from "@stellar/stellar-sdk";
import { validateExternalUrl } from "../../lib/url-validator";
import { knownSep50Contracts, normalizeNetwork, sorobanTargetFor } from "./sep50-network";
import { createOwnerDiscovery, type Read } from "./owner-discovery";

const horizon = new StellarSdk.Horizon.Server(config.HORIZON_URL);

const SIMULATION_SOURCE = "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF";

/** One RPC client per URL: collections on mainnet and testnet can live side by side. */
const rpcClients = new Map<string, StellarSdk.rpc.Server>();
function rpcFor(url: string): StellarSdk.rpc.Server {
  let client = rpcClients.get(url);
  if (!client) {
    client = new StellarSdk.rpc.Server(url);
    rpcClients.set(url, client);
  }
  return client;
}

let knownCollectionsReady: Promise<void> | null = null;

export class NftService {

  // ── Collections ────────────────────────────────────────────

  /**
   * Register a new NFT collection (SEP-50 Soroban or SEP-39 Classic)
   */
  async registerCollection(data: {
    contractId?: string;
    issuerAddress?: string;
    name: string;
    symbol?: string;
    standard: "sep50" | "sep39";
    baseUri?: string;
    description?: string;
    imageUrl?: string;
    creatorAddress?: string;
    network?: string;
  }) {
    // The table columns are type, asset_issuer, image and creator. The old code passed standard, issuerAddress,
    // imageUrl and creatorAddress, which Drizzle dropped, so SEP-39 issuers and images were never saved.
    const [collection] = await db.insert(schema.nftCollections).values({
      type: data.standard,
      contractId: data.contractId || null,
      assetIssuer: data.issuerAddress || null,
      name: data.name,
      symbol: data.symbol || null,
      baseUri: data.baseUri || null,
      description: data.description || null,
      image: data.imageUrl || null,
      creator: data.creatorAddress || null,
      network: normalizeNetwork(data.network || config.STELLAR_NETWORK),
      totalSupply: 0,
      isVerified: false,
    }).returning();
    return collection;
  }

  /**
   * List collections with pagination
   */
  async listCollections(limit = 50, offset = 0, network?: string) {
    // The API takes "mainnet"; the table stores "public".
    const where = network ? eq(schema.nftCollections.network, normalizeNetwork(network)) : undefined;
    const collections = await db.select()
      .from(schema.nftCollections)
      .where(where)
      .orderBy(desc(schema.nftCollections.createdAt))
      .limit(Math.min(limit, 100))
      .offset(offset);

    const [{ count }] = await db.select({ count: sql<number>`count(*)::int` })
      .from(schema.nftCollections)
      .where(where);

    return { collections, total: count };
  }

  /**
   * Get single collection by ID
   */
  async getCollection(id: number) {
    const [collection] = await db.select()
      .from(schema.nftCollections)
      .where(eq(schema.nftCollections.id, id))
      .limit(1);
    return collection || null;
  }

  /**
   * Get collection by contract ID (Soroban)
   */
  async getCollectionByContract(contractId: string) {
    const [collection] = await db.select()
      .from(schema.nftCollections)
      .where(eq(schema.nftCollections.contractId, contractId))
      .limit(1);
    return collection || null;
  }

  // ── Tokens ─────────────────────────────────────────────────

  /**
   * Index / register an individual NFT token
   */
  async indexToken(data: {
    collectionId: number;
    tokenId: number;
    owner: string;
    name?: string;
    description?: string;
    image?: string;
    metadataUri?: string;
    attributes?: any;
  }) {
    // Upsert: if token already indexed, update owner + metadata
    const [token] = await db.insert(schema.nftTokens).values({
      collectionId: data.collectionId,
      tokenId: data.tokenId,
      owner: data.owner,
      name: data.name || null,
      description: data.description || null,
      image: data.image || null,
      metadataUri: data.metadataUri || null,
      attributes: data.attributes || [],
    }).onConflictDoUpdate({
      target: [schema.nftTokens.collectionId, schema.nftTokens.tokenId],
      set: {
        owner: data.owner,
        name: data.name || null,
        description: data.description || null,
        image: data.image || null,
        metadataUri: data.metadataUri || null,
        attributes: data.attributes || [],
        lastSyncedAt: new Date(),
        updatedAt: new Date(),
      },
    }).returning();

    // Update collection totalSupply
    const [{ count }] = await db.select({ count: sql<number>`count(*)::int` })
      .from(schema.nftTokens)
      .where(eq(schema.nftTokens.collectionId, data.collectionId));
    await db.update(schema.nftCollections)
      .set({ totalSupply: count, updatedAt: new Date() })
      .where(eq(schema.nftCollections.id, data.collectionId));

    return token;
  }

  /**
   * Get NFTs owned by a specific address
   */
  async getTokensByOwner(ownerAddress: string, limit = 50, offset = 0) {
    const tokens = await db.select({
      token: schema.nftTokens,
      collection: schema.nftCollections,
    })
      .from(schema.nftTokens)
      .leftJoin(schema.nftCollections, eq(schema.nftTokens.collectionId, schema.nftCollections.id))
      .where(eq(schema.nftTokens.owner, ownerAddress))
      .orderBy(desc(schema.nftTokens.createdAt))
      .limit(Math.min(limit, 100))
      .offset(offset);

    const [{ count }] = await db.select({ count: sql<number>`count(*)::int` })
      .from(schema.nftTokens)
      .where(eq(schema.nftTokens.owner, ownerAddress));

    return { tokens, total: count };
  }

  /**
   * Get tokens in a collection
   */
  async getTokensByCollection(collectionId: number, limit = 50, offset = 0) {
    const tokens = await db.select()
      .from(schema.nftTokens)
      .where(eq(schema.nftTokens.collectionId, collectionId))
      .orderBy(desc(schema.nftTokens.createdAt))
      .limit(Math.min(limit, 100))
      .offset(offset);

    const [{ count }] = await db.select({ count: sql<number>`count(*)::int` })
      .from(schema.nftTokens)
      .where(eq(schema.nftTokens.collectionId, collectionId));

    return { tokens, total: count };
  }

  /**
   * Get single NFT token by collection + token identifier
   */
  async getToken(collectionId: number, tokenIdentifier: string) {
    const [token] = await db.select({
      token: schema.nftTokens,
      collection: schema.nftCollections,
    })
      .from(schema.nftTokens)
      .leftJoin(schema.nftCollections, eq(schema.nftTokens.collectionId, schema.nftCollections.id))
      .where(and(
        eq(schema.nftTokens.collectionId, collectionId),
        eq(schema.nftTokens.tokenId, Number(tokenIdentifier)),
      ))
      .limit(1);
    return token || null;
  }

  // ── Soroban SEP-50 Contract Interaction ────────────────────

  /**
   * One read-only contract call, simulated on the collection's own network.
   * Throws when the RPC can't be reached; { found: false } when the contract refuses (for example, no such token).
   */
  async simulateRead(contractId: string, method: string, args: StellarSdk.xdr.ScVal[], network?: string | null): Promise<Read<any>> {
    const target = sorobanTargetFor(network ?? config.STELLAR_NETWORK);
    const contract = new StellarSdk.Contract(contractId);
    const tx = new StellarSdk.TransactionBuilder(
      new StellarSdk.Account(SIMULATION_SOURCE, "0"),
      { fee: "100", networkPassphrase: target.passphrase },
    ).addOperation(contract.call(method, ...args)).setTimeout(30).build();
    const result = await rpcFor(target.rpcUrl).simulateTransaction(tx);
    if (!StellarSdk.rpc.Api.isSimulationSuccess(result)) return { found: false };
    const retval = result.result?.retval;
    if (!retval) return { found: false };
    return { found: true, value: StellarSdk.scValToNative(retval) };
  }

  /**
   * Query a SEP-50 NFT contract for name, symbol and total_supply
   */
  async querySep50Contract(contractId: string, network?: string | null) {
    try {
      const [name, symbol, supply] = await Promise.all([
        this.simulateRead(contractId, "name", [], network),
        this.simulateRead(contractId, "symbol", [], network),
        this.simulateRead(contractId, "total_supply", [], network),
      ]);
      return {
        name: name.found ? String(name.value) : "",
        symbol: symbol.found ? String(symbol.value) : "",
        totalSupply: supply.found ? Number(supply.value) : 0,
        contractId,
      };
    } catch (err: any) {
      console.error("[nft] SEP-50 contract query failed:", err.message);
      return null;
    }
  }

  /**
   * Query token_uri for a specific NFT from a SEP-50 contract
   */
  async querySep50TokenUri(contractId: string, tokenId: number, network?: string | null) {
    try {
      const r = await this.simulateRead(contractId, "token_uri", [StellarSdk.nativeToScVal(tokenId, { type: "u32" })], network);
      return r.found ? (r.value as string) : null;
    } catch (err: any) {
      console.error("[nft] token_uri query failed:", err.message);
      return null;
    }
  }

  /**
   * Query owner_of for a specific token from a SEP-50 contract
   */
  async querySep50OwnerOf(contractId: string, tokenId: number, network?: string | null) {
    try {
      const r = await this.simulateRead(contractId, "owner_of", [StellarSdk.nativeToScVal(tokenId, { type: "u32" })], network);
      return r.found ? (r.value as string) : null;
    } catch (err: any) {
      console.error("[nft] owner_of query failed:", err.message);
      return null;
    }
  }

  /**
   * Build a SEP-50 transfer transaction XDR
   */
  async buildSep50Transfer(
    contractId: string,
    fromAddress: string,
    toAddress: string,
    tokenId: number,
  ) {
    try {
      const collection = await this.getCollectionByContract(contractId);
      const target = sorobanTargetFor(collection?.network ?? config.STELLAR_NETWORK);
      const account = await horizon.loadAccount(fromAddress);
      const contract = new StellarSdk.Contract(contractId);

      const op = contract.call(
        "transfer_from",
        StellarSdk.nativeToScVal(fromAddress, { type: "address" }),
        StellarSdk.nativeToScVal(fromAddress, { type: "address" }),
        StellarSdk.nativeToScVal(toAddress, { type: "address" }),
        StellarSdk.nativeToScVal(tokenId, { type: "u32" }),
      );

      const tx = new StellarSdk.TransactionBuilder(account, {
        fee: "1000000", // 0.1 XLM max fee for Soroban
        networkPassphrase: target.passphrase,
      })
        .addOperation(op)
        .setTimeout(120)
        .build();

      // Simulate to get proper resources
      const simulated = await rpcFor(target.rpcUrl).simulateTransaction(tx);
      if (!StellarSdk.rpc.Api.isSimulationSuccess(simulated)) {
        throw new Error("Transaction simulation failed");
      }

      const prepared = StellarSdk.rpc.assembleTransaction(tx, simulated).build();
      return { xdr: prepared.toXDR(), networkPassphrase: tx.networkPassphrase };
    } catch (err: any) {
      console.error("[nft] build transfer failed:", err.message);
      throw err;
    }
  }

  // ── Owner discovery (tokens minted on-chain without an index call) ──

  /**
   * Registers the contracts listed in NFT_KNOWN_SEP50_CONTRACTS (for example the LMS certificate contract),
   * once per process. Existing rows are left as they are.
   */
  async ensureKnownCollections() {
    if (!knownCollectionsReady) {
      knownCollectionsReady = (async () => {
        for (const k of knownSep50Contracts()) {
          await db.insert(schema.nftCollections).values({
            type: "sep50",
            contractId: k.contractId,
            name: "Certificates",
            network: k.network,
            totalSupply: 0,
            isVerified: true,
          }).onConflictDoNothing();
        }
      })().catch((err: any) => {
        knownCollectionsReady = null; // try again on the next lookup
        console.warn("[nft] could not register known SEP-50 contracts:", err.message);
      });
    }
    await knownCollectionsReady;
  }

  /**
   * Indexes new tokens of every SEP-50 collection, waiting at most budgetMs. Never throws.
   * Called by the owner lookup so a certificate minted on-chain shows in the wallet without anyone calling /nfts/mint.
   */
  async discoverForOwner(owner: string, budgetMs = 3000) {
    try {
      await this.ensureKnownCollections();
      await ownerDiscovery.refreshWithin(budgetMs, owner);
    } catch (err: any) {
      console.warn("[nft] owner discovery failed:", err.message);
    }
  }

  // ── Classic SEP-39 Detection ───────────────────────────────

  /**
   * Scan a Stellar account for potential SEP-39 NFT assets
   * (assets with supply=1 from issuers with specific TOML metadata)
   */
  async scanClassicNfts(publicKey: string) {
    try {
      const account = await horizon.loadAccount(publicKey);
      const nftCandidates: any[] = [];

      for (const balance of account.balances) {
        if (balance.asset_type === "native") continue;
        const b = balance as any;

        // SEP-39: NFTs are typically assets with very low supply (often 1)
        // and specific TOML metadata
        if (parseFloat(b.balance) > 0 && b.asset_code && b.asset_issuer) {
          try {
            const asset = await horizon.assets()
              .forCode(b.asset_code)
              .forIssuer(b.asset_issuer)
              .call();

            const record = asset.records?.[0];
            if (record) {
              const totalAmount = parseFloat(record.amount);
              // Likely NFT if supply is 1 (or very low) and issuer is locked
              if (totalAmount <= 10) {
                nftCandidates.push({
                  assetCode: b.asset_code,
                  assetIssuer: b.asset_issuer,
                  balance: b.balance,
                  totalSupply: totalAmount,
                  homeDomain: (record as any).home_domain || null,
                  isLocked: (record as any).flags?.auth_immutable || false,
                });
              }
            }
          } catch {
            // Skip assets that can't be queried
          }
        }
      }
      return nftCandidates;
    } catch (err: any) {
      console.error("[nft] classic scan failed:", err.message);
      return [];
    }
  }

  /**
   * Sync all tokens for a SEP-50 collection by querying the contract on-chain.
   * Iterates token IDs from 0 to totalSupply and indexes each one.
   */
  async syncCollectionTokens(collectionId: number) {
    const collection = await this.getCollection(collectionId);
    if (!collection || !collection.contractId) {
      throw new Error("Collection not found or missing contractId");
    }

    // Query current total supply from contract
    const contractData = await this.querySep50Contract(collection.contractId, collection.network);
    if (!contractData) throw new Error("Failed to query contract");

    const results: any[] = [];
    // Ids may start at 0 or 1, so read up to and including total_supply; missing ids are skipped.
    for (let i = 0; i <= contractData.totalSupply; i++) {
      try {
        const [ownerOf, tokenUri] = await Promise.all([
          this.querySep50OwnerOf(collection.contractId, i, collection.network),
          this.querySep50TokenUri(collection.contractId, i, collection.network),
        ]);

        if (!ownerOf) continue; // token may be burned

        // Try to fetch metadata from tokenUri
        let name: string | undefined;
        let description: string | undefined;
        let image: string | undefined;
        let attributes: any;

        if (tokenUri) {
          try {
            // Convert IPFS URI to HTTP gateway
            const httpUri = tokenUri.startsWith("ipfs://")
              ? tokenUri.replace("ipfs://", "https://ipfs.io/ipfs/")
              : tokenUri;
            validateExternalUrl(httpUri); // throws on private/unsafe URLs
            const resp = await fetch(httpUri, { signal: AbortSignal.timeout(10000) });
            if (resp.ok) {
              const metadata = await resp.json();
              name = metadata.name;
              description = metadata.description;
              image = metadata.image;
              attributes = metadata.attributes;
              // Also convert image IPFS URI
              if (image && image.startsWith("ipfs://")) {
                image = image.replace("ipfs://", "https://ipfs.io/ipfs/");
              }
            }
          } catch (err: any) {
            console.warn(`[nft] Failed to fetch metadata for token ${i}:`, err.message);
          }
        }

        const token = await this.indexToken({
          collectionId,
          tokenId: i,
          owner: ownerOf,
          name,
          description,
          image,
          metadataUri: tokenUri || undefined,
          attributes,
        });
        results.push(token);
      } catch (err: any) {
        console.warn(`[nft] Failed to sync token ${i}:`, err.message);
      }
    }

    // Update collection totalSupply
    await db.update(schema.nftCollections)
      .set({ totalSupply: contractData.totalSupply, updatedAt: new Date() })
      .where(eq(schema.nftCollections.id, collectionId));

    return { synced: results.length, totalSupply: contractData.totalSupply };
  }

}

export const nftService = new NftService();

/** Fetches token metadata JSON from an https or ipfs URI, refusing private addresses. */
async function fetchTokenMetadata(uri: string) {
  const httpUri = uri.startsWith("ipfs://") ? uri.replace("ipfs://", "https://ipfs.io/ipfs/") : uri;
  validateExternalUrl(httpUri);
  // No redirects (a checked public URL must not bounce to an internal one) and at most 64 KB of JSON.
  // Public IPFS gateways often take 3-7 s; discovery keeps running after the lookup budget, so a longer wait is fine.
  const resp = await fetch(httpUri, { signal: AbortSignal.timeout(10_000), redirect: "error" });
  if (!resp.ok) return null;
  const text = await resp.text();
  if (text.length > 65_536) return null;
  let m: any;
  try { m = JSON.parse(text); } catch { return null; }
  const image = typeof m?.image === "string" && m.image.startsWith("ipfs://") ? m.image.replace("ipfs://", "https://ipfs.io/ipfs/") : m?.image;
  return { name: m?.name, description: m?.description, image, attributes: m?.attributes };
}

const ownerDiscovery = createOwnerDiscovery({
  listSep50Collections: async () => {
    const rows = await db.select({ id: schema.nftCollections.id, contractId: schema.nftCollections.contractId, network: schema.nftCollections.network })
      .from(schema.nftCollections)
      .where(and(eq(schema.nftCollections.type, "sep50"), isNotNull(schema.nftCollections.contractId)));
    return rows.map((r) => ({ id: r.id, contractId: r.contractId as string, network: r.network }));
  },
  tokensWithoutMetadata: async (collectionId, limit) => {
    const rows = await db.select({ tokenId: schema.nftTokens.tokenId, owner: schema.nftTokens.owner, metadataUri: schema.nftTokens.metadataUri })
      .from(schema.nftTokens)
      .where(and(eq(schema.nftTokens.collectionId, collectionId), isNull(schema.nftTokens.name), isNotNull(schema.nftTokens.metadataUri)))
      .limit(limit);
    return rows.filter((r) => r.owner).map((r) => ({ tokenId: Number(r.tokenId), owner: r.owner as string, metadataUri: r.metadataUri as string }));
  },
  indexedTokenIds: async (collectionId) => {
    const rows = await db.select({ tokenId: schema.nftTokens.tokenId })
      .from(schema.nftTokens)
      .where(eq(schema.nftTokens.collectionId, collectionId));
    return new Set(rows.map((r) => Number(r.tokenId)));
  },
  totalSupply: async (c) => {
    const r = await nftService.simulateRead(c.contractId, "total_supply", [], c.network);
    if (!r.found) throw new Error("total_supply not readable");
    return Number(r.value);
  },
  ownerOf: async (c, tokenId) => {
    const r = await nftService.simulateRead(c.contractId, "owner_of", [StellarSdk.nativeToScVal(tokenId, { type: "u32" })], c.network);
    return r.found ? { found: true, value: String(r.value) } : { found: false };
  },
  tokenUri: (c, tokenId) => nftService.querySep50TokenUri(c.contractId, tokenId, c.network),
  fetchMetadata: fetchTokenMetadata,
  index: async (t) => { await nftService.indexToken(t as any); },
  now: () => Date.now(),
  warn: (msg, detail) => console.warn(msg, detail ?? ""),
});
