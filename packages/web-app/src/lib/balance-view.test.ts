import { describe, expect, it } from "vitest";
import { balanceView } from "./balance-view";

const funded = [{ balance: "10" }];

describe("balanceView", () => {
  it("is loading while the first load is running", () => {
    expect(balanceView({ isLoading: true, isError: false, data: undefined })).toEqual({ state: "loading", stale: false });
  });
  it("is an error, never an empty wallet, when the load failed and nothing was loaded before", () => {
    expect(balanceView({ isLoading: false, isError: true, data: undefined })).toEqual({ state: "error", stale: false });
    expect(balanceView({ isLoading: false, isError: true, data: [] })).toEqual({ state: "error", stale: false });
  });
  it("keeps showing the last known balances, marked stale, when a refresh fails", () => {
    expect(balanceView({ isLoading: false, isError: true, data: funded })).toEqual({ state: "ready", stale: true });
  });
  it("is unfunded only when the load worked and the account has nothing", () => {
    expect(balanceView({ isLoading: false, isError: false, data: [] })).toEqual({ state: "unfunded", stale: false });
  });
  it("is ready with balances", () => {
    expect(balanceView({ isLoading: false, isError: false, data: funded })).toEqual({ state: "ready", stale: false });
  });
});
