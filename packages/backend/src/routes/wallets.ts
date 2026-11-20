import { FastifyInstance, FastifyReply } from "fastify";
import { db, schema } from "../db";
import { eq, and, ne, sql } from "drizzle-orm";
import { authMiddleware } from "../middleware/auth";
import { attachTenantApiKey, requireScope } from "../middleware/tenant-api-key";
import { config } from "../config";
import { auditLog } from "../lib/audit";
import { decryptSecret, encryptSecret, passphraseProblem } from "../lib/decrypt-secret";
import { FORBIDDEN_SCHEMA, isLegacyPin, pinRetired } from "../lib/pin-retired";
import type { CustodyFlags } from "../lib/custody-flags";
import { findActiveStellarWallet } from "../services/stellar-wallet.service";
import {
  checkWalletBilling,
  checkWalletBillingTx,
  writeBillingDebit,
  upsertTenantUser,
  maybeNotifyDeficit,
} from "../services/billing.service";

/** The caller's signing mode; a missing value counts as delegated, the column default. */
async function signingModeOf(userId: number): Promise<"self" | "delegated"> {
  const [user] = await db.select({ signingMode: schema.users.signingMode }).from(schema.users).where(eq(schema.users.id, userId)).limit(1);
  return user?.signingMode === "self" ? "self" : "delegated";
}

export async function walletRoutes(app: FastifyInstance, opts: { custodyFlags?: CustodyFlags } = {}) {
  // ──────────────────────────────────────────
  // GET USER WALLETS
  // ──────────────────────────────────────────
  app.get("/api/v1/wallets", {
      preHandler: authMiddleware,
      schema: {
        description: "List all wallets for the authenticated user.",
        tags: ["Wallets"],
        security: [{ bearerAuth: [] }],
        response: {
          200: {
            type: "array",
            items: {
                type: "object",
                properties: {
                  id: { type: "number" },
                  userId: { type: "number" },
                  name: { type: "string" },
                  publicKey: { type: "string" },
                  network: { type: "string" },
                  isActive: { type: "boolean" },
                  hasServerKey: { type: "boolean", description: "The server holds an encrypted key copy (never returned)" },
                  createdAt: { type: "string", format: "date-time" },
                },
              },
          },
        },
      },
    }, async (request) => {
    const userId = request.user!.userId;

    const wallets = await db
      .select({
        id: schema.userWallets.id,
        userId: schema.userWallets.userId,
        name: schema.userWallets.name,
        publicKey: schema.userWallets.publicKey,
        network: schema.userWallets.network,
        isActive: schema.userWallets.isActive,
        hasServerKey: sql<boolean>`"user_wallets"."encrypted_secret" IS NOT NULL`,
        createdAt: schema.userWallets.createdAt,
      })
      .from(schema.userWallets)
      .where(and(eq(schema.userWallets.userId, userId), eq(schema.userWallets.chain, "stellar"), eq(schema.userWallets.network, config.STELLAR_NETWORK)));

    return wallets;
  });

  // ──────────────────────────────────────────
  // ADD WALLET
  // ──────────────────────────────────────────
  // Phase 2: attachTenantApiKey added alongside authMiddleware so that server-to-server
  // callers (e.g. LMS) can pass both a user JWT and an x-api-key. When a valid API key
  // with a tenantId is present, wallet creation triggers a billing debit.
  app.post("/api/v1/wallets", {
      preHandler: [authMiddleware, attachTenantApiKey, requireScope("wallet:create")],
      schema: {
        description: "Add a new wallet. Becomes the active wallet; all others are deactivated.",
        tags: ["Wallets"],
        security: [{ bearerAuth: [] }],
        body: {
          type: "object",
          required: ["name", "publicKey"],
          properties: {
            name: { type: "string", minLength: 1, maxLength: 64, description: "Display name for the wallet" },
            publicKey: { type: "string", pattern: "^G[A-Z2-7]{55}$", description: "Stellar public key (G...)" },
            encryptedSecret: { type: "string", description: "AES-GCM encrypted secret key (for delegated mode)" },
            network: { type: "string", enum: ["testnet", "mainnet", "public"], default: "public" },
          },
        },
        response: {
          200: {
                type: "object",
                properties: {
                  id: { type: "number" },
                  userId: { type: "number" },
                  name: { type: "string" },
                  publicKey: { type: "string" },
                  network: { type: "string" },
                  isActive: { type: "boolean" },
                  createdAt: { type: "string", format: "date-time" },
                },
              },
          400: { type: "object", properties: { error: { type: "string" } } },
          402: { type: "object", properties: { error: { type: "string" } } },
          409: { type: "object", properties: { error: { type: "string" } } },
        },
      },
    }, async (request, reply: FastifyReply) => {
    const userId = request.user!.userId;
    const tenantCtx = request.tenantApiKeyContext;
    const { name, publicKey, encryptedSecret, network } = request.body as {
      name: string;
      publicKey: string;
      encryptedSecret?: string;
      network?: string;
    };

    if (!name || !publicKey) {
      return reply.status(400).send({ error: "Name and publicKey are required" });
    }

    // Audit F-1 / D1b: only delegated signing needs a server copy of the key.
    // In self-custody mode it stays on the device, whatever a client sends.
    const keepSecret = encryptedSecret ? (await signingModeOf(userId)) === "delegated" : false;

    // Always enforce the server's configured network — client-supplied value is ignored.
    // This prevents mainnet clients from creating testnet wallets and vice versa.
    const effectiveNetwork = config.STELLAR_NETWORK === "public"
      ? "public"
      : config.STELLAR_NETWORK === "testnet"
        ? "testnet"
        : (network || "public");

    // Check if wallet already exists for this user
    const existing = await db
      .select({ id: schema.userWallets.id })
      .from(schema.userWallets)
      .where(
        and(
          and(eq(schema.userWallets.userId, userId), eq(schema.userWallets.chain, "stellar"), eq(schema.userWallets.network, config.STELLAR_NETWORK)),
          eq(schema.userWallets.publicKey, publicKey)
        )
      )
      .limit(1);

    if (existing.length > 0) {
      return reply.status(409).send({ error: "Wallet already exists" });
    }

    // A Stellar key registered to another user cannot be added here (H1-b): listing someone else's
    // address must not make their device-held key look like this user's.
    const takenByOther = await db
      .select({ id: schema.userWallets.id })
      .from(schema.userWallets)
      .where(and(eq(schema.userWallets.chain, "stellar"), eq(schema.userWallets.network, config.STELLAR_NETWORK), eq(schema.userWallets.publicKey, publicKey), ne(schema.userWallets.userId, userId)))
      .limit(1);
    if (takenByOther.length > 0) return reply.status(409).send({ error: "Wallet already exists" });

    // Check for duplicate name
    const duplicateName = await db
      .select({ id: schema.userWallets.id })
      .from(schema.userWallets)
      .where(
        and(
          and(eq(schema.userWallets.userId, userId), eq(schema.userWallets.chain, "stellar"), eq(schema.userWallets.network, config.STELLAR_NETWORK)),
          eq(schema.userWallets.name, name)
        )
      )
      .limit(1);

    if (duplicateName.length > 0) {
      return reply.status(409).send({ error: "A wallet with this name already exists" });
    }

    // ── Phase 2: billing pre-flight check ──────────────────────────────────
    // Only applies when a tenant API key with a tenantId is present.
    let billingResult: Awaited<ReturnType<typeof checkWalletBilling>> | null = null;

    if (tenantCtx?.tenantId) {
      billingResult = await checkWalletBilling({ tenantId: tenantCtx.tenantId, userId });

      if (!billingResult.ok) {
        return reply.status(billingResult.httpStatus).send({ error: billingResult.message });
      }
    }

    // ── Wallet creation + billing debit in one transaction ─────────────────
    let debitNewBalance: string | null = null;

    let wallet;
    try {
      wallet = await db.transaction(async (tx) => {
        await tx.execute(sql`SELECT id FROM users WHERE id = ${userId} FOR NO KEY UPDATE`);
        // Re-validate billing with FOR UPDATE lock (P1-2-F2 TOCTOU guard)
        if (tenantCtx?.tenantId) {
          const txBilling = await checkWalletBillingTx(tx, {
            tenantId: tenantCtx.tenantId,
            userId,
          });
          if (!txBilling.ok) {
            throw Object.assign(new Error(txBilling.message), {
              httpStatus: txBilling.httpStatus,
            });
          }
          billingResult = txBilling;
        }

        // Deactivate other wallets
        await tx
          .update(schema.userWallets)
          .set({ isActive: false })
          .where(and(eq(schema.userWallets.userId, userId), eq(schema.userWallets.chain, "stellar"), eq(schema.userWallets.network, config.STELLAR_NETWORK)));

        // Insert new wallet
        const [created] = await tx
          .insert(schema.userWallets)
          .values({
            userId,
            chain: "stellar",
            name,
            publicKey,
            encryptedSecret: keepSecret ? encryptedSecret : null,
            network: effectiveNetwork,
            isActive: true,
          })
          .returning();

        // Billing writes (only when a billing action is needed)
        if (
          billingResult?.ok &&
          billingResult.eventType !== "no_billing" &&
          billingResult.eventType !== "idempotent_skip" &&
          billingResult.eventType !== "task_activation_partner" &&
          tenantCtx?.tenantId
        ) {
          const { eventType, amountXlm, policy } = billingResult as Extract<
            typeof billingResult,
            { eventType: "new_wallet_activation" | "existing_user_onboarding" }
          >;

          const debitResult = await writeBillingDebit(tx, {
            tenantId: tenantCtx.tenantId,
            eventType,
            amountXlm,
            policyVersionId: policy.id,
            userId,
            apiKeyId: tenantCtx.keyId,
            // Snapshot fields for new_wallet_activation
            walletFundingSnapshot:
              eventType === "new_wallet_activation" && policy.walletFundingEnabled
                ? policy.walletFundingXlm
                : null,
            platformFeeSnapshot:
              eventType === "new_wallet_activation" ? policy.newWalletPlatformFeeXlm : null,
            // Snapshot field for existing_user_onboarding
            onboardingFeeSnapshot:
              eventType === "existing_user_onboarding" ? policy.onboardingFeeXlm : null,
          });
          debitNewBalance = debitResult.newBalance;

          // Link user to tenant (idempotent — ignores conflicts)
          await upsertTenantUser(tx, tenantCtx.tenantId, userId);
        } else if (
          billingResult?.ok &&
          (billingResult.eventType === "idempotent_skip" || billingResult.eventType === "task_activation_partner") &&
          tenantCtx?.tenantId
        ) {
          // Already onboarded and active, or a task-activation partner (billed per completed task, not at sign-up):
          // no charge here, just ensure the tenant_users row exists.
          await upsertTenantUser(tx, tenantCtx.tenantId, userId);
        }

        return created;
      });
    } catch (err: unknown) {
      const code = (err as { code?: string; cause?: { code?: string } })?.cause?.code
        ?? (err as { code?: string })?.code;
      if (code === "23505") return reply.status(409).send({ error: "Wallet already exists" });
      // Handle billing failures thrown from within the transaction
      if (err && typeof err === "object" && "httpStatus" in err) {
        const billingErr = err as Error & { httpStatus: number };
        return reply.status(billingErr.httpStatus).send({ error: billingErr.message });
      }
      throw err;
    }

    // Fire-and-forget deficit notification after transaction commits
    if (debitNewBalance !== null && tenantCtx?.tenantId) {
      maybeNotifyDeficit(tenantCtx.tenantId, debitNewBalance).catch(() => {});
    }

    return wallet;
  });

  // ──────────────────────────────────────────
  // SET ACTIVE WALLET
  // ──────────────────────────────────────────
  app.patch("/api/v1/wallets/:id/activate", {
      preHandler: authMiddleware,
      schema: {
        description: "Set a wallet as the active wallet. Deactivates all others.",
        tags: ["Wallets"],
        security: [{ bearerAuth: [] }],
        params: {
          type: "object",
          properties: {
            id: { type: "string", pattern: "^\\d+$", description: "Wallet ID" },
          },
        },
        response: {
          200: {
                type: "object",
                properties: {
                  id: { type: "number" },
                  userId: { type: "number" },
                  name: { type: "string" },
                  publicKey: { type: "string" },
                  network: { type: "string" },
                  isActive: { type: "boolean" },
                  createdAt: { type: "string", format: "date-time" },
                },
              },
          404: { type: "object", properties: { error: { type: "string" } } },
        },
      },
    }, async (request, reply) => {
    const userId = request.user!.userId;
    const { id } = request.params as { id: string };

    // Verify target exists and belongs to user BEFORE deactivating (P0-3-F8)
    const [target] = await db
      .select({ id: schema.userWallets.id })
      .from(schema.userWallets)
      .where(
        and(
          eq(schema.userWallets.id, parseInt(id)),
          and(eq(schema.userWallets.userId, userId), eq(schema.userWallets.chain, "stellar"), eq(schema.userWallets.network, config.STELLAR_NETWORK))
        )
      )
      .limit(1);

    if (!target) {
      return reply.status(404).send({ error: "Wallet not found" });
    }

    // Atomic swap: deactivate all, then activate target
    const wallet = await db.transaction(async (tx) => {
      await tx.execute(sql`SELECT id FROM users WHERE id = ${userId} FOR NO KEY UPDATE`);
      const [stillOwned] = await tx.select({ id: schema.userWallets.id }).from(schema.userWallets)
        .where(and(eq(schema.userWallets.id, target.id), eq(schema.userWallets.userId, userId), eq(schema.userWallets.chain, "stellar"), eq(schema.userWallets.network, config.STELLAR_NETWORK))).limit(1);
      if (!stillOwned) throw new Error("Wallet changed during activation; retry");

      await tx
        .update(schema.userWallets)
        .set({ isActive: false })
        .where(and(eq(schema.userWallets.userId, userId), eq(schema.userWallets.chain, "stellar"), eq(schema.userWallets.network, config.STELLAR_NETWORK)));

      const [activated] = await tx
        .update(schema.userWallets)
        .set({ isActive: true })
        .where(eq(schema.userWallets.id, target.id))
        .returning();

      return activated;
    });

    return wallet;
  });

  // ──────────────────────────────────────────
  // RENAME WALLET
  // ──────────────────────────────────────────
  app.patch("/api/v1/wallets/:id", {
      preHandler: authMiddleware,
      schema: {
        description: "Rename a wallet.",
        tags: ["Wallets"],
        security: [{ bearerAuth: [] }],
        params: {
          type: "object",
          properties: {
            id: { type: "string", pattern: "^\\d+$", description: "Wallet ID" },
          },
        },
        body: {
          type: "object",
          required: ["name"],
          properties: {
            name: { type: "string", description: "New wallet name" },
          },
        },
        response: {
          200: {
                type: "object",
                properties: {
                  id: { type: "number" },
                  userId: { type: "number" },
                  name: { type: "string" },
                  publicKey: { type: "string" },
                  network: { type: "string" },
                  isActive: { type: "boolean" },
                  createdAt: { type: "string", format: "date-time" },
                },
              },
          404: { type: "object", properties: { error: { type: "string" } } },
        },
      },
    }, async (request, reply) => {
    const userId = request.user!.userId;
    const { id } = request.params as { id: string };
    const { name } = request.body as { name: string };

    const [wallet] = await db
      .update(schema.userWallets)
      .set({ name })
      .where(
        and(
          eq(schema.userWallets.id, parseInt(id)),
          and(eq(schema.userWallets.userId, userId), eq(schema.userWallets.chain, "stellar"), eq(schema.userWallets.network, config.STELLAR_NETWORK))
        )
      )
      .returning();

    if (!wallet) {
      return reply.status(404).send({ error: "Wallet not found" });
    }

    return wallet;
  });

  // ──────────────────────────────────────────
  // REPLACE ENCRYPTED SECRET
  // Used when a person moves a wallet from a short PIN to a 12+ character
  // passphrase: the browser re-encrypts the key and sends only the new
  // ciphertext. The server never sees the key or the passphrase here.
  // ──────────────────────────────────────────
  app.patch("/api/v1/wallets/:id/secret", {
      preHandler: authMiddleware,
      schema: {
        description: "Replace the encrypted secret of one of the caller's Stellar wallets (after a passphrase change).",
        tags: ["Wallets"],
        security: [{ bearerAuth: [] }],
        params: {
          type: "object",
          properties: {
            id: { type: "string", pattern: "^\\d+$", description: "Wallet ID" },
          },
        },
        body: {
          type: "object",
          required: ["encryptedSecret"],
          additionalProperties: false,
          properties: {
            // base64(salt 16 + iv 12 + AES-GCM ciphertext and tag): 100 bytes for a Stellar secret.
            encryptedSecret: { type: "string", minLength: 96, maxLength: 512, pattern: "^[A-Za-z0-9+/]+={0,2}$" },
          },
        },
        response: {
          200: { type: "object", properties: { ok: { type: "boolean" } } },
          404: { type: "object", properties: { error: { type: "string" } } },
        },
      },
    }, async (request, reply) => {
    const userId = request.user!.userId;
    const { id } = request.params as { id: string };
    const { encryptedSecret } = request.body as { encryptedSecret: string };

    const [wallet] = await db
      .update(schema.userWallets)
      .set({ encryptedSecret })
      .where(
        and(
          eq(schema.userWallets.id, parseInt(id)),
          and(eq(schema.userWallets.userId, userId), eq(schema.userWallets.chain, "stellar"), eq(schema.userWallets.network, config.STELLAR_NETWORK))
        )
      )
      .returning({ id: schema.userWallets.id });

    if (!wallet) {
      return reply.status(404).send({ error: "Wallet not found" });
    }

    return { ok: true };
  });

  // ──────────────────────────────────────────
  // CHANGE PIN TO PASSPHRASE (delegated signing)
  // In delegated mode the browser holds no ciphertext, so the server does the
  // re-encryption. It already receives the PIN with every delegated signature,
  // so this exposes nothing new. Proof of the current PIN is required.
  // ──────────────────────────────────────────
  app.post("/api/v1/wallets/active/passphrase", {
      preHandler: authMiddleware,
      config: { rateLimit: { max: 5, timeWindow: "15 minutes" } },
      schema: {
        description: "Delegated signing: re-encrypt the active Stellar wallet's key with a new 12+ character passphrase.",
        tags: ["Wallets"],
        security: [{ bearerAuth: [] }],
        body: {
          type: "object",
          required: ["currentPin", "newPassphrase"],
          additionalProperties: false,
          properties: {
            currentPin: { type: "string", minLength: 1, maxLength: 128 },
            newPassphrase: { type: "string", minLength: 1, maxLength: 128 },
          },
        },
        response: {
          200: { type: "object", properties: { ok: { type: "boolean" } } },
          400: { type: "object", properties: { error: { type: "string" } } },
          403: FORBIDDEN_SCHEMA,
          404: { type: "object", properties: { error: { type: "string" } } },
        },
      },
    }, async (request, reply) => {
    const userId = request.user!.userId;
    const { currentPin, newPassphrase } = request.body as { currentPin: string; newPassphrase: string };

    const problem = passphraseProblem(newPassphrase);
    if (problem) return reply.status(400).send({ error: problem });

    const [user] = await db.select({ signingMode: schema.users.signingMode }).from(schema.users).where(eq(schema.users.id, userId)).limit(1);
    if (!user || user.signingMode !== "delegated") {
      return reply.status(403).send({ error: "Only for wallets that use delegated signing." });
    }

    const wallet = await findActiveStellarWallet(userId);
    if (!wallet?.encryptedSecret) return reply.status(404).send({ error: "No active wallet with a stored key" });

    let secret: string;
    try {
      secret = await decryptSecret(wallet.encryptedSecret, currentPin);
    } catch {
      return reply.status(403).send({ error: "The current wallet passphrase is not correct." });
    }
    // Legacy PIN wallets move into custody instead; swapping the PIN for a passphrase is not offered (lib/pin-retired.ts).
    if (isLegacyPin(currentPin)) return reply.status(403).send(pinRetired(opts.custodyFlags ?? { serverSigning: false }, userId));

    const encrypted = await encryptSecret(secret, newPassphrase);
    // Only replace the exact ciphertext we decrypted, so a concurrent change is not overwritten.
    const [updated] = await db
      .update(schema.userWallets)
      .set({ encryptedSecret: encrypted })
      .where(and(eq(schema.userWallets.id, wallet.id), eq(schema.userWallets.encryptedSecret, wallet.encryptedSecret)))
      .returning({ id: schema.userWallets.id });
    if (!updated) return reply.status(403).send({ error: "The wallet changed meanwhile. Try again." });

    return { ok: true };
  });

  // ──────────────────────────────────────────
  // READ BACK THE STORED KEY COPY (managed wallet, custody plan step 1)
  // ──────────────────────────────────────────
  // A delegated user whose device has no key (a new phone, a wallet made on the
  // web) gets their stored copy back. The copy is encrypted with their own
  // passphrase and is not decrypted here; the client opens it. Every read is
  // audited, and the ciphertext is never written to the audit record.
  app.get("/api/v1/wallets/:id/secret", {
      preHandler: authMiddleware,
      config: { rateLimit: { max: 5, timeWindow: "15 minutes" } },
      schema: {
        description: "Return the caller's stored encrypted key copy for one Stellar wallet (delegated signing only). The copy opens only with the user's passphrase.",
        tags: ["Wallets"],
        security: [{ bearerAuth: [] }],
        params: {
          type: "object",
          properties: {
            id: { type: "string", pattern: "^\\d+$", description: "Wallet ID" },
          },
        },
        response: {
          200: { type: "object", properties: { encryptedSecret: { type: "string" } } },
          404: { type: "object", properties: { error: { type: "string" } } },
          409: { type: "object", properties: { error: { type: "string" } } },
        },
      },
    }, async (request, reply) => {
    const userId = request.user!.userId;
    const { id } = request.params as { id: string };
    if ((await signingModeOf(userId)) !== "delegated") {
      return reply.status(409).send({ error: "You keep your own keys. Restore with your recovery phrase or secret key." });
    }
    const [wallet] = await db
      .select({ id: schema.userWallets.id, encryptedSecret: schema.userWallets.encryptedSecret })
      .from(schema.userWallets)
      .where(and(eq(schema.userWallets.id, parseInt(id)), eq(schema.userWallets.userId, userId), eq(schema.userWallets.chain, "stellar"), eq(schema.userWallets.network, config.STELLAR_NETWORK)));
    if (!wallet?.encryptedSecret) return reply.status(404).send({ error: "No stored key for this wallet" });
    await auditLog("wallet_key_backup_read", { userId, detail: { walletId: wallet.id }, ip: request.ip, userAgent: request.headers["user-agent"] });
    return { encryptedSecret: wallet.encryptedSecret };
  });

  // ──────────────────────────────────────────
  // REMOVE SERVER KEY COPY (self-custody, D1b)
  // ──────────────────────────────────────────
  app.delete("/api/v1/wallets/:id/secret", {
      preHandler: authMiddleware,
      schema: {
        description: "Remove the server's encrypted copy of one of the caller's Stellar keys. Self-custody only: delegated signing needs it.",
        tags: ["Wallets"],
        security: [{ bearerAuth: [] }],
        params: {
          type: "object",
          properties: {
            id: { type: "string", pattern: "^\\d+$", description: "Wallet ID" },
          },
        },
        response: {
          200: { type: "object", properties: { ok: { type: "boolean" } } },
          404: { type: "object", properties: { error: { type: "string" } } },
          409: { type: "object", properties: { error: { type: "string" } } },
        },
      },
    }, async (request, reply) => {
    const userId = request.user!.userId;
    const { id } = request.params as { id: string };
    if ((await signingModeOf(userId)) === "delegated") {
      return reply.status(409).send({ error: "Delegated signing uses this copy. Switch to self-custody first." });
    }
    const [wallet] = await db
      .update(schema.userWallets)
      .set({ encryptedSecret: null })
      .where(and(eq(schema.userWallets.id, parseInt(id)), eq(schema.userWallets.userId, userId), eq(schema.userWallets.chain, "stellar"), eq(schema.userWallets.network, config.STELLAR_NETWORK)))
      .returning({ id: schema.userWallets.id });
    if (!wallet) return reply.status(404).send({ error: "Wallet not found" });
    return { ok: true };
  });

  // ──────────────────────────────────────────
  // DELETE WALLET
  // ──────────────────────────────────────────
  app.delete("/api/v1/wallets/:id", {
      preHandler: authMiddleware,
      schema: {
        description: "Delete a wallet. If it was active, another wallet is auto-activated.",
        tags: ["Wallets"],
        security: [{ bearerAuth: [] }],
        params: {
          type: "object",
          properties: {
            id: { type: "string", pattern: "^\\d+$", description: "Wallet ID" },
          },
        },
        response: {
          200: { type: "object", properties: { ok: { type: "boolean" } } },
          404: { type: "object", properties: { error: { type: "string" } } },
        },
      },
    }, async (request, reply) => {
    const userId = request.user!.userId;
    const { id } = request.params as { id: string };

    const result = await db.transaction(async (tx) => {
      await tx.execute(sql`SELECT id FROM users WHERE id = ${userId} FOR NO KEY UPDATE`);
      const [deleted] = await tx
        .delete(schema.userWallets)
        .where(
          and(
            eq(schema.userWallets.id, parseInt(id)),
            and(eq(schema.userWallets.userId, userId), eq(schema.userWallets.chain, "stellar"), eq(schema.userWallets.network, config.STELLAR_NETWORK))
          )
        )
        .returning();

      if (!deleted) return null;

      // If we deleted the active wallet, activate another one
      const remaining = await tx
        .select()
        .from(schema.userWallets)
        .where(and(eq(schema.userWallets.userId, userId), eq(schema.userWallets.chain, "stellar"), eq(schema.userWallets.network, config.STELLAR_NETWORK)))
        .limit(1);

      if (deleted.isActive && remaining.length > 0) {
        await tx
          .update(schema.userWallets)
          .set({ isActive: true })
          .where(eq(schema.userWallets.id, remaining[0].id));
      }

      return deleted;
    });

    if (!result) {
      return reply.status(404).send({ error: "Wallet not found" });
    }

    return { ok: true };
  });

  // ──────────────────────────────────────────
  // WALLET FUNDING NOTICE
  // ──────────────────────────────────────────
  // Returns whether the authenticated user has ever had a wallet activation billing event.
  // The frontend uses this (+ localStorage dismiss flag) to show a one-time funding notice.
  app.get("/api/v1/wallet/funding-notice", {
    preHandler: authMiddleware,
    schema: {
      description: "Check if user has a wallet activation billing event (for first-time funding notice).",
      tags: ["Wallets"],
      security: [{ bearerAuth: [] }],
      response: {
        200: {
          type: "object",
          properties: {
            hasFundingEvent: { type: "boolean" },
            activeWalletPublicKey: { type: "string", nullable: true },
          },
        },
      },
    },
  }, async (request) => {
    const userId = request.user!.userId;

    const [fundingRow] = await db
      .select({ id: schema.billingEvents.id })
      .from(schema.billingEvents)
      .where(
        and(
          eq(schema.billingEvents.userId, userId),
          eq(schema.billingEvents.eventType, "new_wallet_activation")
        )
      )
      .limit(1);

    const [activeWallet] = await db
      .select({ publicKey: schema.userWallets.publicKey })
      .from(schema.userWallets)
      .where(
        and(
          and(eq(schema.userWallets.userId, userId), eq(schema.userWallets.chain, "stellar"), eq(schema.userWallets.network, config.STELLAR_NETWORK)),
          eq(schema.userWallets.isActive, true)
        )
      )
      .limit(1);

    return {
      hasFundingEvent: !!fundingRow,
      activeWalletPublicKey: activeWallet?.publicKey ?? null,
    };
  });
}
