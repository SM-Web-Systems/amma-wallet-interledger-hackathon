// @vitest-environment node
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// Colours that only work on the dark theme. In light mode they vanish (white on near-white)
// or stay dark purple. Use the theme tokens instead: bg-stellar-hover, text-stellar-text,
// and the chart colours from lib/chart-theme.
const DARK_ONLY = [
  /\bbg-white\/(5|10)\b/,
  /hover:text-white\b/,
  /\/10 text-white\b/,
  /#2d2640|#8b83a3|#1a1425/i,
];

// The balance hero is a dark-green gradient in both themes, so white on it is right.
// Admin pages use their own fixed light palette.
const ALLOWED = new Set(["pages/Dashboard.tsx"]);
const isAdmin = (file: string) => file.startsWith("pages/Admin");

const root = fileURLToPath(new URL("..", import.meta.url));
function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const full = join(dir, e.name);
    if (e.isDirectory()) return sources(full);
    return /\.tsx$/.test(e.name) && !/\.test\./.test(e.name) ? [full] : [];
  });
}

describe("light theme", () => {
  it("pages and components use theme tokens, not dark-only colours", () => {
    const hits: string[] = [];
    for (const full of [...sources(join(root, "pages")), ...sources(join(root, "components"))]) {
      const file = relative(root, full).replace(/\\/g, "/");
      if (ALLOWED.has(file) || isAdmin(file)) continue;
      readFileSync(full, "utf8").split(/\r?\n/).forEach((line, i) => {
        for (const re of DARK_ONLY) if (re.test(line)) hits.push(`${file}:${i + 1} ${line.match(re)![0]}`);
      });
    }
    expect(hits).toEqual([]);
  });
});
