import crypto from "crypto";

/** One relying party allowed to receive SSO assertions: an exact origin and the tenant that owns it (WA-05). */
export interface SsoRelyingParty { origin: string; tenantId: number }

/** The audience every assertion carried before WA-05. Accepted only for the LMS tenant during the dated transition. */
export const LEGACY_SSO_AUDIENCE = "lms-amma-sso";

export const tenantAudience = (tenantId: number): string => `tenant:${tenantId}`;

/**
 * Parses SSO_CALLBACK_WHITELIST entries of the form `https://rp.example=12`.
 * An entry is dropped when it has no positive integer tenant id or its left part is not a bare origin (no path, query or hash).
 * Duplicate origins with different tenant ids are dropped (all of them).
 */
export function parseSsoWhitelist(entries: readonly string[]): SsoRelyingParty[] {
  const out: SsoRelyingParty[] = [];
  for (const raw of entries) {
    const at = raw.lastIndexOf("=");
    if (at <= 0) continue;
    const idText = raw.slice(at + 1).trim();
    if (!/^\d+$/.test(idText)) continue;
    const tenantId = Number(idText);
    if (!Number.isSafeInteger(tenantId) || tenantId <= 0) continue;
    let url: URL;
    try { url = new URL(raw.slice(0, at).trim()); } catch { continue; }
    if (url.pathname !== "/" || url.search || url.hash) continue;
    out.push({ origin: url.origin, tenantId });
  }
  const conflicting = new Set(out.filter((a) => out.some((b) => b.origin === a.origin && b.tenantId !== a.tenantId)).map((r) => r.origin));
  return out.filter((r) => !conflicting.has(r.origin));
}

/**
 * Pre-WA-05 whitelist reading, used only while SSO_AUDIENCE_ENFORCE is off: any URL entry counts by origin,
 * with or without `=tenantId`. This is exactly what the old image accepted, so deploying the new image
 * with the old whitelist value keeps the LMS working.
 */
export function parseLegacyWhitelist(entries: readonly string[]): { origin: string; tenantId: number | null }[] {
  const strict = parseSsoWhitelist(entries);
  const out: { origin: string; tenantId: number | null }[] = [...strict];
  // Anything the strict reader dropped is read the old way: new URL(entry).origin, no tenant.
  for (const raw of entries) {
    if (parseSsoWhitelist([raw]).length > 0) continue;
    try {
      const origin = new URL(raw).origin;
      if (!out.some((r) => r.origin === origin)) out.push({ origin, tenantId: null });
    } catch { /* ignore */ }
  }
  return out;
}

export const relyingPartyFor = <T extends { origin: string }>(callback: URL, rps: readonly T[]): T | null =>
  rps.find((rp) => rp.origin === callback.origin) ?? null;

/** True while `now` is before the ISO date `until`. Empty or unparsable means closed. */
export function windowOpen(until: string, now: Date = new Date()): boolean {
  if (!until) return false;
  const end = Date.parse(until);
  return Number.isFinite(end) && now.getTime() < end;
}
export const legacyAudienceOpen = windowOpen;

export const stateHash = (state: string): string => crypto.createHash("sha256").update(state).digest("hex");

/** Constant-time compare of sha256(state) with the `sth` claim. */
export function stateMatches(state: string, sth: string): boolean {
  const a = Buffer.from(stateHash(state));
  const b = Buffer.from(sth);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
