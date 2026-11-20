import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

// Regression guard: /lms/claim was once compiled out of the live build because it sat inside the
// VITE_PAYMENTS_ENABLED block, so every claim landed on /dashboard. The route must exist in a
// production-like build whatever the Pay flag says.
vi.mock("./pages/LmsClaimSign", () => ({ default: () => <p>LMS-CLAIM-PAGE</p> }));
vi.mock("./pages/Dashboard", () => ({ default: () => <p>DASHBOARD-PAGE</p> }));
vi.mock("./pages/Login", async () => {
  const { useLocation } = await import("react-router-dom");
  // Shows the returnTo that App hands to sign-in: only the real /lms/claim route sets it (the catch-all redirect does not).
  function LoginProbe() { return <p>LOGIN-PAGE {JSON.stringify((useLocation().state as { returnTo?: string } | null)?.returnTo ?? null)}</p>; }
  return { default: LoginProbe };
});
vi.mock("./components/Layout", async () => {
  const { Outlet } = await import("react-router-dom");
  return { default: () => <Outlet /> };
});
import { useAuthStore } from "./store/auth";
import { useWalletStore } from "./store/wallet";
import App from "./App";

function renderAt(path: string, signedIn: boolean) {
  useAuthStore.setState({ isAuthenticated: signedIn, user: signedIn ? ({ id: "u1" } as never) : null, loadProfile: async () => {} } as never);
  useWalletStore.setState({ accounts: [{ id: "a1", publicKey: "G" }], activeAccountId: "a1" } as never);
  return render(<MemoryRouter initialEntries={[path]}><App /></MemoryRouter>);
}

// Production-like flags: Pay shop flag off (unset, "false") or on; Amma-held mainnet custody on; mainnet network.
const PAYMENTS_FLAG: (string | undefined)[] = [undefined, "false", "true"];

describe("App: /lms/claim exists in a production-like build", () => {
  beforeEach(() => {
    vi.stubEnv("VITE_MAINNET_CUSTODY", "on");
    vi.stubEnv("VITE_DEFAULT_NETWORK", "public");
  });
  afterEach(() => vi.unstubAllEnvs());

  it.each(PAYMENTS_FLAG)("signed in, VITE_PAYMENTS_ENABLED=%s: shows the claim page, never /dashboard", async (flag) => {
    if (flag === undefined) vi.stubEnv("VITE_PAYMENTS_ENABLED", ""); else vi.stubEnv("VITE_PAYMENTS_ENABLED", flag);
    renderAt("/lms/claim#message=x", true);
    expect(await screen.findByText("LMS-CLAIM-PAGE")).toBeInTheDocument();
    expect(screen.queryByText("DASHBOARD-PAGE")).toBeNull();
  });

  it.each(PAYMENTS_FLAG)("signed out, VITE_PAYMENTS_ENABLED=%s: goes to sign-in, never /dashboard", async (flag) => {
    if (flag === undefined) vi.stubEnv("VITE_PAYMENTS_ENABLED", ""); else vi.stubEnv("VITE_PAYMENTS_ENABLED", flag);
    renderAt("/lms/claim#message=x", false);
    expect(await screen.findByText('LOGIN-PAGE "/lms/claim#message=x"')).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByText("DASHBOARD-PAGE")).toBeNull());
  });
});
