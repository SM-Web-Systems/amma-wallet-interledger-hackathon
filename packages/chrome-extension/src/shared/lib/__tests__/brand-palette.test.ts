import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// C12: the extension uses the web app's jade + marigold palette and mark.
const pkg = fileURLToPath(new URL("../../../../", import.meta.url));
const css = readFileSync(join(pkg, "src/index.css"), "utf8");
const token = (name: string) => css.match(new RegExp(`--color-${name}:\\s*([^;]+);`))?.[1].trim().toLowerCase();

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const full = join(dir, e.name);
    if (e.isDirectory()) return e.name === "__tests__" ? [] : sources(full);
    return /\.tsx?$/.test(e.name) ? [full] : [];
  });
}

describe("extension brand palette", () => {
  it("theme tokens match the web app's dark theme", () => {
    expect(token("stellar-bg")).toBe("#0c1110");
    expect(token("stellar-card")).toBe("#131a18");
    expect(token("stellar-border")).toBe("#24302c");
    expect(token("stellar-blue")).toBe("#0b7a65");
    expect(token("stellar-purple")).toBe("#0b846c");
    expect(token("stellar-muted")).toBe("#94a39d");
    expect(token("stellar-link")).toBe("#5ee0be");
  });

  it("old violet, indigo and blue utilities are remapped to jade", () => {
    for (const name of ["purple-500", "purple-600", "indigo-500", "indigo-600", "blue-500", "blue-600", "violet-500"]) {
      expect(token(name), name).toMatch(/var\(--color-jade-\d+\)/);
    }
  });

  it("screens use no hard-coded hex colours", () => {
    const hits: string[] = [];
    for (const full of sources(join(pkg, "src"))) {
      if (full.endsWith("BrandMark.tsx")) continue; // the mark's own fixed colours
      readFileSync(full, "utf8").split(/\r?\n/).forEach((line, i) => {
        if (/#[0-9a-fA-F]{6}\b/.test(line)) hits.push(`${relative(pkg, full)}:${i + 1}`);
      });
    }
    expect(hits).toEqual([]);
  });

  it("sign-in and onboarding show the brand mark", () => {
    for (const page of ["Login", "Onboarding"]) {
      expect(readFileSync(join(pkg, `src/popup/pages/${page}.tsx`), "utf8"), page).toMatch(/<BrandMark\b/);
    }
  });

  it("ships the same mark as the web app", () => {
    for (const size of [16, 48, 128]) {
      const ext = readFileSync(join(pkg, `public/icons/icon-${size}.png`));
      expect(ext.equals(readFileSync(join(pkg, `../web-app/public/favicon-${size}.png`))), `icon-${size}`).toBe(true);
    }
  });
});
