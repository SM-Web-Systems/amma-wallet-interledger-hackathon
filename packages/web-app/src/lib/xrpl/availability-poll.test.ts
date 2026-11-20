import { afterEach, describe, expect, it, vi } from "vitest";
import { pollAvailability } from "./availability-poll";

afterEach(() => vi.useRealTimers());

describe("pollAvailability", () => {
  it("rechecks until submission is available, then stops", async () => {
    vi.useFakeTimers();
    const results = [{ available: false }, { available: false }, { available: true }];
    const check = vi.fn(async () => results.shift()!);
    const onResult = vi.fn();
    const stop = pollAvailability(check, onResult, 30000);
    await vi.advanceTimersByTimeAsync(30000);
    await vi.advanceTimersByTimeAsync(30000);
    await vi.advanceTimersByTimeAsync(30000);
    await vi.advanceTimersByTimeAsync(90000);
    expect(check).toHaveBeenCalledTimes(3);
    expect(onResult.mock.calls.map(([available]) => available)).toEqual([false, false, true]);
    stop();
  });

  it("treats a failed check as unavailable and keeps polling", async () => {
    vi.useFakeTimers();
    const check = vi.fn().mockRejectedValueOnce(new Error("offline")).mockResolvedValue({ available: true });
    const onResult = vi.fn();
    const stop = pollAvailability(check, onResult, 30000);
    await vi.advanceTimersByTimeAsync(60000);
    expect(onResult.mock.calls.map(([available]) => available)).toEqual([false, true]);
    stop();
  });

  it("does nothing after stop", async () => {
    vi.useFakeTimers();
    const check = vi.fn(async () => ({ available: true }));
    const stop = pollAvailability(check, vi.fn(), 30000);
    stop();
    await vi.advanceTimersByTimeAsync(60000);
    expect(check).not.toHaveBeenCalled();
  });
});
