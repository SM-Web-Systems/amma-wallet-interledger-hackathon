import { describe, expect, it, vi } from "vitest";
vi.mock("../db", () => ({ db: {}, schema: {} }));
import { parseArgs } from "./business-wallets-cli";

describe("business wallet operator commands", () => {
  it("reads options and addresses, and insists on tenant, network and who is acting", () => {
    const a = parseArgs(["assign-fee-address", "--tenant=1", "--network=public", "--by=owner", "--address=GABC"]);
    expect([a.command, a.tenant(), a.network(), a.by(), a.options.address]).toEqual(["assign-fee-address", 1, "public", "owner", "GABC"]);
    const b = parseArgs(["add-fee-addresses", "--network=testnet", "--by=owner", "G1", "G2"]);
    expect(b.positional).toEqual(["G1", "G2"]);
    const c = parseArgs(["create", "--tenant=x", "--network=main"]);
    expect(() => c.tenant()).toThrow("--tenant");
    expect(() => c.network()).toThrow("--network");
    expect(() => c.by()).toThrow("--by");
    expect(parseArgs(["create", "--mainnet-approved"]).options["mainnet-approved"]).toBe("true");
  });
});
