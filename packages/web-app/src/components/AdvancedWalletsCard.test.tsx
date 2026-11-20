import { describe, expect, it, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import AdvancedWalletsCard from "./AdvancedWalletsCard";
import { readAdvancedWallets } from "../lib/advanced-wallets";

beforeEach(() => localStorage.clear());

describe("Settings: Advanced wallets", () => {
  it("starts off, says what it does, and turns on and off", () => {
    render(<AdvancedWalletsCard />);
    const box = screen.getByRole("checkbox", { name: /extra wallets/i });
    expect(box).not.toBeChecked();
    expect(screen.getByText(/up to 10 wallets/i)).toBeInTheDocument();
    fireEvent.click(box);
    expect(box).toBeChecked();
    expect(readAdvancedWallets()).toBe(true);
    fireEvent.click(box);
    expect(box).not.toBeChecked();
    expect(readAdvancedWallets()).toBe(false);
  });
});

describe("Settings wiring", () => {
  it("the Settings page renders the Advanced wallets card, so the switch has a place to live", async () => {
    const { readFileSync } = await import("node:fs");
    const source = readFileSync(`${process.cwd()}/src/pages/Settings.tsx`, "utf8");
    expect(source).toContain("<AdvancedWalletsCard />");
  });

  it("says the limit includes the first wallet", () => {
    render(<AdvancedWalletsCard />);
    expect(screen.getByText(/in total .* including your first/i)).toBeInTheDocument();
  });
});
