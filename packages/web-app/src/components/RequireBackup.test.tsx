import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { MemoryRouter, Routes, Route } from "react-router-dom";
import { useWalletStore } from "../store/wallet";
import { useAuthStore } from "../store/auth";
import { ProtectedRoute } from "../App";

const acct = (extra: object) => ({ id: "a1", name: "W", publicKey: "GW", encryptedSecret: "x", createdAt: 1, ...extra });
const at = () => render(
  <MemoryRouter initialEntries={["/dashboard"]}>
    <Routes>
      <Route path="/dashboard" element={<ProtectedRoute><p>app</p></ProtectedRoute>} />
      <Route path="/onboarding" element={<p>onboarding</p>} />
    </Routes>
  </MemoryRouter>,
);

describe("ProtectedRoute and new wallets", () => {
  it("sends a wallet with an unconfirmed backup to the backup step", () => {
    useAuthStore.setState({ isAuthenticated: true } as never);
    useWalletStore.setState({ accounts: [acct({ backupPending: true })], activeAccountId: "a1" } as never);
    at();
    expect(screen.getByText("onboarding")).toBeTruthy();
  });

  it("lets wallets stored before this change, and confirmed ones, through", () => {
    useAuthStore.setState({ isAuthenticated: true } as never);
    useWalletStore.setState({ accounts: [acct({})], activeAccountId: "a1" } as never);
    at();
    expect(screen.getByText("app")).toBeTruthy();
  });
});
