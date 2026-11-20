import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";

// History hides tiny incoming payments from look-alike addresses (address poisoning) and warns when shown.
const m = vi.hoisted(() => ({ history: vi.fn() }));
vi.mock("../lib/api", async (orig) => ({ ...(await orig<typeof import("../lib/api")>()), txApi: { history: m.history } }));
import { useWalletStore } from "../store/wallet";
import HistoryPage from "./History";

const ME = "GBRF2YNVJT45XYGN5FFUUPG35YRUIMHFMC5LCVUHNDHJAHVUJTKVIAXT";
const LEARNER = "GCK6WIPKLYBWWIF4D736P6BEEM6UPMYKKK26KDJBAZVDGL7XYC37BFY3";
const FAKE = "GCK6" + "M".repeat(48) + "BFY3";
const real = { id: "281453948551704577", type: "create_account", funder: ME, account: LEARNER, starting_balance: "1.1000000", transaction_hash: "c".repeat(64), created_at: "2026-11-17T18:52:42Z" };
const dust = { id: "281453991501377537", type: "payment", from: FAKE, to: ME, amount: "0.0001000", asset_type: "native", transaction_hash: "d".repeat(64), created_at: "2026-11-17T18:52:52Z" };

beforeEach(() => {
  m.history.mockReset().mockResolvedValue([dust, real]);
  useWalletStore.setState({ accounts: [{ id: "1", publicKey: ME }], activeAccountId: "1", network: "public" } as never);
});

const renderPage = () => render(
  <MemoryRouter initialEntries={["/history"]}>
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><HistoryPage /></QueryClientProvider>
  </MemoryRouter>,
);

describe("History and address poisoning", () => {
  it("hides the dust row by default and says why", async () => {
    renderPage();
    expect(await screen.findByText("281453948551704577")).toBeInTheDocument();
    expect(screen.queryByText("281453991501377537")).toBeNull();
    expect(screen.getByText(/1 suspicious tiny payment hidden/i)).toBeInTheDocument();
  });

  it("shows it on request with a warning not to copy the address", async () => {
    renderPage();
    fireEvent.click(await screen.findByRole("button", { name: /show/i }));
    expect(screen.getByText("281453991501377537")).toBeInTheDocument();
    expect(screen.getByText(/possible fake address/i)).toBeInTheDocument();
  });

  it("shows no banner when there is nothing suspicious", async () => {
    m.history.mockResolvedValue([real]);
    renderPage();
    expect(await screen.findByText("281453948551704577")).toBeInTheDocument();
    expect(screen.queryByText(/suspicious/i)).toBeNull();
  });
});
