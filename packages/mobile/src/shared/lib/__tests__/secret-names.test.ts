import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// G-18: people meet two secrets, the sign-in password and the wallet passphrase. "PIN" is not one of them.
const ROOTS = ["../../../../app", "../../../"];
const LOCALE = "../../i18n/locales/en.json";

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    if (n === "node_modules" || n === "__tests__" || n === "locales") return [];
    if (statSync(p).isDirectory()) return files(p);
    return /\.(tsx?|jsx?)$/.test(n) && !/\.test\./.test(n) ? [p] : [];
  });
}
const stripComments = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/[^\n]*/g, "$1");
const PIN = /\bPINs?\b/;

describe("secret names", () => {
  it("no screen text says PIN", () => {
    const hits: string[] = [];
    for (const root of ROOTS) {
      for (const f of files(join(__dirname, root))) {
        const lines = stripComments(readFileSync(f, "utf8")).split("\n");
        lines.forEach((l, i) => { if (PIN.test(l)) hits.push(`${f.split("/packages/")[1]}:${i + 1}: ${l.trim().slice(0, 100)}`); });
      }
    }
    expect(hits).toEqual([]);
  });

  it("no English string says PIN", () => {
    const hits: string[] = [];
    const walk = (o: Record<string, unknown>, pre = "") => {
      for (const [k, v] of Object.entries(o)) {
        if (typeof v === "string") { if (PIN.test(v)) hits.push(`${pre}${k}: ${v}`); }
        else if (v && typeof v === "object") walk(v as Record<string, unknown>, `${pre}${k}.`);
      }
    };
    walk(JSON.parse(readFileSync(join(__dirname, LOCALE), "utf8")));
    expect(hits).toEqual([]);
  });

  it("the account password is called the sign-in password", () => {
    const en = JSON.parse(readFileSync(join(__dirname, LOCALE), "utf8"));
    expect(en.settings.changePassword).toBe("Change sign-in password");
  });
});
