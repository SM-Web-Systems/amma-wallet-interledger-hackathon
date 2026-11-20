// TODO C10: onboarding copy is chain-neutral and offers every enabled chain.
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";

vi.mock("../lib/xrpl/feature", () => ({ xrplEnabled: true }));
vi.mock("../lib/evm/feature", () => ({ evmEnabled: true }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

import OnboardingPage from "./Onboarding";

const LOCALES = resolve(__dirname, "../i18n/locales");

describe("onboarding subtitle", () => {
  it.each(readdirSync(LOCALES).filter((f) => f.endsWith(".json")))("%s does not tie the wallet to Stellar", (file) => {
    const subtitle = JSON.parse(readFileSync(resolve(LOCALES, file), "utf8")).onboarding.subtitle as string;
    expect(subtitle).toBeTruthy();
    expect(subtitle).not.toMatch(/stellar/i);
  });
});

describe("onboarding offers the other chains", () => {
  it("links to the XRP and Ethereum wallets", () => {
    render(<MemoryRouter><OnboardingPage /></MemoryRouter>);
    expect(screen.getByRole("link", { name: /XRP Testnet/ }).getAttribute("href")).toBe("/xrpl");
    expect(screen.getByRole("link", { name: /Ethereum Sepolia/ }).getAttribute("href")).toBe("/ethereum-sepolia");
  });

  it("calls it Ethereum (not Sepolia) in a mainnet custody build", () => {
    vi.stubEnv("VITE_MAINNET_CUSTODY", "on");
    try {
      render(<MemoryRouter><OnboardingPage /></MemoryRouter>);
      const link = screen.getByRole("link", { name: "Open Ethereum wallets" });
      expect(link.getAttribute("href")).toBe("/ethereum-sepolia");
      expect(screen.queryByRole("link", { name: /Sepolia/ })).toBeNull();
    } finally { vi.unstubAllEnvs(); }
  });

  it("hides XRP in a mainnet custody build unless VITE_XRPL_MAINNET=on, and then calls it XRP (not Testnet)", () => {
    vi.stubEnv("VITE_MAINNET_CUSTODY", "on");
    try {
      const { unmount } = render(<MemoryRouter><OnboardingPage /></MemoryRouter>);
      expect(screen.queryByRole("link", { name: /XRP/ })).toBeNull();
      unmount();
      vi.stubEnv("VITE_XRPL_MAINNET", "on");
      render(<MemoryRouter><OnboardingPage /></MemoryRouter>);
      expect(screen.getByRole("link", { name: "Open XRP wallets" }).getAttribute("href")).toBe("/xrpl");
      expect(screen.queryByRole("link", { name: /Testnet/ })).toBeNull();
    } finally { vi.unstubAllEnvs(); }
  });
});
