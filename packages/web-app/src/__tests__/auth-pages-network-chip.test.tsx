// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { useAuthStore } from "../store/auth";
import AuthRoute from "../components/AuthRoute";
import LoginPage from "../pages/Login";
import RegisterPage from "../pages/Register";
import ForgotPasswordPage from "../pages/ForgotPassword";
import ResetPasswordPage from "../pages/ResetPassword";
import en from "../i18n/locales/en.json";

vi.mock("../components/Turnstile", () => ({ Turnstile: () => null }));
vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, fallback?: string) => {
      const v = key.split(".").reduce<any>((o, k) => o?.[k], en);
      return typeof v === "string" ? v : fallback ?? key;
    },
  }),
}));

let root: Root;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  document.body.innerHTML = '<div id="root"></div>';
  root = createRoot(document.getElementById("root")!);
  useAuthStore.setState({ isAuthenticated: false });
});
afterEach(async () => {
  await act(async () => root.unmount());
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

const pages = [
  ["/login", LoginPage],
  ["/register", RegisterPage],
  ["/forgot-password", ForgotPasswordPage],
  ["/reset-password", ResetPasswordPage],
] as const;

async function renderAt(path: string, Page: React.ComponentType, network: "testnet" | "public") {
  vi.stubEnv("VITE_DEFAULT_NETWORK", network);
  await act(async () =>
    root.render(
      <MemoryRouter initialEntries={[path]}>
        <AuthRoute>
          <Page />
        </AuthRoute>
      </MemoryRouter>,
    ),
  );
}

describe("signed-out pages: test network chip", () => {
  for (const [path, Page] of pages) {
    it(`${path} shows the chip on a testnet build`, async () => {
      await renderAt(path, Page, "testnet");
      const chip = document.querySelector('[data-testid="auth-network-chip"]');
      expect(chip).not.toBeNull();
      expect(chip!.getAttribute("role")).toBe("status");
      expect(chip!.textContent).toMatch(/Testnet/);
      expect(chip!.textContent).toMatch(/test network/i);
      expect(chip!.className).toContain("pointer-events-none"); // never blocks taps on the form below
    });
    it(`${path} shows nothing new on a mainnet build`, async () => {
      await renderAt(path, Page, "public");
      expect(document.querySelector('[data-testid="auth-network-chip"]')).toBeNull();
      expect(document.body.textContent).not.toMatch(/Testnet/);
    });
  }
});

describe("Register autofill hints", () => {
  const attrs = (el: Element | null) => ({ ac: el?.getAttribute("autocomplete"), name: el?.getAttribute("name") });
  it("sets autocomplete and name on every field, with labels bound", async () => {
    await renderAt("/register", RegisterPage, "public");
    const q = (id: string) => document.getElementById(id);
    expect(attrs(q("register-first-name"))).toEqual({ ac: "given-name", name: "firstName" });
    expect(attrs(q("register-last-name"))).toEqual({ ac: "family-name", name: "lastName" });
    expect(attrs(q("register-email"))).toEqual({ ac: "email", name: "email" });
    expect(attrs(q("register-password"))).toEqual({ ac: "new-password", name: "password" });
    expect(attrs(q("register-confirm-password"))).toEqual({ ac: "new-password", name: "confirmPassword" });
    for (const id of ["register-first-name", "register-last-name", "register-email", "register-password", "register-confirm-password"]) {
      expect(document.querySelector(`label[for="${id}"]`)).not.toBeNull();
    }
  });
  it("lists the same password rules as the server (8 chars, upper, lower, digit) plus match", async () => {
    await renderAt("/register", RegisterPage, "public");
    const text = document.body.textContent!;
    for (const k of ["rule8chars", "ruleUppercase", "ruleLowercase", "ruleNumber", "ruleMatch"]) {
      expect(text).toContain((en as any).auth[k]);
    }
  });
});
