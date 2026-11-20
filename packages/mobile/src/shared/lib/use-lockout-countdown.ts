import { useCallback, useEffect, useState } from "react";
import { remainingMs } from "./lockout";

/**
 * Counts down a wrong-passphrase lockout. `read` returns the milliseconds still to wait (the stored lockout,
 * so the count is right after the app is closed and reopened). Call `refresh` on mount and after a failed try.
 */
export function useLockoutCountdown(read: () => Promise<number>): { remaining: number; refresh: () => Promise<void> } {
  const [lockedUntil, setLockedUntil] = useState(0);
  const [now, setNow] = useState(() => Date.now());

  const refresh = useCallback(async () => {
    const wait = await read();
    setNow(Date.now());
    setLockedUntil(wait > 0 ? Date.now() + wait : 0);
  }, [read]);

  useEffect(() => {
    if (lockedUntil <= Date.now()) return;
    const timer = setInterval(() => {
      setNow(Date.now());
    }, 500);
    return () => clearInterval(timer);
  }, [lockedUntil]);

  return { remaining: remainingMs(lockedUntil, now), refresh };
}
