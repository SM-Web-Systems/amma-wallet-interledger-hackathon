import { describe, expect, it } from "vitest";
import { quickTabsFor } from "./quick-tabs";

const targets = (path: string) =>
  quickTabsFor(path).map((tab) => `${tab.key}:${tab.to.pathname}${tab.to.hash ? `#${tab.to.hash}` : ""}`);

describe("quickTabsFor: phone tab bar follows the chain on screen", () => {
  it("keeps the Stellar tabs on Stellar pages", () => {
    for (const path of ["/dashboard", "/send", "/tokens", "/history"]) {
      expect(targets(path)).toEqual(["home:/dashboard", "send:/send", "receive:/receive", "swap:/swap"]);
    }
  });

  it("points Send and Receive at XRP on /xrpl", () => {
    expect(targets("/xrpl")).toEqual(["home:/xrpl", "send:/xrpl#send", "receive:/xrpl#receive", "stellar:/dashboard"]);
  });

  it("points Send and Receive at Ethereum on /ethereum-sepolia", () => {
    expect(targets("/ethereum-sepolia")).toEqual([
      "home:/ethereum-sepolia",
      "send:/ethereum-sepolia#send",
      "receive:/ethereum-sepolia#receive",
      "stellar:/dashboard",
    ]);
  });

  it("matches nested and trailing-slash chain paths", () => {
    expect(quickTabsFor("/xrpl/").map((t) => t.to.pathname)[1]).toBe("/xrpl");
  });

  it("marks the chain tab active only for the matching hash", () => {
    const tabs = quickTabsFor("/xrpl");
    expect(tabs.map((t) => t.isActive("/xrpl", ""))).toEqual([true, false, false, false]);
    expect(tabs.map((t) => t.isActive("/xrpl", "#send"))).toEqual([false, true, false, false]);
    expect(tabs.map((t) => t.isActive("/xrpl", "#receive"))).toEqual([false, false, true, false]);
  });
});
