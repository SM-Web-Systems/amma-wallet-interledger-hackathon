import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

interface Profile { extends?: string; env?: Record<string, string>; android?: { buildType?: string } }
const eas = JSON.parse(readFileSync(new URL("../../../../eas.json", import.meta.url), "utf8")) as { build: Record<string, Profile> };

describe("EAS build profiles", () => {
  it("has a testnet profile: an installable APK that talks to the testnet server only", () => {
    const testnet = eas.build.testnet;
    expect(testnet.extends).toBe("preview");
    expect(eas.build.preview.android?.buildType).toBe("apk");
    expect(testnet.env?.EXPO_PUBLIC_API_URL).toBe("https://testnet.ammawallet.com");
  });
  it("keeps the testnet server out of the preview and production profiles", () => {
    expect(eas.build.preview.env?.EXPO_PUBLIC_API_URL).toBeUndefined();
    expect(eas.build.production.env?.EXPO_PUBLIC_API_URL).toBeUndefined();
  });
});
