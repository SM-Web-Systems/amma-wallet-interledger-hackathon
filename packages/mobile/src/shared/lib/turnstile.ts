// Cloudflare Turnstile for the native app. The API requires a Turnstile token
// on /auth/login and /auth/register, so the app shows the same widget as the
// website inside a WebView and passes the token along with the form.

/** Public site key (not a secret); the same one the web app uses. */
export const TURNSTILE_SITE_KEY = "0x4AAAAAAD2WUNs4ywHK6utW";

export type TurnstileMessage =
  | { type: "token"; token: string }
  | { type: "expired" }
  | { type: "error"; code?: string };

/**
 * The WebView loads the widget page "on" the API's site (its baseUrl), so the
 * hostname Cloudflare checks is one already allowed for this key.
 */
export function turnstileOrigin(apiBase: string): string {
  return `${new URL(apiBase).origin}/`;
}

/** JSON-encode for a <script> block, so the value can't close the tag. */
function scriptValue(value: string): string {
  return JSON.stringify(value).replace(/</g, "\\u003c").replace(/>/g, "\\u003e");
}

export function turnstileHtml(siteKey: string, theme: "dark" | "light" = "dark"): string {
  return `<!doctype html>
<html><head>
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>html,body{margin:0;background:transparent;display:flex;justify-content:center;align-items:center;height:100%}</style>
<script src="https://challenges.cloudflare.com/turnstile/v0/api.js?onload=onTurnstileLoad&render=explicit" async defer></script>
</head><body>
<div id="widget"></div>
<script>
  function send(message) { window.ReactNativeWebView.postMessage(JSON.stringify(message)); }
  window.onTurnstileLoad = function () {
    turnstile.render("#widget", {
      sitekey: ${scriptValue(siteKey)},
      theme: ${scriptValue(theme)},
      callback: function (token) { send({ type: "token", token: token }); },
      "expired-callback": function () { send({ type: "expired" }); },
      "error-callback": function (code) { send({ type: "error", code: String(code || "") }); }
    });
  };
</script>
</body></html>`;
}

export function parseTurnstileMessage(data: string): TurnstileMessage | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(data);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const message = parsed as Record<string, unknown>;
  if (message.type === "token" && typeof message.token === "string" && message.token) {
    return { type: "token", token: message.token };
  }
  if (message.type === "expired") return { type: "expired" };
  if (message.type === "error") {
    return typeof message.code === "string" && message.code ? { type: "error", code: message.code } : { type: "error" };
  }
  return null;
}
