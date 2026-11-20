export type UnlockProgressStage = "working" | "slow" | "slower";

/**
 * Which message the lock screen shows while the passphrase is being checked.
 * Fast phones finish before the first threshold and never see the extra text.
 */
export function unlockProgressStage(elapsedMs: number): UnlockProgressStage {
  if (elapsedMs >= 15_000) return "slower";
  if (elapsedMs >= 2_000) return "slow";
  return "working";
}
