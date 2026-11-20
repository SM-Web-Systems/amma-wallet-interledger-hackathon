import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { LEGACY_SSO_AUDIENCE, legacyAudienceOpen, parseLegacyWhitelist, parseSsoWhitelist, relyingPartyFor, stateHash, stateMatches, tenantAudience } from "./sso-rp";

describe("sso-rp", () => {
  it("parses origin=tenant entries and drops malformed ones", () => {
    expect(parseSsoWhitelist([
      "https://lms.example.invalid=12",
      " https://rp.example.invalid:8443 = 7 ",
      "https://no-tenant.example.invalid",
      "https://zero.example.invalid=0",
      "https://neg.example.invalid=-3",
      "https://path.example.invalid/cb?x=1",
      "https://path2.example.invalid/cb=4",
      "not a url=5",
    ])).toEqual([
      { origin: "https://lms.example.invalid", tenantId: 12 },
      { origin: "https://rp.example.invalid:8443", tenantId: 7 },
    ]);
  });

  it("drops an origin listed with two different tenant ids", () => {
    expect(parseSsoWhitelist(["https://a.example.invalid=1", "https://a.example.invalid=2", "https://b.example.invalid=3"]))
      .toEqual([{ origin: "https://b.example.invalid", tenantId: 3 }]);
  });

  it("reads the old origins-only whitelist as well as origin=tenant while enforcement is off", () => {
    expect(parseLegacyWhitelist(["https://lms.example.invalid", "https://rp.example.invalid=7"])).toEqual([
      { origin: "https://rp.example.invalid", tenantId: 7 },
      { origin: "https://lms.example.invalid", tenantId: null },
    ]);
  });

  it("matches a callback by exact origin", () => {
    const rps = parseSsoWhitelist(["https://lms.example.invalid=12"]);
    expect(relyingPartyFor(new URL("https://lms.example.invalid/api/cb"), rps)).toEqual({ origin: "https://lms.example.invalid", tenantId: 12 });
    expect(relyingPartyFor(new URL("https://lms.example.invalid.evil.invalid/cb"), rps)).toBeNull();
    expect(relyingPartyFor(new URL("https://lms.example.invalid:8443/cb"), rps)).toBeNull();
    expect(relyingPartyFor(new URL("http://lms.example.invalid/cb"), rps)).toBeNull();
  });

  it("treats an empty or invalid SSO_LEGACY_AUD_UNTIL as closed", () => {
    const now = new Date("2026-11-16T12:00:00Z");
    expect(legacyAudienceOpen("", now)).toBe(false);
    expect(legacyAudienceOpen("soon", now)).toBe(false);
    expect(legacyAudienceOpen("2026-11-16T11:59:59Z", now)).toBe(false);
    expect(legacyAudienceOpen("2026-12-16T00:00:00Z", now)).toBe(true);
  });

  it("names the audiences and hashes state", () => {
    expect(tenantAudience(12)).toBe("tenant:12");
    expect(LEGACY_SSO_AUDIENCE).toBe("lms-amma-sso");
    expect(stateHash("abc")).toBe(createHash("sha256").update("abc").digest("hex"));
    expect(stateMatches("abc", stateHash("abc"))).toBe(true);
    expect(stateMatches("abd", stateHash("abc"))).toBe(false);
  });
});

describe("sso-rp, off-mode fallbacks", () => {
  it("still matches a bare entry that contains = by the old origin reader", () => {
    const rps = parseLegacyWhitelist(["https://lms.example.invalid/path?x=1", "https://bad.example.invalid=abc"]);
    expect(relyingPartyFor(new URL("https://lms.example.invalid/cb"), rps)).not.toBeNull();
  });
});
