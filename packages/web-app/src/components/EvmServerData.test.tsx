import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";

const api = vi.hoisted(() => ({ bal: vi.fn(), hist: vi.fn() }));
vi.mock("../lib/eth-server-data", async (orig) => ({ ...(await orig<typeof import("../lib/eth-server-data")>()), getEvmBalances: api.bal, getEvmHistory: api.hist }));
import { EvmServerData } from "./EvmServerData";

const ADDR = "0x6b30c7d7657a83141186cd8c155cdb90c8750371";
const H = "0x" + "a".repeat(64);
beforeEach(() => {
  api.bal.mockReset(); api.hist.mockReset();
  api.bal.mockResolvedValue({ address: ADDR, network: "ethereum", wei: "1500000000000000000", tokensUnavailable: false, tokens: [{ contract: "0x" + "c".repeat(40), symbol: "USDC", name: "USD Coin", decimals: 6, logo: "https://x.invalid/u.png", balance: "2500000" }] });
  api.hist.mockResolvedValue({ address: ADDR, pageKey: "next", transfers: [{ hash: H, direction: "in", asset: "ETH", value: "0.5", counterparty: "0x1111111111111111111111111111111111111111", timestamp: "2026-11-10T10:00:00.000Z" }] });
});

describe("EvmServerData", () => {
  it("shows ETH, tokens and a history list from the server", async () => {
    render(<EvmServerData address={ADDR} />);
    const list = await screen.findByTestId("evm-server-balances");
    expect(list).toHaveTextContent("ETH: 1.5");
    expect(list).toHaveTextContent("USDC: 2.5");
    const hist = await screen.findByTestId("evm-server-history");
    expect(hist).toHaveTextContent("Received 0.5 ETH from 0x111111");
    expect(screen.getByRole("link", { name: "View" })).toHaveAttribute("href", expect.stringContaining(H));
    expect(api.bal).toHaveBeenCalledWith(ADDR);
  });

  it("loads more history with the page key", async () => {
    render(<EvmServerData address={ADDR} />);
    const more = await screen.findByRole("button", { name: "Show more" });
    api.hist.mockResolvedValueOnce({ address: ADDR, pageKey: null, transfers: [{ hash: "0x" + "b".repeat(64), direction: "out", asset: "USDC", value: "5", counterparty: null, timestamp: null }] });
    fireEvent.click(more);
    await waitFor(() => expect(api.hist).toHaveBeenLastCalledWith(ADDR, "next"));
    expect(await screen.findByText(/Sent 5 USDC/)).toBeInTheDocument();
    expect(screen.getAllByRole("link", { name: "View" })).toHaveLength(2);
    expect(screen.queryByRole("button", { name: "Show more" })).toBeNull();
  });

  it("says so plainly when the server cannot answer", async () => {
    api.bal.mockRejectedValue(new Error("Ethereum data is not available right now. Try again in a moment."));
    api.hist.mockRejectedValue(new Error("nope"));
    render(<EvmServerData address={ADDR} />);
    expect(await screen.findByText(/not available right now/)).toBeInTheDocument();
    expect(await screen.findByText("nope")).toBeInTheDocument();
  });
});
