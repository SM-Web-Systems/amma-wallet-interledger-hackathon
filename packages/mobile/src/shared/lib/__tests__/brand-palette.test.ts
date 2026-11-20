import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { brand } from "../../theme";

// C12: mobile uses the same jade + marigold palette as the web app, not the old
// blue/violet on slate. These are the old colours; none should be left in screens.
const LEGACY = [
  "#0a0e1a", "#0d1117", "#0f172a", "#1a1a2e", "#060910", "#111827", "#161b22", "#1e293b", "#2a2a4a",
  "#1e3a5f", "#1f2937", "#21262d", "#334155", "#374151", "#475569", "#484f58", "#4b5563", "#6b7280",
  "#8b949e", "#9ca3af", "#94a3b8", "#3b82f6", "#8b5cf6", "#6366f1", "#4338ca", "#4f9cf9", "#58a6ff",
  "#818cf8", "#a78bfa", "#2e1065", "#f59e0b", "#d97706",
];

const pkg = fileURLToPath(new URL("../../../../", import.meta.url).href);
function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const full = join(dir, e.name);
    if (e.isDirectory()) return e.name === "__tests__" ? [] : sources(full);
    return /\.tsx?$/.test(e.name) ? [full] : [];
  });
}

describe("mobile brand palette", () => {
  it("screens use no colours from the old blue/violet palette", () => {
    const hits: string[] = [];
    for (const full of [...sources(join(pkg, "app")), ...sources(join(pkg, "src"))]) {
      readFileSync(full, "utf8").split(/\r?\n/).forEach((line, i) => {
        for (const hex of line.match(/#[0-9a-fA-F]{6}\b/g) ?? []) {
          if (LEGACY.includes(hex.toLowerCase())) hits.push(`${relative(pkg, full)}:${i + 1} ${hex}`);
        }
      });
    }
    expect(hits).toEqual([]);
  });

  it("splash and adaptive icon use the brand background", () => {
    const app = JSON.parse(readFileSync(join(pkg, "app.json"), "utf8")).expo;
    expect(app.splash.backgroundColor.toLowerCase()).toBe(brand.bg);
    expect(app.android.adaptiveIcon.backgroundColor.toLowerCase()).toBe(brand.bg);
  });

  it("onboarding and the lock screen show the brand mark", () => {
    for (const screen of ["onboarding", "lock-screen"]) {
      expect(readFileSync(join(pkg, `app/${screen}.tsx`), "utf8"), screen).toMatch(/<BrandMark\b/);
    }
  });

  it("ships the same mark as the web app", () => {
    const web = join(pkg, "../web-app/public");
    for (const size of [16, 48, 128]) {
      expect(readFileSync(join(pkg, `assets/icon-${size}.png`)).equals(readFileSync(join(web, `favicon-${size}.png`)))).toBe(true);
    }
  });
});
