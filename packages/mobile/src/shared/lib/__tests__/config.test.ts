import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";

const root = fileURLToPath(new URL("../../../../", import.meta.url).href);

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe("API base URL", () => {
  it("defaults to production", async () => {
    vi.stubEnv("EXPO_PUBLIC_API_URL", "");
    const { API_BASE } = await import("../config");
    expect(API_BASE).toBe("https://ammawallet.com");
  });

  it("can point a test build at testnet, without a trailing slash", async () => {
    vi.stubEnv("EXPO_PUBLIC_API_URL", "https://testnet.ammawallet.com/");
    const { API_BASE } = await import("../config");
    expect(API_BASE).toBe("https://testnet.ammawallet.com");
  });

  it("is defined in one place, so no screen can talk to production by accident", () => {
    const files = (dir: string): string[] =>
      readdirSync(dir).flatMap((name) => {
        const full = join(dir, name);
        if (statSync(full).isDirectory()) return name === "__tests__" ? [] : files(full);
        return /\.(ts|tsx)$/.test(name) ? [full] : [];
      });
    const hits = [...files(join(root, "app")), ...files(join(root, "src"))]
      .filter((f) => !f.endsWith(join("lib", "config.ts")))
      .flatMap((f) => readFileSync(f, "utf8").split(/\r?\n/).map((line, i) => ({ f, line, i })))
      .filter(({ line }) => /["'`]https:\/\/ammawallet\.com/.test(line))
      .map(({ f, i }) => `${relative(root, f)}:${i + 1}`);
    expect(hits).toEqual([]);
  });
});
