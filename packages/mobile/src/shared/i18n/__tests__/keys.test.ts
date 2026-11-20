// Every t("section.key") the app uses without a default text must exist in
// en.json (the fallback language); otherwise the screen shows the raw key,
// e.g. "auth.login" on the sign-in button (seen on a real phone, 2026-11-12).
import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import en from "../locales/en.json";

const root = resolve(__dirname, "../../../..");

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return name === "__tests__" || name === "node_modules" ? [] : sourceFiles(path);
    return /\.tsx?$/.test(name) ? [path] : [];
  });
}

function hasKey(key: string): boolean {
  let node: unknown = en;
  for (const part of key.split(".")) {
    if (!node || typeof node !== "object" || !(part in node)) return false;
    node = (node as Record<string, unknown>)[part];
  }
  return typeof node === "string";
}

describe("mobile translations", () => {
  it("has English text for every key used without a default", () => {
    const missing: string[] = [];
    for (const file of [...sourceFiles(join(root, "app")), ...sourceFiles(join(root, "src"))]) {
      const source = readFileSync(file, "utf8");
      for (const match of source.matchAll(/\bt\(\s*["']([\w]+\.[\w.]+)["']\s*(,)?/g)) {
        if (!match[2] && !hasKey(match[1])) missing.push(`${match[1]} (${file.slice(root.length + 1)})`);
      }
    }
    expect([...new Set(missing)].sort()).toEqual([]);
  });
});
