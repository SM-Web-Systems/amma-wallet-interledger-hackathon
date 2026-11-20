import { StrKey } from "@stellar/stellar-sdk";
import { mainnetCustodyOn } from "./custody-networks";

/**
 * Task-gated wallet activation flags (phase 1: Stellar only). Off unless TASK_ACTIVATION is on.
 * Mainnet follows the custody pattern: it needs MAINNET_CUSTODY=on on the public network AND its own TASK_ACTIVATION_MAINNET=on,
 * otherwise start-up throws. Messages never contain a secret.
 */
type Env = Record<string, string | undefined>;

export interface ActivationFlags {
  enabled: boolean;
  mainnet: boolean;
  /** Stellar network the grants go to. */
  network: "testnet" | "public";
  chains: readonly "stellar"[];
  stellarGrantStroops: bigint;
  /** Circuit breaker: activations started per rolling 24 h on this chain, all partners together. */
  globalDailyCap: number;
  /** Activations per user per rolling 24 h across all partners. */
  userDailyCap: number;
  /** Optional operator pause file ({"paused":true}); see worker. */
  controlFile?: string;
  /**
   * BUSINESS_CREDITS=on: a tenant-paid activation draws one prepaid credit (yearly first, then monthly) and 1.1 XLM from the
   * business's funding pot (credits-v1) instead of debiting grant + platform fee from prepaid_xlm_balance. Off by default.
   */
  businessCredits?: boolean;
  /**
   * BUSINESS_WALLETS=on (testnet only for now): a credit-paid activation is funded from that business's own Amma-held wallet
   * (business-wallets-v1) instead of the shared treasury. Needs BUSINESS_CREDITS=on and KEY_WRAP_PROVIDER.
   */
  businessWallets?: boolean;
  /**
   * BUSINESS_DEPOSITS=on (testnet only for now): watch each business wallet, credit deposits that match a bundle price and hold
   * the rest, emailing BUSINESS_ESCALATION_EMAIL (business-deposits-v1). Needs BUSINESS_WALLETS=on.
   */
  businessDeposits?: boolean;
  escalationEmail?: string;
  /**
   * BUSINESS_FEE_SWEEPS=on (testnet only for now): pay each credited deposit's fee share and each monthly management charge from
   * the business wallet to its hardware fee address (fee-sweeps-v1). Needs BUSINESS_DEPOSITS=on.
   */
  businessFeeSweeps?: boolean;
  /**
   * BUSINESS_CONTROLS=on (testnet only for now): the daily balance floor check (warn, 7-day grace, then stop new activations),
   * the business's pause button and editable daily cap, and their alerts (business-controls-v1). Needs BUSINESS_CREDITS=on and
   * BUSINESS_ESCALATION_EMAIL (the owner's copy of every alert).
   */
  businessControls?: boolean;
}

export const GRANT_STROOPS_DEFAULT = 11_000_000n; // 1 XLM reserve + 0.1 XLM buffer
export const GRANT_STROOPS_MAX = 20_000_000n;
const ON = new Set(["on", "true", "1"]);

/** The one parser for the master switch. Shared with the schema gate. */
export const activationOn = (env: Env): boolean => ON.has(env.TASK_ACTIVATION ?? "");

const wholeNumber = (name: string, raw: string | undefined, fallback: number): number => {
  if (raw === undefined || raw === "") return fallback;
  if (!/^\d{1,9}$/.test(raw)) throw new Error(`${name} must be a whole number.`);
  return Number(raw);
};

export const TREASURY_ENV = "TASK_ACTIVATION_STELLAR_TREASURY_SECRET";

/** The raw treasury secret. Only the Stellar rail may call this; never log or return the value. */
export const treasurySecretFromEnv = (env: Env): string => env[TREASURY_ENV] ?? "";

export function activationFlagsFromEnv(env: Env = process.env): ActivationFlags {
  if (!activationOn(env)) return { enabled: false, mainnet: false, network: "testnet", chains: ["stellar"], stellarGrantStroops: GRANT_STROOPS_DEFAULT, globalDailyCap: 0, userDailyCap: 3 };

  const wantsMainnet = env.STELLAR_NETWORK === "public" || env.MAINNET_CUSTODY === "on";
  if (wantsMainnet && !mainnetCustodyOn(env)) throw new Error("Task activation on mainnet needs MAINNET_CUSTODY=on together with STELLAR_NETWORK=public; it is refused otherwise.");
  if (wantsMainnet && env.TASK_ACTIVATION_MAINNET !== "on") throw new Error("Task activation on mainnet needs TASK_ACTIVATION_MAINNET=on as well; it is off by default.");
  if (!wantsMainnet && env.TASK_ACTIVATION_MAINNET !== undefined && env.TASK_ACTIVATION_MAINNET !== "") throw new Error("TASK_ACTIVATION_MAINNET is only meaningful with mainnet custody and is refused on testnet.");

  const chains = (env.TASK_ACTIVATION_CHAINS || "stellar").split(",").map((c) => c.trim());
  if (chains.length !== 1 || chains[0] !== "stellar") throw new Error("TASK_ACTIVATION_CHAINS supports only stellar in this release.");

  const rawGrant = env.ACTIVATION_STELLAR_GRANT_STROOPS;
  let stellarGrantStroops = GRANT_STROOPS_DEFAULT;
  if (rawGrant !== undefined && rawGrant !== "") {
    if (!/^\d{1,12}$/.test(rawGrant) || BigInt(rawGrant) <= 0n || BigInt(rawGrant) > GRANT_STROOPS_MAX) throw new Error("ACTIVATION_STELLAR_GRANT_STROOPS must be a whole number above 0 and at most 20000000 (2 XLM).");
    stellarGrantStroops = BigInt(rawGrant);
  }
  const globalDailyCap = wholeNumber("ACTIVATION_DAILY_CAP_STELLAR", env.ACTIVATION_DAILY_CAP_STELLAR, wantsMainnet ? 100 : 1000);
  const userDailyCap = wholeNumber("ACTIVATION_USER_DAILY_CAP", env.ACTIVATION_USER_DAILY_CAP, 3);

  const secret = treasurySecretFromEnv(env);
  if (!secret || !StrKey.isValidEd25519SecretSeed(secret)) throw new Error(`${TREASURY_ENV} is missing or is not a valid Stellar secret key.`);

  const businessCredits = env.BUSINESS_CREDITS === "on";
  const businessWallets = env.BUSINESS_WALLETS === "on";
  if (businessWallets && !businessCredits) throw new Error("BUSINESS_WALLETS=on needs BUSINESS_CREDITS=on as well.");
  if (businessWallets && !env.KEY_WRAP_PROVIDER) throw new Error("BUSINESS_WALLETS=on needs KEY_WRAP_PROVIDER to seal the business wallet keys.");
  if (businessWallets && wantsMainnet) throw new Error("BUSINESS_WALLETS is testnet only in this release; mainnet needs the owner's go and its own release.");
  const businessDeposits = env.BUSINESS_DEPOSITS === "on";
  const escalationEmail = (env.BUSINESS_ESCALATION_EMAIL ?? "").trim();
  if (businessDeposits && !businessWallets) throw new Error("BUSINESS_DEPOSITS=on needs BUSINESS_WALLETS=on as well.");
  const businessFeeSweeps = env.BUSINESS_FEE_SWEEPS === "on";
  if (businessFeeSweeps && !businessDeposits) throw new Error("BUSINESS_FEE_SWEEPS=on needs BUSINESS_DEPOSITS=on as well.");
  if (businessDeposits && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(escalationEmail)) throw new Error("BUSINESS_DEPOSITS=on needs BUSINESS_ESCALATION_EMAIL, the address odd deposits are escalated to.");
  const businessControls = env.BUSINESS_CONTROLS === "on";
  if (businessControls && !businessCredits) throw new Error("BUSINESS_CONTROLS=on needs BUSINESS_CREDITS=on as well.");
  if (businessControls && wantsMainnet) throw new Error("BUSINESS_CONTROLS is testnet only in this release; mainnet needs the owner's go and its own release.");
  if (businessControls && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(escalationEmail)) throw new Error("BUSINESS_CONTROLS=on needs BUSINESS_ESCALATION_EMAIL, the owner's copy of every floor and pause alert.");

  return {
    enabled: true, mainnet: wantsMainnet, network: wantsMainnet ? "public" : "testnet", chains: ["stellar"],
    stellarGrantStroops, globalDailyCap, userDailyCap, controlFile: env.TASK_ACTIVATION_CONTROL_FILE || undefined,
    businessCredits, businessWallets,
    ...(businessDeposits ? { businessDeposits, escalationEmail } : {}),
    ...(businessFeeSweeps ? { businessFeeSweeps } : {}),
    ...(businessControls ? { businessControls, escalationEmail } : {}),
  };
}
