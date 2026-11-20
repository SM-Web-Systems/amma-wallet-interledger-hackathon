import { describe, expect, it } from "vitest";
import { signOutNotice } from "./signout-copy";

describe("signOutNotice tells the truth for each mode", () => {
  it("self-custody: keys stay on this device, and there is a way to remove them", () => {
    expect(signOutNotice("self").key).toBe("settings.logoutKeepsKeys");
  });
  it("delegated: wallets come back when signing in", () => {
    expect(signOutNotice("delegated").key).toBe("settings.logoutDelegated");
  });
});
