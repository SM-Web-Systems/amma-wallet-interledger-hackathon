// Bodies and broadcastable blobs are never useful in ordinary request logs.
// Callers still must avoid logging raw SDK/DB exceptions or private key material.
const SENSITIVE_FIELDS = [
  "seed", "privateKey", "secret", "passphrase", "blob", "signedBlob",
  // G-11: credentials, one-time codes and personal details
  "password", "newPassword", "currentPassword", "phrase", "mnemonic", "pin",
  "token", "accessToken", "refreshToken", "twoFaToken", "code", "email", "phone", "phoneNumber",
];
// `code` is also the field name on errors (ECONNREFUSED, FST_ERR_*, Postgres 23505), which is what support
// needs to triage a failure. A one-time code is redacted at the top level of a log object and under body and
// query, never as a nested `err.code`.
const TOP_LEVEL_ONLY = new Set(["code"]);

/** Request logs keep the path, never the query string: one-time tokens travel there (G-11). */
export function pathOnly(url: string | undefined): string | undefined {
  if (!url) return url;
  const at = url.indexOf("?");
  return at === -1 ? url : url.slice(0, at);
}

export const walletLoggerOptions = {
  redact: {
    paths: ["req.headers.authorization", "req.headers.cookie", 'req.headers["x-api-key"]', 'req.headers["x-idp-secret"]', 'req.headers.signature', 'req.headers["rafiki-signature"]',
      'res.headers["set-cookie"]', "req.body", "body", "authorization", "cookie",
      ...SENSITIVE_FIELDS, ...SENSITIVE_FIELDS.filter((field) => !TOP_LEVEL_ONLY.has(field)).map((field) => `*.${field}`),
      "req.query.code", "query.code", "body.code"],
    censor: "[REDACTED]",
  },
  serializers: {
    req(request: { method?: string; url?: string; headers?: Record<string, unknown>; hostname?: string; ip?: string; socket?: { remotePort?: number } }) {
      return {
        method: request.method,
        url: pathOnly(request.url),
        hostname: request.hostname,
        remoteAddress: request.ip,
        remotePort: request.socket?.remotePort,
      };
    },
  },
};
