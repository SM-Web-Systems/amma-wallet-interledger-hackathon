// While payment submission is unavailable (paused by the operator, or a failed
// check), recheck on an interval so the UI unlocks without a manual reload.
export function pollAvailability(
  check: () => Promise<{ available: boolean }>,
  onResult: (available: boolean) => void,
  intervalMs: number,
): () => void {
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const schedule = () => { timer = setTimeout(tick, intervalMs); };
  async function tick() {
    let available = false;
    try { available = (await check()).available; } catch { available = false; }
    if (stopped) return;
    onResult(available);
    if (!available) schedule();
  }
  schedule();
  return () => { stopped = true; if (timer) clearTimeout(timer); };
}
