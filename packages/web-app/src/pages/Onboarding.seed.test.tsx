import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import "../i18n";
import { isValidMnemonic } from "../lib/hd-wallet";

// Regression for the broken "Create with Recovery Phrase" flow: the page passed
// the PIN where the store expected the phrase, so every HD wallet creation
// failed with "Invalid mnemonic phrase". The page also always generated 12
// words while telling the user to write down 24.
const { createWalletFromMnemonic } = vi.hoisted(() => ({ createWalletFromMnemonic: vi.fn(async (_input: unknown) => ({ publicKey: "GTEST", mnemonic: "" })) }));
vi.mock("../store/wallet", async (orig) => {
  const real = await orig<typeof import("../store/wallet")>();
  const state = {
    ...real.useWalletStore.getState(),
    accounts: [],
    createWalletFromMnemonic,
  };
  const useWalletStore = Object.assign((sel: (s: typeof state) => unknown) => sel(state), { getState: () => state });
  return { ...real, useWalletStore };
});
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

import OnboardingPage from "./Onboarding";

async function generate(wordCount: "12" | "24") {
  render(<MemoryRouter initialEntries={["/onboarding?action=create-mnemonic"]}><OnboardingPage /></MemoryRouter>);
  fireEvent.click(screen.getByRole("radio", { name: new RegExp(`${wordCount} words`, "i") }));
  const [pin, confirm] = screen.getAllByPlaceholderText(/passphrase/i);
  fireEvent.change(pin, { target: { value: "lamp river garden 42" } });
  fireEvent.change(confirm, { target: { value: "lamp river garden 42" } });
  fireEvent.click(screen.getByRole("button", { name: /generate recovery phrase/i }));
  await screen.findByText(new RegExp(`Write down these ${wordCount} words`, "i"));
  return screen.getAllByTestId("recovery-word").map((el) => el.textContent?.replace(/^\d+\.?\s*/, "").trim() ?? "");
}

describe("Onboarding: create wallet from a recovery phrase", () => {
  beforeEach(() => createWalletFromMnemonic.mockClear());

  it.each(["12", "24"] as const)("shows %s words and creates the wallet from that phrase, not the PIN", async (count) => {
    const words = await generate(count);
    expect(words).toHaveLength(Number(count));
    const phrase = words.join(" ");
    expect(isValidMnemonic(phrase)).toBe(true);

    fireEvent.click(screen.getByRole("button", { name: /i've saved my recovery phrase/i }));
    fireEvent.change(screen.getByPlaceholderText(new RegExp(`Type your ${count} words`, "i")), { target: { value: phrase } });
    fireEvent.click(screen.getByRole("button", { name: /verify/i }));
    fireEvent.click(await screen.findByRole("button", { name: /create wallet now/i }));

    await waitFor(() => expect(createWalletFromMnemonic).toHaveBeenCalledTimes(1));
    expect(createWalletFromMnemonic).toHaveBeenCalledWith(expect.objectContaining({ mnemonic: phrase, pin: "lamp river garden 42" }));
  });
});

describe("Onboarding: wallet passphrase", () => {
  it("refuses an old-style 6-digit PIN and creates nothing", async () => {
    const { toast } = await import("sonner");
    render(<MemoryRouter initialEntries={["/onboarding?action=create-mnemonic"]}><OnboardingPage /></MemoryRouter>);
    const [pin, confirm] = screen.getAllByPlaceholderText(/passphrase/i);
    fireEvent.change(pin, { target: { value: "123456" } });
    fireEvent.change(confirm, { target: { value: "123456" } });
    fireEvent.click(screen.getByRole("button", { name: /generate recovery phrase/i }));
    expect(toast.error).toHaveBeenCalledWith(expect.stringMatching(/12 characters/));
    expect(screen.queryAllByTestId("recovery-word")).toHaveLength(0);
  });
});
