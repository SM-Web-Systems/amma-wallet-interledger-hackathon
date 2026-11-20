import { describe, expect, it } from "vitest";
import { activationFor, type ActivationInfo } from "./activation";

const w = (address: string, state: ActivationInfo["state"] = "active"): ActivationInfo => ({ chain: "stellar", network: "testnet", address, state });

describe("activationFor", () => {
  it("returns the entry for the wallet on screen only", () => {
    expect(activationFor([w("GA"), w("GB", "not_activated")], "GB")).toEqual(w("GB", "not_activated"));
    expect(activationFor([w("GA")], "GOTHER")).toBeNull();
  });
  it("is null with nothing to match", () => {
    expect(activationFor(undefined, "GA")).toBeNull();
    expect(activationFor([], "GA")).toBeNull();
    expect(activationFor([w("GA")], null)).toBeNull();
  });
});
