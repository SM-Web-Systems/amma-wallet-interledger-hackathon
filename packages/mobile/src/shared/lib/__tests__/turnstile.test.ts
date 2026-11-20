// The API requires a Cloudflare Turnstile token on sign-in and registration.
// The app renders the widget in a WebView; these are the pure parts of that.
import { describe, expect, it } from "vitest";
import { TURNSTILE_SITE_KEY, turnstileHtml, turnstileOrigin, parseTurnstileMessage } from "../turnstile";

describe("Turnstile for the mobile app", () => {
  it("uses the same public site key as the web app", () => {
    expect(TURNSTILE_SITE_KEY).toBe("0x4AAAAAAD2WUNs4ywHK6utW");
  });

  it("renders the widget with that key and posts the result back to the app", () => {
    const html = turnstileHtml(TURNSTILE_SITE_KEY);
    expect(html).toContain("https://challenges.cloudflare.com/turnstile/v0/api.js");
    expect(html).toContain(JSON.stringify(TURNSTILE_SITE_KEY));
    expect(html).toContain("ReactNativeWebView.postMessage");
  });

  it("escapes the key so it cannot break out of the script", () => {
    expect(turnstileHtml('x"</script><script>alert(1)</script>')).not.toContain("</script><script>alert(1)");
  });

  it("loads the page on the API's own site, which Cloudflare allows for this key", () => {
    expect(turnstileOrigin("https://testnet.ammawallet.com")).toBe("https://testnet.ammawallet.com/");
    expect(turnstileOrigin("https://ammawallet.com/")).toBe("https://ammawallet.com/");
  });

  it("reads the messages the widget sends", () => {
    expect(parseTurnstileMessage(JSON.stringify({ type: "token", token: "abc" }))).toEqual({ type: "token", token: "abc" });
    expect(parseTurnstileMessage(JSON.stringify({ type: "expired" }))).toEqual({ type: "expired" });
    expect(parseTurnstileMessage(JSON.stringify({ type: "error", code: "600010" }))).toEqual({ type: "error", code: "600010" });
    expect(parseTurnstileMessage("not json")).toBeNull();
    expect(parseTurnstileMessage(JSON.stringify({ type: "token" }))).toBeNull();
    expect(parseTurnstileMessage(JSON.stringify({ type: "other" }))).toBeNull();
  });
});
