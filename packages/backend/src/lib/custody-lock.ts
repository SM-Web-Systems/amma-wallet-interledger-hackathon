/** One custody send at a time per user in this process, so two parallel sends cannot both pass the daily-limit check. */
const chains = new Map<number, Promise<unknown>>();
export async function oneAtATime<T>(userId: number, work: () => Promise<T>): Promise<T> {
  const prev = chains.get(userId) ?? Promise.resolve();
  const run = prev.catch(() => undefined).then(work);
  chains.set(userId, run);
  try { return await run; } finally { if (chains.get(userId) === run) chains.delete(userId); }
}
