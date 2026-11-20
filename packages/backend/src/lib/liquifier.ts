import * as StellarSdk from "@stellar/stellar-sdk";
import { config } from "../config";
import { stellarClient } from "./stellar-client";
import { parseTokenCaps } from "./custody-limits";

// Only issued tokens. Liquidity-pool shares have no code or issuer and used to stop the whole run.
const isToken = (b: any) => b.asset_type === "credit_alphanum4" || b.asset_type === "credit_alphanum12";

type Env = Record<string, string | undefined>;

/** Stellar amount string ("12.3456789") to stroops, without float rounding. */
const toStroops = (s: string | undefined): bigint => {
  const [whole, frac = ""] = (s || "0").split(".");
  return BigInt(whole || "0") * 10_000_000n + BigInt((frac + "0000000").slice(0, 7));
};
const fromStroops = (n: bigint): string => `${n / 10_000_000n}.${(n % 10_000_000n).toString().padStart(7, "0")}`;

/** PLATFORM_LIQUIFIER_ASSETS: optional comma-separated CODE:ISSUER list. Unset or empty = every token (old behaviour). */
const assetAllowlist = (env: Env): Set<string> | null => {
  const list = (env.PLATFORM_LIQUIFIER_ASSETS ?? "").split(",").map((e) => e.trim()).filter(Boolean);
  return list.length ? new Set(list) : null;
};

interface LiquifyResult {
  asset: string;
  code: string;
  issuer: string;
  amount: string;
  xlmReceived: string;
  txHash: string;
}

/**
 * Auto-liquifier: converts all non-XLM balances in the platform wallet to XLM
 * using Stellar DEX path payments (strict send).
 */
export async function liquifyPlatformFees(env: Env = process.env): Promise<{
  converted: LiquifyResult[];
  skipped: string[];
  errors: string[];
}> {
  const converted: LiquifyResult[] = [];
  const skipped: string[] = [];
  const errors: string[] = [];

  const platformKey = config.PLATFORM_WALLET;
  const platformSecret = config.PLATFORM_SECRET;

  if (!platformKey || !platformSecret) {
    errors.push("Platform wallet not configured");
    return { converted, skipped, errors };
  }

  try {
    const allow = assetAllowlist(env);
    const account = await stellarClient.horizon.loadAccount(platformKey);
    const nonXlmBalances = account.balances.filter(
      (b: any) => isToken(b) && parseFloat(b.balance) > 0.0000001
    );

    if (nonXlmBalances.length === 0) {
      return { converted, skipped: ["No non-XLM balances to convert"], errors };
    }

    console.log(`[liquifier] Found ${nonXlmBalances.length} non-XLM balance(s) to convert`);

    for (const bal of nonXlmBalances) {
      const assetCode = (bal as any).asset_code;
      const assetIssuer = (bal as any).asset_issuer;
      const assetLabel = `${assetCode}:${assetIssuer.slice(0, 8)}...`;

      if (allow && !allow.has(`${assetCode}:${assetIssuer}`)) {
        skipped.push(`${assetLabel} (not in PLATFORM_LIQUIFIER_ASSETS)`);
        continue;
      }

      // Only the free part: tokens locked in the platform's own open offers cannot be sent.
      const free = toStroops((bal as any).balance) - toStroops((bal as any).selling_liabilities);
      if (free <= 0n) {
        skipped.push(`${assetLabel} (nothing free: balance is in open offers)`);
        continue;
      }
      const amount = fromStroops(free);

      // Skip dust amounts (less than 0.001)
      if (parseFloat(amount) < 0.001) {
        skipped.push(`${assetLabel} (dust: ${amount})`);
        continue;
      }

      try {
        // Find a DEX path from this asset to XLM
        const asset = new StellarSdk.Asset(assetCode, assetIssuer);
        const xlmAsset = StellarSdk.Asset.native();

        // Use strict send path payment — send all of the token, receive whatever XLM we get
        const paths = await stellarClient.horizon
          .strictSendPaths(asset, amount, [xlmAsset])
          .call();

        if (!paths.records || paths.records.length === 0) {
          skipped.push(`${assetLabel} (no DEX path to XLM)`);
          continue;
        }

        // Pick the best path (highest destination amount)
        const bestPath = paths.records.reduce((best: any, curr: any) =>
          parseFloat(curr.destination_amount) > parseFloat(best.destination_amount) ? curr : best
        );

        const destMin = (parseFloat(bestPath.destination_amount) * 0.98).toFixed(7); // 2% slippage
        const pathAssets = (bestPath.path || []).map((p: any) => {
          if (p.asset_type === "native") return StellarSdk.Asset.native();
          return new StellarSdk.Asset(p.asset_code, p.asset_issuer);
        });

        // Build and submit the swap transaction
        const freshAccount = await stellarClient.horizon.loadAccount(platformKey);
        const tx = new StellarSdk.TransactionBuilder(freshAccount, {
          fee: StellarSdk.BASE_FEE,
          networkPassphrase: stellarClient.networkPassphrase,
        })
          .addOperation(
            StellarSdk.Operation.pathPaymentStrictSend({
              sendAsset: asset,
              sendAmount: amount,
              destination: platformKey, // send to self
              destAsset: xlmAsset,
              destMin,
              path: pathAssets,
            })
          )
          .setTimeout(180)
          .build();

        const keypair = StellarSdk.Keypair.fromSecret(platformSecret);
        tx.sign(keypair);

        const result = await stellarClient.horizon.submitTransaction(tx);
        const txHash = (result as any).hash || "unknown";

        converted.push({
          asset: assetLabel,
          code: assetCode,
          issuer: assetIssuer,
          amount,
          xlmReceived: bestPath.destination_amount,
          txHash,
        });

        console.log(`[liquifier] ✅ Converted ${amount} ${assetCode} → ~${bestPath.destination_amount} XLM (tx: ${txHash.slice(0, 12)}...)`);
      } catch (swapErr: any) {
        const errMsg = swapErr?.response?.data?.extras?.result_codes
          ? JSON.stringify(swapErr.response.data.extras.result_codes)
          : swapErr.message;
        errors.push(`${assetLabel}: ${errMsg}`);
        console.error(`[liquifier] ❌ Failed to convert ${assetLabel}:`, errMsg);
      }
    }
  } catch (err: any) {
    errors.push(`Account load failed: ${err.message}`);
  }

  return { converted, skipped, errors };
}

/**
 * Remove the empty trustlines of the assets this run converted (to free reserves). Other empty trustlines stay:
 * the platform may need them to receive swap fees.
 */
/**
 * Trustlines the cleanup must never remove: the platform fee (PR #261) is paid into them. Without the trustline, sends in that
 * asset pay the XLM fallback instead. PLATFORM_LIQUIFIER_KEEP_ASSETS (comma-separated CODE:ISSUER) plus the custody
 * allow-listed tokens (CUSTODY_MAINNET_TOKEN_CAPS, default USDC). null when either list is malformed: then nothing is removed.
 */
export function liquifierKeepAssets(env: Env = process.env): Set<string> | null {
  try {
    const keep = new Set<string>([...parseTokenCaps(env).keys()]);
    for (const entry of (env.PLATFORM_LIQUIFIER_KEEP_ASSETS ?? "").split(",").map((e) => e.trim()).filter(Boolean)) {
      const [code, issuer, extra] = entry.split(":");
      if (extra !== undefined || !/^[A-Za-z0-9]{1,12}$/.test(code ?? "") || !StellarSdk.StrKey.isValidEd25519PublicKey(issuer ?? "")) return null;
      keep.add(`${code}:${issuer}`);
    }
    return keep;
  } catch {
    return null;
  }
}

export async function cleanupEmptyTrustlines(convertedAssets: { code: string; issuer: string }[], env: Env = process.env): Promise<string[]> {
  const removed: string[] = [];
  const platformKey = config.PLATFORM_WALLET;
  const platformSecret = config.PLATFORM_SECRET;

  if (!platformKey || !platformSecret || convertedAssets.length === 0) return removed;
  const keep = liquifierKeepAssets(env);
  if (!keep) {
    console.warn("[liquifier] PLATFORM_LIQUIFIER_KEEP_ASSETS or CUSTODY_MAINNET_TOKEN_CAPS is malformed: no trustline removed");
    return removed;
  }
  const converted = new Set(convertedAssets.map((a) => `${a.code}:${a.issuer}`).filter((k) => !keep.has(k)));

  try {
    const account = await stellarClient.horizon.loadAccount(platformKey);
    const emptyTrustlines = account.balances.filter(
      (b: any) => isToken(b) && parseFloat(b.balance) === 0 && converted.has(`${b.asset_code}:${b.asset_issuer}`)
    );

    for (const bal of emptyTrustlines) {
      try {
        const asset = new StellarSdk.Asset((bal as any).asset_code, (bal as any).asset_issuer);
        const freshAccount = await stellarClient.horizon.loadAccount(platformKey);
        const tx = new StellarSdk.TransactionBuilder(freshAccount, {
          fee: StellarSdk.BASE_FEE,
          networkPassphrase: stellarClient.networkPassphrase,
        })
          .addOperation(StellarSdk.Operation.changeTrust({ asset, limit: "0" }))
          .setTimeout(180)
          .build();

        const keypair = StellarSdk.Keypair.fromSecret(platformSecret);
        tx.sign(keypair);
        await stellarClient.horizon.submitTransaction(tx);
        removed.push(`${(bal as any).asset_code}`);
        console.log(`[liquifier] 🧹 Removed empty trustline: ${(bal as any).asset_code}`);
      } catch (e: any) {
        console.warn(`[liquifier] Failed to remove trustline ${(bal as any).asset_code}:`, e.message);
      }
    }
  } catch {}

  return removed;
}
