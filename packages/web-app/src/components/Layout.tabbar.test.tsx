// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string, fallback?: string) => fallback ?? key.replace("nav.", "") }) }));
vi.mock("./EmailVerificationBanner", () => ({ default: () => null }));
vi.mock("./PinRetiredPrompt", () => ({ default: () => null }));
vi.mock("./ServerKeyCleanupPrompt", () => ({ default: () => null }));
vi.mock("./AccountSwitcher", () => ({ default: () => null }));
vi.mock("./NotificationBell", () => ({ default: () => null }));
vi.mock("./EthAlertsPoller", () => ({ default: () => null }));
vi.mock("./ThemeToggle", () => ({ default: () => null }));
vi.mock("../lib/xrpl/feature", () => ({ xrplEnabled: true }));
vi.mock("../lib/evm/feature", () => ({ evmEnabled: true }));
vi.mock("../store/auth", () => ({ useAuthStore: (pick: (s: unknown) => unknown) => pick({ user: null, logout: async () => {} }) }));
vi.mock("../store/wallet", () => ({ useWalletStore: (pick: (s: unknown) => unknown) => pick({ logout: () => {} }) }));

import Layout from "./Layout";

let root: Root | undefined;
afterEach(() => { act(() => root?.unmount()); document.body.innerHTML = ""; });

async function quickMenuAt(path: string) {
  const host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => root!.render(
    <MemoryRouter initialEntries={[path]}>
      <Routes><Route element={<Layout />}><Route path="*" element={<p>page</p>} /></Route></Routes>
    </MemoryRouter>,
  ));
  const nav = host.querySelector('nav[aria-label="Quick menu"]')!;
  return [...nav.querySelectorAll("a")].map((a) => `${a.textContent}=${a.getAttribute("href")}${a.getAttribute("aria-current") ? "*" : ""}`);
}

async function xrpLinks() {
  const host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => root!.render(
    <MemoryRouter initialEntries={["/dashboard"]}>
      <Routes><Route element={<Layout />}><Route path="*" element={<p>page</p>} /></Route></Routes>
    </MemoryRouter>,
  ));
  return [...host.querySelectorAll('a[href="/xrpl"]')].map((a) => a.textContent?.trim()).filter((t) => t && t !== "Home");
}

describe("Layout XRP menu entry", () => {
  afterEach(() => vi.unstubAllEnvs());
  it("is XRP Testnet on testnet builds", async () => {
    expect(await xrpLinks()).toContain("XRP Testnet");
  });
  it("is hidden on a mainnet custody build without VITE_XRPL_MAINNET=on", async () => {
    vi.stubEnv("VITE_MAINNET_CUSTODY", "on");
    expect(await xrpLinks()).toEqual([]);
  });
  it("is XRP (no Testnet wording) on a mainnet custody build with VITE_XRPL_MAINNET=on", async () => {
    vi.stubEnv("VITE_MAINNET_CUSTODY", "on"); vi.stubEnv("VITE_XRPL_MAINNET", "on");
    const links = await xrpLinks();
    expect(links).toContain("XRP");
    expect(links.join(" ")).not.toMatch(/Testnet/);
  });
});

describe("Layout phone tab bar", () => {
  it("acts on Stellar on Stellar pages", async () => {
    expect(await quickMenuAt("/send")).toEqual(["Home=/dashboard", "send=/send*", "receive=/receive", "swap=/swap"]);
  });

  it("acts on XRP on the XRP page", async () => {
    expect(await quickMenuAt("/xrpl#receive")).toEqual(["Home=/xrpl", "send=/xrpl#send", "receive=/xrpl#receive*", "Stellar=/dashboard"]);
  });

  it("acts on Ethereum on the Ethereum page", async () => {
    expect(await quickMenuAt("/ethereum-sepolia")).toEqual([
      "Home=/ethereum-sepolia*", "send=/ethereum-sepolia#send", "receive=/ethereum-sepolia#receive", "Stellar=/dashboard",
    ]);
  });
});

describe("Layout menu touch targets", () => {
  it("gives every menu link and the Return to LMS link a 44px minimum height", async () => {
    const host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    await act(async () => root!.render(
      <MemoryRouter initialEntries={["/dashboard"]}>
        <Routes><Route element={<Layout />}><Route path="*" element={<p>page</p>} /></Route></Routes>
      </MemoryRouter>,
    ));
    const links = [...host.querySelectorAll("aside a, aside button")].filter((el) => el.closest("nav:not([aria-label])") || /Return to LMS|Sign Out/.test(el.textContent ?? ""));
    expect(links.length).toBeGreaterThan(5);
    for (const el of links) expect(el.className, el.textContent ?? "").toContain("min-h-11");
  });
});
