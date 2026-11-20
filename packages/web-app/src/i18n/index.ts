import i18n from "i18next";
import { initReactI18next } from "react-i18next";
import LanguageDetector from "i18next-browser-languagedetector";

import en from "./locales/en.json";

export const supportedLanguages = [
  { code: "en", name: "English", flag: "🇬🇧" },
  { code: "fr", name: "Français", flag: "🇫🇷" },
  { code: "es", name: "Español", flag: "🇪🇸" },
  { code: "pt", name: "Português", flag: "🇲🇿" },
  { code: "ar", name: "العربية", flag: "🇸🇦", dir: "rtl" as const },
  { code: "zh", name: "中文", flag: "🇨🇳" },
  { code: "sw", name: "Kiswahili", flag: "🇹🇿" },
  { code: "af", name: "Afrikaans", flag: "🇿🇦" },
  { code: "zu", name: "isiZulu", flag: "🇿🇦" },
  { code: "xh", name: "isiXhosa", flag: "🇿🇦" },
  { code: "st", name: "Sesotho", flag: "🇱🇸" },
  { code: "tn", name: "Setswana", flag: "🇧🇼" },
  { code: "nso", name: "Sepedi", flag: "🇿🇦" },
  { code: "ts", name: "Xitsonga", flag: "🇿🇦" },
  { code: "ss", name: "siSwati", flag: "🇸🇿" },
  { code: "ve", name: "Tshivenda", flag: "🇿🇦" },
  { code: "nr", name: "isiNdebele", flag: "🇿🇦" },
  { code: "sn", name: "chiShona", flag: "🇿🇼" },
];

const supportedLngCodes = supportedLanguages.map((l) => l.code);

function updateDocDirection(lng: string) {
  const lang = supportedLanguages.find((l) => l.code === (lng ?? "").split("-")[0]);
  if (typeof document !== "undefined") {
    document.documentElement.dir = lang && "dir" in lang ? "rtl" : "ltr";
    document.documentElement.lang = lng;
  }
}

// Only English ships in the first download. Every other language is its own small file, fetched when it is
// first needed: at start-up for a saved or detected language, or when the person picks one in the switcher.
const localeLoaders = import.meta.glob<{ default: Record<string, unknown> }>("./locales/*.json");

async function loadLanguage(lng: string) {
  const base = lng.split("-")[0];
  if (base === "en" || i18n.hasResourceBundle(base, "translation")) return false;
  const load = localeLoaders[`./locales/${base}.json`];
  if (!load) return false;
  try {
    const mod = await load();
    i18n.addResourceBundle(base, "translation", mod.default, true, true);
    return true;
  } catch {
    // Offline or a failed download: the app stays in English, which is always loaded.
    return false;
  }
}

// After a language's file arrives, say the language changed again so every screen draws it.
// If the person has moved on to another language while the file was downloading, the late file is kept but not shown.
async function showLanguage(lng: string) {
  if (!(await loadLanguage(lng))) return;
  if (i18n.language === lng) await i18n.changeLanguage(lng);
}

i18n
  .use(LanguageDetector)
  .use(initReactI18next)
  .init({
    resources: { en: { translation: en } },
    supportedLngs: supportedLngCodes,
    nonExplicitSupportedLngs: true,
    fallbackLng: "en",
    interpolation: {
      escapeValue: false,
    },
    detection: {
      order: ["localStorage", "navigator", "htmlTag"],
      caches: ["localStorage"],
      lookupLocalStorage: "amma-wallet-lang",
    },
  })
  .then(() => {
    updateDocDirection(i18n.language);
    void showLanguage(i18n.language);
  });

i18n.on("languageChanged", (lng) => {
  updateDocDirection(lng);
  void showLanguage(lng);
});

export default i18n;
