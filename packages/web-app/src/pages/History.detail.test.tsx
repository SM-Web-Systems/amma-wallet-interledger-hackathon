import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";

const m = vi.hoisted(() => ({ history: vi.fn(), fetch: vi.fn() }));
vi.mock("../lib/api", async (orig) => ({ ...(await orig<typeof import("../lib/api")>()), txApi: { history: m.history } }));
vi.mock("../lib/stellar-tx-details", async (orig) => ({ ...(await orig<typeof import("../lib/stellar-tx-details")>()), fetchTxDetailsWithRetry: m.fetch }));
import { useWalletStore } from "../store/wallet";
import { mapHorizonTx } from "../lib/stellar-tx-details";
import HistoryPage from "./History";

const HASH = "d02a0de8e5d6" + "a".repeat(52);
const A = "GBRPYHIL2CI3FNQ4BXLFMNDLFJUNPU2HY3ZMFSHONUCEOASW7QC7OX2H";
const B = "GDQP2KPQGKIHYJGXNUIYOMHARUARCA7DJT5FO2FFOOKY3B2WSQHG4W37";
const pay = { id: "281344426885435393", type: "payment", from: A, to: B, amount: "0.1000000", asset_type: "native", transaction_hash: HASH, created_at: "2026-11-16T05:36:12Z" };
const create = { id: "777", type: "create_account", funder: A, account: B, starting_balance: "2.0000000", transaction_hash: "d".repeat(64), created_at: "2026-11-15T05:36:12Z" };
const trust = { id: "555", type: "change_trust", transaction_hash: "c".repeat(64), created_at: "2026-11-14T05:36:12Z" };

beforeEach(() => {
  m.history.mockReset().mockResolvedValue([pay, create, trust]);
  m.fetch.mockReset().mockResolvedValue(mapHorizonTx({ hash: HASH, successful: true, ledger: 9, created_at: pay.created_at, fee_charged: "100", memo_type: "none" }, [pay], "testnet"));
  useWalletStore.setState({ accounts: [{ id: "1", publicKey: A }], activeAccountId: "1", network: "testnet" } as never);
});

const renderPage = (path = "/history") => render(
  <MemoryRouter initialEntries={[path]}>
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><HistoryPage /></QueryClientProvider>
  </MemoryRouter>,
);

describe("History detail", () => {
  it("shows the operation id on payment and create_account rows only", async () => {
    renderPage();
    expect(await screen.findByText("281344426885435393")).toBeInTheDocument();
    expect(screen.getByText("777")).toBeInTheDocument();
    expect(screen.queryByText("555")).toBeNull();
  });

  it("opens the same detail component from a row, on the active network, and the explorer link follows the network", async () => {
    renderPage();
    const buttons = await screen.findAllByRole("button", { name: /Details/ });
    fireEvent.click(buttons[0]);
    const dialog = await screen.findByRole("dialog", { name: "Transaction details" });
    expect(m.fetch).toHaveBeenCalledWith("testnet", HASH, expect.anything());
    expect(await within(dialog).findByText(HASH)).toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: "Copy operation ID" })).toBeInTheDocument();
    expect(within(dialog).getByRole("link", { name: /stellar\.expert/i })).toHaveAttribute("href", `https://stellar.expert/explorer/testnet/tx/${HASH}`);
    fireEvent.click(within(dialog).getByRole("button", { name: "Close" }));
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("opens the detail straight away when the success panel links with ?tx=<hash>", async () => {
    renderPage(`/history?tx=${HASH}`);
    expect(await screen.findByRole("dialog", { name: "Transaction details" })).toBeInTheDocument();
    expect(m.fetch).toHaveBeenCalledWith("testnet", HASH, expect.anything());
  });
});
