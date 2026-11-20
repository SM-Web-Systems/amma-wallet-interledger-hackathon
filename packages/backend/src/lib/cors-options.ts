import type { FastifyCorsOptions } from "@fastify/cors";

/**
 * CORS for the API. `credentials: true` lets the web app on ammawallet.com receive and
 * send the httpOnly refresh cookie on calls to api.ammawallet.com. It applies only to
 * origins this callback accepts, which @fastify/cors reflects exactly (never "*").
 */
export function corsOptions(webAppUrl?: string): FastifyCorsOptions {
  const allowed = [
    "http://localhost:5173",
    "https://ammawallet.com",
    "https://www.ammawallet.com",
    webAppUrl,
  ].filter(Boolean);

  return {
    credentials: true,
    origin: (origin, cb) => {
      if (!origin || allowed.includes(origin) || origin.startsWith("chrome-extension://")) {
        cb(null, true);
      } else {
        cb(null, false);
      }
    },
  };
}
