import { describe, expect, it } from "vitest";
import { authenticatedAuthRouteTarget, postLoginPath } from "./post-login-path";

describe("postLoginPath", () => {
  it("returns to settings when login was started from the settings guard", () => {
    expect(postLoginPath({ returnTo: "/settings", hasActiveWallet: false })).toBe("/settings");
    expect(postLoginPath({ returnTo: "/settings", hasActiveWallet: true })).toBe("/settings");
  });

  it("goes to the dashboard when an active wallet exists", () => {
    expect(postLoginPath({ hasActiveWallet: true })).toBe("/dashboard");
  });

  it("goes to onboarding when there is no active wallet", () => {
    expect(postLoginPath({ hasActiveWallet: false })).toBe("/onboarding");
  });

  it("ignores any other returnTo value", () => {
    expect(postLoginPath({ returnTo: "https://evil.example", hasActiveWallet: true })).toBe("/dashboard");
    expect(postLoginPath({ returnTo: "/send", hasActiveWallet: false })).toBe("/onboarding");
  });
});

describe("authenticatedAuthRouteTarget", () => {
  it("sends an XRP approval return path first", () => {
    expect(authenticatedAuthRouteTarget({ approval: "/xrpl?intent=abc", returnTo: "/settings" })).toBe("/xrpl?intent=abc");
  });

  it("keeps the settings return target when there is no approval", () => {
    expect(authenticatedAuthRouteTarget({ approval: null, returnTo: "/settings" })).toBe("/settings");
  });

  it("falls back to the dashboard", () => {
    expect(authenticatedAuthRouteTarget({ approval: null })).toBe("/dashboard");
    expect(authenticatedAuthRouteTarget({ approval: null, returnTo: "/elsewhere" })).toBe("/dashboard");
  });

  it("resumes a pending OAuth request before the settings or dashboard targets", () => {
    expect(authenticatedAuthRouteTarget({ approval: null, pendingOAuth: "?client_id=crm&state=s" })).toBe("/oauth/authorize?client_id=crm&state=s");
    expect(authenticatedAuthRouteTarget({ approval: null, returnTo: "/settings", pendingOAuth: "?client_id=crm" })).toBe("/oauth/authorize?client_id=crm");
  });

  it("keeps an XRP approval or payment return ahead of a pending OAuth request", () => {
    expect(authenticatedAuthRouteTarget({ approval: "/xrpl?intent=abc", pendingOAuth: "?client_id=crm" })).toBe("/xrpl?intent=abc");
  });

  it("ignores a pending OAuth value that is not a query string", () => {
    expect(authenticatedAuthRouteTarget({ approval: null, pendingOAuth: "//evil.example" })).toBe("/dashboard");
    expect(authenticatedAuthRouteTarget({ approval: null, pendingOAuth: "" })).toBe("/dashboard");
    expect(authenticatedAuthRouteTarget({ approval: null, pendingOAuth: null })).toBe("/dashboard");
  });
});

describe("LMS reward claim return", () => {
  const claim = "/lms/claim#message=U00gV2Vi&return=https%3A%2F%2Flms.smwebsystems.com%2Fstudent%2Frewards%2Fclaim";
  it("returns to the claim after login when a wallet exists", () => expect(postLoginPath({ returnTo: claim, hasActiveWallet: true })).toBe(claim));
  it("returns to the claim even before a wallet is on this device", () => expect(postLoginPath({ returnTo: claim, hasActiveWallet: false })).toBe(claim));
  it("ignores lookalike paths", () => expect(postLoginPath({ returnTo: "//evil.example/lms/claim#message=a&return=b", hasActiveWallet: true })).toBe("/dashboard"));
  it("keeps the claim for an already signed-in visitor", () => expect(authenticatedAuthRouteTarget({ approval: null, returnTo: claim })).toBe(claim));
});

