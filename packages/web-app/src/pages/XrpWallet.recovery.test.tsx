import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { IDBFactory } from "fake-indexeddb";

vi.mock("../lib/api", async (orig) => {
  const real = await orig<typeof import("../lib/api")>();
  return { ...real, xrplWalletApi: { ...real.xrplWalletApi, list: vi.fn(async () => []) } };
});
// jsdom's realm breaks @noble's Ed25519 key generation (see vault.test.ts); the vault itself is tested in node.
vi.mock("../lib/xrpl/vault", async (orig) => {
  const real = await orig<typeof import("../lib/xrpl/vault")>();
  return { ...real, createRecoverySeed: () => ({ seed: "sEdTM1uX8pu2do5XvTnutH6HsouMaM2", address: "rTestAddress" }) };
});
import { useAuthStore } from "../store/auth";
import XrpWalletPage from "./XrpWallet";

const PASS = "lamp river garden 42";
beforeEach(() => {
  vi.stubGlobal("indexedDB", new IDBFactory());
  useAuthStore.setState({ user: { id: 7 } as never, isAuthenticated: true });
});
function page() {
  render(<MemoryRouter><XrpWalletPage /></MemoryRouter>);
  fireEvent.change(screen.getByLabelText("New local passphrase"), { target: { value: PASS } });
  fireEvent.change(screen.getByLabelText("Confirm local passphrase"), { target: { value: PASS } });
}

describe("XRP create: recovery phrase or family seed", () => {
  it.each([["24 words", 24], ["12 words", 12]] as const)("%s shows that many words, copyable without numbers", (label, count) => {
    page();
    fireEvent.click(screen.getByLabelText(label));
    fireEvent.click(screen.getByRole("button", { name: "Create recovery phrase" }));
    // What the user selects and copies must be exactly the phrase: words separated by single spaces,
    // with no position numbers to delete before pasting it into another wallet.
    const shown = screen.getByTestId("recovery-seed").textContent ?? "";
    expect(shown).toMatch(/^[a-z]+( [a-z]+)*$/);
    expect(shown.split(" ")).toHaveLength(count);
    expect(screen.getByText(new RegExp(`Write down these ${count} words`))).toBeInTheDocument();
  });

  it("defaults to 24 words", () => {
    page();
    expect(screen.getByLabelText("24 words")).toBeChecked();
  });

  it("still offers a family seed for compatibility", () => {
    page();
    fireEvent.click(screen.getByLabelText("Family seed (advanced)"));
    fireEvent.click(screen.getByRole("button", { name: "Create family seed" }));
    expect(screen.getByTestId("recovery-seed").textContent).toMatch(/^s[1-9A-HJ-NP-Za-km-z]{20,}$/);
  });

  it("restore accepts either and counts the words typed", () => {
    page();
    fireEvent.click(screen.getByRole("button", { name: "Restore" }));
    fireEvent.change(screen.getByLabelText(/^Recovery phrase or family seed/), { target: { value: "abandon abandon abandon" } });
    expect(screen.getByText("3 words (12 or 24 expected)")).toBeInTheDocument();
  });
});
