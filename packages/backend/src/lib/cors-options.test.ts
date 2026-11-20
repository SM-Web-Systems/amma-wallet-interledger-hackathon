import { describe, expect, it } from "vitest";
import Fastify from "fastify";
import cors from "@fastify/cors";
import { corsOptions } from "./cors-options";

// The web app (ammawallet.com) calls the API on another origin (api.ammawallet.com).
// The browser only stores and sends the httpOnly refresh cookie on such calls when
// the response allows credentials for that exact origin.
async function app() {
  const a = Fastify();
  await a.register(cors, corsOptions("https://app.example.invalid"));
  a.post("/api/v1/auth/refresh", async () => ({ ok: true }));
  return a;
}

describe("CORS for the cross-origin refresh cookie", () => {
  it("allows credentials for the web app's origin", async () => {
    const a = await app();
    const res = await a.inject({ method: "POST", url: "/api/v1/auth/refresh", headers: { origin: "https://ammawallet.com" } });
    expect(res.headers["access-control-allow-origin"]).toBe("https://ammawallet.com");
    expect(res.headers["access-control-allow-credentials"]).toBe("true");
  });

  it("lets the preflight carry the X-Amma-Refresh header with credentials", async () => {
    const a = await app();
    const res = await a.inject({
      method: "OPTIONS",
      url: "/api/v1/auth/refresh",
      headers: {
        origin: "https://www.ammawallet.com",
        "access-control-request-method": "POST",
        "access-control-request-headers": "content-type,x-amma-refresh",
      },
    });
    expect(res.headers["access-control-allow-origin"]).toBe("https://www.ammawallet.com");
    expect(res.headers["access-control-allow-credentials"]).toBe("true");
  });

  it("includes the configured WEB_APP_URL", async () => {
    const a = await app();
    const res = await a.inject({ method: "POST", url: "/api/v1/auth/refresh", headers: { origin: "https://app.example.invalid" } });
    expect(res.headers["access-control-allow-origin"]).toBe("https://app.example.invalid");
  });

  it("does not grant other websites access", async () => {
    const a = await app();
    const res = await a.inject({ method: "POST", url: "/api/v1/auth/refresh", headers: { origin: "https://evil.example.invalid" } });
    expect(res.headers["access-control-allow-origin"]).toBeUndefined();
  });
});
