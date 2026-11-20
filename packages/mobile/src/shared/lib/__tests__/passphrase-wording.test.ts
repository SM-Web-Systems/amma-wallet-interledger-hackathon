import { describe, it, expect } from "vitest";
import en from "../../i18n/locales/en.json";

describe("passphrase wording", () => {
  it("asks for the wallet passphrase, not a PIN, when a screen needs it", () => {
    expect(en.pin.enterToProceed).not.toMatch(/\bPIN\b/i);
    expect(en.pin.enterToProceed).toMatch(/passphrase/i);
  });
});
