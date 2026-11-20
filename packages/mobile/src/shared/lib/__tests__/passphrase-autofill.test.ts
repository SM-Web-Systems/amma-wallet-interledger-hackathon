import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// The wallet passphrase protects keys that must stay on this phone. Password managers must not offer to save it
// (Google Password Manager would sync it to the cloud, and label it with the sign-in email).
const SCREENS = ["app/setup-pin.tsx", "app/lock-screen.tsx", "app/settings.tsx", "src/components/PinModal.tsx"];
const source = (path: string) => readFileSync(new URL(`../../../../${path}`, import.meta.url), "utf8");

describe("wallet passphrase fields stay out of password managers", () => {
  it.each(SCREENS)("%s: every secure input opts out of autofill and saving", (path) => {
    const text = source(path);
    const inputs = text.match(/<TextInput[\s\S]*?\/>/g) ?? [];
    const secure = inputs.filter((i) => i.includes("secureTextEntry"));
    expect(secure.length).toBeGreaterThan(0);
    for (const input of secure) {
      expect(input).toContain('importantForAutofill="noExcludeDescendants"');
      expect(input).toContain('autoComplete="off"');
      expect(input).not.toMatch(/textContentType="(password|newPassword)"/);
    }
  });

  it.each(SCREENS)("%s: the screen container is also excluded, so Android does not guess a login field", (path) => {
    const text = source(path);
    const containers = text.match(/<(View|KeyboardAvoidingView|ScrollView)\b[^>]*importantForAutofill="noExcludeDescendants"/g) ?? [];
    expect(containers.length).toBeGreaterThan(0);
  });
});
