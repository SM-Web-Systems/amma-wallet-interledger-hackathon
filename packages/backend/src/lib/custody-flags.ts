import { assertXrplNetworkConfig, mainnetCustodyOn, xrplMainnetCustodyOn } from "./custody-networks";
import { appLog } from "./app-log";

/**
 * Stage 0 custody flags. Everything is off unless switched on. Testnet only, unless MAINNET_CUSTODY=on on a server whose STELLAR_NETWORK is "public"
 * (then server signing may run on mainnet with a local master key; welcome funding never may).
 */
export interface CustodyFlags { serverSigning: boolean; welcomeFunding: boolean; sepoliaWei: bigint; dailyCap: number; /** Set only in mainnet custody mode. */ mainnet?: boolean; /** Mainnet only: the user ids that may use Amma custody (CUSTODY_MAINNET_USER_IDS). Missing or empty means nobody. */ mainnetUserIds?: ReadonlySet<number>; /** Mainnet only: XRP for Amma-held wallets is switched on (XRPL_MAINNET_CUSTODY=on). */ xrplMainnet?: boolean }

const MAX_SEPOLIA_WEI = 100000000000000000n;
type Env = Record<string, string | undefined>;
/** The one parser for custody flags: "true" or "1". Shared with the schema gate. */
export const flagOn = (v: string | undefined): boolean => v === "true" || v === "1";
const isOn = flagOn;

/** Parses CUSTODY_MAINNET_USER_IDS: comma-separated positive integers. Unset or blank is an empty set; anything malformed throws. */
export function parseMainnetUserIds(raw: string | undefined): ReadonlySet<number> {
  const out = new Set<number>();
  if (raw === undefined || raw.trim() === "") return out;
  for (const item of raw.split(",")) {
    const t = item.trim();
    if (!/^\d+$/.test(t) || !Number.isSafeInteger(Number(t)) || Number(t) <= 0) throw new Error("CUSTODY_MAINNET_USER_IDS must be comma-separated positive whole numbers, for example 13,366,367 (no empty items).");
    out.add(Number(t));
  }
  return out;
}

export const CUSTODY_NOT_AVAILABLE = "Amma-held wallets aren't available for this account on mainnet yet.";

/**
 * The one allow-list check. Testnet: everyone. Mainnet custody mode: only the listed user ids; a missing list refuses everyone (fail closed).
 * Call it before any password check, escrow open, key derivation or database write.
 */
export const custodyAllowedForUser = (flags: Pick<CustodyFlags, "mainnet" | "mainnetUserIds">, userId: number): boolean =>
  flags.mainnet !== true || flags.mainnetUserIds?.has(userId) === true;

export function custodyFlagsFromEnv(env: Env = process.env): CustodyFlags {
  const serverSigning = isOn(env.CUSTODY_SERVER_SIGNING);
  const welcomeFunding = isOn(env.WELCOME_FUNDING);
  const network = env.STELLAR_NETWORK ?? "testnet";
  if (env.MAINNET_CUSTODY === "on" && network !== "public") throw new Error("MAINNET_CUSTODY=on needs STELLAR_NETWORK=public; it is refused on any other network.");
  assertXrplNetworkConfig(env);
  const mainnet = mainnetCustodyOn(env);
  if (mainnet && welcomeFunding) throw new Error("Welcome funding is never allowed on mainnet, even with MAINNET_CUSTODY=on.");
  if ((serverSigning || welcomeFunding) && network !== "testnet" && !mainnet) {
    throw new Error("Server signing and welcome funding are for testnet only and are refused on any other network.");
  }
  let sepoliaWei: bigint;
  try { sepoliaWei = BigInt(env.WELCOME_SEPOLIA_WEI || "10000000000000000"); } catch { throw new Error("WELCOME_SEPOLIA_WEI must be a whole number."); }
  if (sepoliaWei <= 0n || sepoliaWei > MAX_SEPOLIA_WEI) throw new Error("WELCOME_SEPOLIA_WEI must be more than 0 and at most 0.1 ETH (100000000000000000 wei).");
  const dailyCap = env.WELCOME_DAILY_CAP ? Number(env.WELCOME_DAILY_CAP) : 50;
  if (!Number.isInteger(dailyCap) || dailyCap < 0) throw new Error("WELCOME_DAILY_CAP must be a whole number.");
  // Parsed only on mainnet: on testnet the variable is ignored, even when malformed.
  return mainnet ? { serverSigning, welcomeFunding, sepoliaWei, dailyCap, mainnet: true, mainnetUserIds: parseMainnetUserIds(env.CUSTODY_MAINNET_USER_IDS), ...(xrplMainnetCustodyOn(env) ? { xrplMainnet: true } : {}) } : { serverSigning, welcomeFunding, sepoliaWei, dailyCap };
}

export const MAINNET_CUSTODY_WARNING = "MAINNET CUSTODY ON with a local master key — test balances only";

/** One loud line at start-up when custody runs on mainnet. */
export function warnIfMainnetCustody(flags: CustodyFlags): void {
  if (flags.mainnet) appLog().warn({ mainnet: true }, MAINNET_CUSTODY_WARNING);
  if (flags.mainnet && flags.xrplMainnet) appLog().warn({ mainnet: true, chain: "xrpl" }, "XRP for Amma-held wallets is ON on mainnet (XRPL_MAINNET_CUSTODY=on) — test balances only");
  if (flags.mainnet && !flags.mainnetUserIds?.size) appLog().warn({ mainnet: true }, "Mainnet custody is on but CUSTODY_MAINNET_USER_IDS lists no users, so no account may use Amma-held wallets.");
}
