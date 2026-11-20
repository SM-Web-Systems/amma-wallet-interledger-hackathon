import { useEffect, useState } from "react";
import { unlockProgressStage, type UnlockProgressStage } from "./unlock-progress";

/**
 * While `busy` (a slow passphrase step is running), tracks how long it has taken and returns the
 * message stage to show. Resets when the step ends.
 */
export function useUnlockStage(busy: boolean): UnlockProgressStage {
  const [elapsedMs, setElapsedMs] = useState(0);
  useEffect(() => {
    if (!busy) {
      setElapsedMs(0);
      return;
    }
    const started = Date.now();
    const timer = setInterval(() => setElapsedMs(Date.now() - started), 500);
    return () => clearInterval(timer);
  }, [busy]);
  return unlockProgressStage(elapsedMs);
}
