import { describe, it, expect, vi, beforeEach } from "vitest";

const { auditLogStrict } = vi.hoisted(() => ({ auditLogStrict: vi.fn(async (..._args: unknown[]) => {}) }));
vi.mock("./audit", () => ({ auditLogStrict }));

import {
  LocalMasterKeyProvider,
  sealForEscrow,
  openFromEscrow,
  masterKeyProviderFromEnv,
} from "./key-wrapper";

const MASTER = Buffer.alloc(32, 7).toString("base64");
const PHRASE = "legal winner thank year wave sausage worth useful legal winner thank yellow";
const ctx = { userId: 42, kind: "phrase" as const };

beforeEach(() => auditLogStrict.mockClear());

describe("key wrapper (server-readable escrow)", () => {
  const provider = new LocalMasterKeyProvider(MASTER);

  it("seals a phrase and opens it again", async () => {
    const sealed = await sealForEscrow(provider, PHRASE, ctx);
    expect(await openFromEscrow(provider, sealed, { ...ctx, reason: "restore" })).toBe(PHRASE);
  });

  it("never puts the plaintext or any word of it in the sealed text", async () => {
    const sealed = await sealForEscrow(provider, PHRASE, ctx);
    for (const word of PHRASE.split(" ")) expect(sealed).not.toContain(word);
    expect(Buffer.from(sealed.split(".").slice(-1)[0], "base64").toString("utf8")).not.toContain("legal");
  });

  it("uses a fresh data key and iv each time", async () => {
    const a = await sealForEscrow(provider, PHRASE, ctx);
    const b = await sealForEscrow(provider, PHRASE, ctx);
    expect(a).not.toBe(b);
  });

  it("refuses a sealed copy moved to another user or kind", async () => {
    const sealed = await sealForEscrow(provider, PHRASE, ctx);
    await expect(openFromEscrow(provider, sealed, { userId: 43, kind: "phrase", reason: "restore" })).rejects.toThrow(/cannot be opened/i);
    await expect(openFromEscrow(provider, sealed, { userId: 42, kind: "stellar-secret", reason: "restore" })).rejects.toThrow(/cannot be opened/i);
  });

  it("refuses a different master key and a tampered copy", async () => {
    const sealed = await sealForEscrow(provider, PHRASE, ctx);
    const other = new LocalMasterKeyProvider(Buffer.alloc(32, 9).toString("base64"));
    await expect(openFromEscrow(other, sealed, { ...ctx, reason: "restore" })).rejects.toThrow(/cannot be opened/i);
    const parts = sealed.split(".");
    const ct = Buffer.from(parts[parts.length - 1], "base64");
    ct[0] ^= 1;
    parts[parts.length - 1] = ct.toString("base64");
    await expect(openFromEscrow(provider, parts.join("."), { ...ctx, reason: "restore" })).rejects.toThrow(/cannot be opened/i);
  });

  it("audits every successful open, with who and why, and never the secret", async () => {
    const sealed = await sealForEscrow(provider, PHRASE, ctx);
    await openFromEscrow(provider, sealed, { ...ctx, reason: "restore", ip: "203.0.113.5" });
    expect(auditLogStrict).toHaveBeenCalledTimes(1);
    const [action, opts] = auditLogStrict.mock.calls[0] as unknown as [string, { userId: number; detail: Record<string, unknown>; ip: string }];
    expect(action).toBe("wallet_key_escrow_open");
    expect(opts.userId).toBe(42);
    expect(opts.detail).toMatchObject({ kind: "phrase", reason: "restore", provider: "local" });
    expect(JSON.stringify(opts)).not.toContain("legal");
  });

  it("does not hand over the secret when the audit row cannot be written", async () => {
    const sealed = await sealForEscrow(provider, PHRASE, ctx);
    auditLogStrict.mockRejectedValueOnce(new Error("db down"));
    await expect(openFromEscrow(provider, sealed, { ...ctx, reason: "restore" })).rejects.toThrow(/audit/i);
  });

  it("rejects a master key that is not 32 bytes", () => {
    expect(() => new LocalMasterKeyProvider(Buffer.alloc(16).toString("base64"))).toThrow(/32 bytes/);
  });
});

describe("masterKeyProviderFromEnv", () => {
  it("returns null when nothing is configured, so the feature stays off", () => {
    expect(masterKeyProviderFromEnv({ STELLAR_NETWORK: "testnet" })).toBeNull();
  });

  it("builds the local provider on testnet", () => {
    const p = masterKeyProviderFromEnv({ KEY_WRAP_PROVIDER: "local", KEY_WRAP_MASTER_KEY: MASTER, STELLAR_NETWORK: "testnet" });
    expect(p?.id).toBe("local");
  });

  it("refuses the local provider on mainnet", () => {
    expect(() => masterKeyProviderFromEnv({ KEY_WRAP_PROVIDER: "local", KEY_WRAP_MASTER_KEY: MASTER, STELLAR_NETWORK: "public" })).toThrow(/mainnet/i);
    for (const net of ["mainnet", "pubnet", "PUBLIC"]) {
      expect(() => masterKeyProviderFromEnv({ KEY_WRAP_PROVIDER: "local", KEY_WRAP_MASTER_KEY: MASTER, STELLAR_NETWORK: net })).toThrow(/mainnet/i);
    }
    expect(masterKeyProviderFromEnv({ KEY_WRAP_PROVIDER: "local", KEY_WRAP_MASTER_KEY: MASTER })?.id).toBe("local");
  });

  it('allows the local provider on public only with MAINNET_CUSTODY=on', () => {
    const env = { KEY_WRAP_PROVIDER: 'local', KEY_WRAP_MASTER_KEY: MASTER, STELLAR_NETWORK: 'public' };
    expect(masterKeyProviderFromEnv({ ...env, MAINNET_CUSTODY: 'on', CUSTODY_SERVER_SIGNING: 'true' })?.id).toBe('local');
    // Mainnet custody with server signing off: the local provider is refused.
    expect(() => masterKeyProviderFromEnv({ ...env, MAINNET_CUSTODY: 'on' })).toThrow(/CUSTODY_SERVER_SIGNING/);
    expect(() => masterKeyProviderFromEnv({ ...env, MAINNET_CUSTODY: 'on', CUSTODY_SERVER_SIGNING: 'false' })).toThrow(/CUSTODY_SERVER_SIGNING/);
    expect(() => masterKeyProviderFromEnv({ ...env, MAINNET_CUSTODY: 'true' })).toThrow(/mainnet/i);
    expect(() => masterKeyProviderFromEnv({ ...env, STELLAR_NETWORK: 'mainnet', MAINNET_CUSTODY: 'on' })).toThrow(/mainnet/i);
  });

  it("refuses a hardware provider that is not switched on yet", () => {
    expect(() => masterKeyProviderFromEnv({ KEY_WRAP_PROVIDER: "aws-kms", STELLAR_NETWORK: "testnet" })).toThrow(/not enabled/i);
  });

  it("refuses an unknown provider name and a missing local key", () => {
    expect(() => masterKeyProviderFromEnv({ KEY_WRAP_PROVIDER: "nope", STELLAR_NETWORK: "testnet" })).toThrow(/unknown/i);
    expect(() => masterKeyProviderFromEnv({ KEY_WRAP_PROVIDER: "local", STELLAR_NETWORK: "testnet" })).toThrow(/KEY_WRAP_MASTER_KEY/);
  });
});
