import { cleanupEmptyTrustlines, liquifyPlatformFees } from "./liquifier";

/**
 * Owner switch for the platform-fee liquifier (real DEX swaps from the platform wallet; mainnet when STELLAR_NETWORK
 * is not testnet). Off unless PLATFORM_LIQUIFIER_ENABLED is on/true/1, so deploying this code changes nothing.
 * It guards both the 6-hourly tick and POST /api/v1/admin/liquify.
 */
type Env = Record<string, string | undefined>;
const ON = new Set(["on", "true", "1"]);
export const liquifierEnabled = (env: Env = process.env): boolean => ON.has(env.PLATFORM_LIQUIFIER_ENABLED ?? "");
export const LIQUIFIER_OFF_MESSAGE = "liquifier is switched off";

export interface LiquifierDeps {
  enabled: () => boolean;
  liquify: typeof liquifyPlatformFees;
  cleanup: typeof cleanupEmptyTrustlines;
  log: { info: (...a: unknown[]) => void; error: (...a: unknown[]) => void };
}

const defaults = (): LiquifierDeps => ({
  enabled: () => liquifierEnabled(),
  liquify: liquifyPlatformFees,
  cleanup: cleanupEmptyTrustlines,
  log: { info: (...a) => console.log(...a), error: (...a) => console.error(...a) },
});

const convertedAssets = (r: Awaited<ReturnType<typeof liquifyPlatformFees>>) => r.converted.map((c) => ({ code: c.code, issuer: c.issuer }));

/** One scheduled run: same steps as the old inline interval body, behind the switch. Never throws; logs only err.message. */
export async function liquifierTick(deps: LiquifierDeps = defaults()): Promise<void> {
  if (!deps.enabled()) return;
  try {
    deps.log.info("[liquifier] Scheduled run starting...");
    const result = await deps.liquify();
    if (result.converted.length > 0) {
      deps.log.info(`[liquifier] Converted ${result.converted.length} asset(s)`);
      await deps.cleanup(convertedAssets(result));
    } else {
      deps.log.info("[liquifier] No assets to convert");
    }
  } catch (err: any) {
    deps.log.error("[liquifier] Scheduled run failed:", err?.message);
  }
}

/**
 * The admin route body after its admin check: 503 when switched off; otherwise liquify, then remove the emptied trustlines
 * of the converted assets (none when nothing converted). A throw becomes 500 with the message only.
 */
export async function adminLiquify(
  userId: number,
  deps: LiquifierDeps = defaults(),
): Promise<
  | { status: 503 | 500; body: { error: string } }
  | { status: 200; body: Awaited<ReturnType<typeof liquifyPlatformFees>> & { cleanedTrustlines: string[] } }
> {
  if (!deps.enabled()) {
    deps.log.info("[admin] Liquifier refused: switched off (user", userId, ")");
    return { status: 503, body: { error: LIQUIFIER_OFF_MESSAGE } };
  }
  deps.log.info("[admin] Liquifier triggered by user", userId);
  try {
    const result = await deps.liquify();
    const cleanedTrustlines = result.converted.length > 0 ? await deps.cleanup(convertedAssets(result)) : [];
    return { status: 200, body: { ...result, cleanedTrustlines } };
  } catch (err: any) {
    deps.log.error("[admin] Liquifier failed:", err?.message);
    return { status: 500, body: { error: String(err?.message ?? "liquifier failed") } };
  }
}
