import { describe, expect, it } from "vitest";
import i18n from "./index";
import fr from "./locales/fr.json";
import ar from "./locales/ar.json";

type Titled = { receive: { title: string } };

const until = async (check: () => boolean) => {
  for (let i = 0; i < 100 && !check(); i++) await new Promise((r) => setTimeout(r, 10));
};

describe("lazy locales", () => {
  it("starts with English only, so the first load carries one language", async () => {
    await i18n.changeLanguage("en");
    expect(i18n.hasResourceBundle("en", "translation")).toBe(true);
    for (const code of ["fr", "ar", "zu", "sw"]) expect(i18n.hasResourceBundle(code, "translation")).toBe(false);
  });

  it("loads a language when the person picks it, then shows it", async () => {
    await i18n.changeLanguage("fr");
    await until(() => i18n.hasResourceBundle("fr", "translation"));
    expect(i18n.hasResourceBundle("fr", "translation")).toBe(true);
    expect(i18n.t("receive.title", { lng: "fr" })).toBe((fr as Titled).receive.title);
    expect(i18n.language).toBe("fr");
  });

  it("loads a regional code such as fr-FR from its base language file", async () => {
    await i18n.changeLanguage("en");
    i18n.removeResourceBundle("fr", "translation");
    await i18n.changeLanguage("fr-FR");
    await until(() => i18n.hasResourceBundle("fr", "translation"));
    expect(i18n.hasResourceBundle("fr", "translation")).toBe(true);
  });

  it("reads Arabic right to left once it is loaded", async () => {
    await i18n.changeLanguage("ar");
    await until(() => i18n.hasResourceBundle("ar", "translation"));
    expect(i18n.dir("ar")).toBe("rtl");
    expect(i18n.t("receive.title", { lng: "ar" })).toBe((ar as Titled).receive.title);
    await i18n.changeLanguage("en");
    expect(i18n.dir("en")).toBe("ltr");
  });

  it("does not jump back to a language the person has already left while its file was downloading", async () => {
    await i18n.changeLanguage("en");
    i18n.removeResourceBundle("zu", "translation");
    void i18n.changeLanguage("zu");
    await i18n.changeLanguage("en");
    await until(() => i18n.hasResourceBundle("zu", "translation"));
    await new Promise((r) => setTimeout(r, 50));
    expect(i18n.hasResourceBundle("zu", "translation")).toBe(true);
    expect(i18n.language).toBe("en");
  });

  it("reads regional Arabic right to left too", async () => {
    await i18n.changeLanguage("ar-EG");
    await until(() => i18n.hasResourceBundle("ar", "translation"));
    expect(i18n.dir("ar-EG")).toBe("rtl");
    await i18n.changeLanguage("en");
  });

  it("falls back to English for a language that has no file", async () => {
    await i18n.changeLanguage("xx");
    expect(i18n.t("receive.title")).toBe(i18n.t("receive.title", { lng: "en" }));
  });
});
