/** Milliseconds left until `lockedUntil` (a Date.now() style time); 0 when it has passed or there is none. */
export function remainingMs(lockedUntil: number, now: number): number {
  return Math.max(0, lockedUntil - now);
}

/** "4:32", or "1:00:00" for an hour. A part-second counts as a whole one, so it never reads 0:00 while locked. */
export function formatCountdown(ms: number): string {
  const total = Number.isFinite(ms) && ms > 0 ? Math.ceil(ms / 1000) : 0;
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const ss = String(s).padStart(2, "0");
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${ss}` : `${m}:${ss}`;
}
