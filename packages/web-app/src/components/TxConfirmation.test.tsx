import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor, fireEvent, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

const m = vi.hoisted(() => ({ fetch: vi.fn() }));
vi.mock("../lib/stellar-tx-details", async (orig) => ({ ...(await orig<typeof import("../lib/stellar-tx-details")>()), fetchTxDetailsWithRetry: m.fetch }));
import { mapHorizonTx } from "../lib/stellar-tx-details";
import TxConfirmation from "./TxConfirmation";
import TxDetailDialog from "./TxDetailDialog";

const HASH = "d02a0de8e5d6" + "a".repeat(52);
const A = "GBRPYHIL2CI3FNQ4BXLFMNDLFJUNPU2HY3ZMFSHONUCEOASW7QC7OX2H";
const B = "GDQP2KPQGKIHYJGXNUIYOMHARUARCA7DJT5FO2FFOOKY3B2WSQHG4W37";
const HEX = "ab".repeat(32);
const details = (network: "public" | "testnet" = "public", memo: Record<string, string> = { memo_type: "text", memo: "reward 7" }) => mapHorizonTx(
  { hash: HASH, successful: true, ledger: 55123456, created_at: "2026-11-16T05:36:12Z", fee_account: A, fee_charged: "100", ...memo },
  [{ id: "281344426885435393", type: "payment", from: A, to: B, amount: "0.1000000", asset_type: "native" }],
  network,
);
let writeText: ReturnType<typeof vi.fn>;
let logs: ReturnType<typeof vi.spyOn>[];
const ui = (el: React.ReactElement) => render(<MemoryRouter>{el}</MemoryRouter>);

beforeEach(() => {
  m.fetch.mockReset();
  writeText = vi.fn().mockResolvedValue(undefined);
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
  logs = (["log", "info", "warn", "error", "debug"] as const).map((k) => vi.spyOn(console, k).mockImplementation(() => {}));
});
afterEach(() => logs.forEach((s) => s.mockRestore()));

describe("TxConfirmation", () => {
  it("shows Confirming… until Horizon answers, then every detail including the operation id", async () => {
    let resolve!: (v: unknown) => void;
    m.fetch.mockReturnValue(new Promise((r) => { resolve = r; }));
    ui(<TxConfirmation hash={HASH} network="public" />);
    expect(screen.getByRole("status")).toHaveTextContent("Confirming…");
    expect(m.fetch).toHaveBeenCalledWith("public", HASH, expect.objectContaining({ attempts: expect.any(Number) }));
    resolve(details());
    expect(await screen.findByText("281344426885435393")).toBeInTheDocument();
    expect(screen.queryByText("Confirming…")).toBeNull();
    expect(screen.getByText("0.1000000 XLM")).toBeInTheDocument();
    expect(screen.getByText(B)).toBeInTheDocument();
    expect(screen.getByText(HASH)).toBeInTheDocument();
    expect(screen.getByText("55123456")).toBeInTheDocument();
    expect(screen.getByText("0.0000100 XLM")).toBeInTheDocument();
    expect(screen.getByText("reward 7")).toBeInTheDocument();
    expect(screen.getByText(/2026-11-16 05:36:12 UTC/)).toBeInTheDocument();
    expect(screen.getByText("Operation ID")).toBeInTheDocument();
  });

  it("copies the hash, the operation id and the destination with labelled buttons", async () => {
    m.fetch.mockResolvedValue(details());
    ui(<TxConfirmation hash={HASH} network="public" />);
    await screen.findByText("281344426885435393");
    fireEvent.click(screen.getByRole("button", { name: "Copy operation ID" }));
    await waitFor(() => expect(writeText).toHaveBeenLastCalledWith("281344426885435393"));
    fireEvent.click(screen.getByRole("button", { name: "Copy transaction hash" }));
    await waitFor(() => expect(writeText).toHaveBeenLastCalledWith(HASH));
    fireEvent.click(screen.getByRole("button", { name: "Copy destination" }));
    await waitFor(() => expect(writeText).toHaveBeenLastCalledWith(B));
  });

  it("shows a hash memo in full as hex and lets it be copied", async () => {
    m.fetch.mockResolvedValue(details("public", { memo_type: "hash", memo: Buffer.from(HEX, "hex").toString("base64") }));
    ui(<TxConfirmation hash={HASH} network="public" />);
    expect(await screen.findByText(HEX)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Copy memo" }));
    await waitFor(() => expect(writeText).toHaveBeenLastCalledWith(HEX));
  });

  it("links to the public explorer on mainnet and the testnet explorer on testnet", async () => {
    m.fetch.mockResolvedValue(details());
    const { unmount } = ui(<TxConfirmation hash={HASH} network="public" />);
    const link = await screen.findByRole("link", { name: /stellar\.expert/i });
    expect(link).toHaveAttribute("href", `https://stellar.expert/explorer/public/tx/${HASH}`);
    expect(link).toHaveAttribute("rel", expect.stringContaining("noopener"));
    unmount();
    m.fetch.mockResolvedValue(details("testnet"));
    ui(<TxConfirmation hash={HASH} network="testnet" />);
    expect(await screen.findByRole("link", { name: /stellar\.expert/i })).toHaveAttribute("href", `https://stellar.expert/explorer/testnet/tx/${HASH}`);
  });

  it("links to the History detail so the operation id stays reachable later", async () => {
    m.fetch.mockResolvedValue(details());
    ui(<TxConfirmation hash={HASH} network="public" />);
    expect(await screen.findByRole("link", { name: /find this later in history/i })).toHaveAttribute("href", `/history?tx=${HASH}`);
  });

  it("when Horizon never answers, shows what is known, the hash and the explorer link, and can try again", async () => {
    m.fetch.mockResolvedValueOnce(null);
    ui(<TxConfirmation hash={HASH} network="public" known={{ amount: "0.1", assetCode: "XLM", destination: B, memoType: "text", memo: "reward 7" }} />);
    expect(await screen.findByText(/not on Horizon yet/i)).toBeInTheDocument();
    expect(screen.getByText(B)).toBeInTheDocument();
    expect(screen.getByText(HASH)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /stellar\.expert/i })).toHaveAttribute("href", expect.stringContaining(HASH));
    expect(screen.queryByText("Operation ID")).toBeNull();
    m.fetch.mockResolvedValueOnce(details());
    fireEvent.click(screen.getByRole("button", { name: "Check again" }));
    expect(await screen.findByText("281344426885435393")).toBeInTheDocument();
  });

  it("falls back to the known view when the fetch throws, and logs nothing", async () => {
    m.fetch.mockRejectedValue(new Error("Horizon error: 500"));
    ui(<TxConfirmation hash={HASH} network="public" />);
    expect(await screen.findByText(/not on Horizon yet/i)).toBeInTheDocument();
    for (const s of logs) expect(s).not.toHaveBeenCalled();
  });

  it("logs nothing on success either", async () => {
    m.fetch.mockResolvedValue(details());
    ui(<TxConfirmation hash={HASH} network="public" />);
    await screen.findByText("281344426885435393");
    for (const s of logs) expect(s).not.toHaveBeenCalled();
  });
});

describe("fee bump and platform fee", () => {
  const INNER = "b".repeat(64);
  const PLATFORM = "GAPLATFORMWALLETXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX";
  it("shows outer and inner hashes, both copyable", async () => {
    const d = mapHorizonTx(
      { hash: HASH, ledger: 1, created_at: "2026-11-16T05:36:12Z", fee_account: A, fee_charged: "200", memo_type: "none", fee_bump_transaction: { hash: HASH }, inner_transaction: { hash: INNER } },
      [{ id: "9", type: "payment", from: A, to: B, amount: "1.0000000", asset_type: "native" }], "public");
    m.fetch.mockResolvedValue(d);
    ui(<TxConfirmation hash={HASH} network="public" />);
    await screen.findByText(INNER);
    expect(screen.getByText("Outer (fee-bump) transaction hash")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Copy inner transaction hash" }));
    await waitFor(() => expect(writeText).toHaveBeenLastCalledWith(INNER));
    fireEvent.click(screen.getByRole("button", { name: "Copy transaction hash" }));
    await waitFor(() => expect(writeText).toHaveBeenLastCalledWith(HASH));
  });
  it("labels the platform fee and keeps the user's payment operation first", async () => {
    const d = mapHorizonTx(
      { hash: HASH, ledger: 1, created_at: "2026-11-16T05:36:12Z", fee_charged: "100", memo_type: "none" },
      [{ id: "10", type: "payment", from: A, to: PLATFORM, amount: "0.0001000", asset_type: "native" }, { id: "9", type: "payment", from: A, to: B, amount: "0.1000000", asset_type: "native" }],
      "public", PLATFORM);
    m.fetch.mockResolvedValue(d);
    ui(<TxConfirmation hash={HASH} network="public" />);
    await screen.findByText("9");
    expect(screen.getAllByText("Operation ID")).toHaveLength(1);
    expect(screen.getAllByRole("button", { name: "Copy operation ID" })).toHaveLength(1);
    const text = document.body.textContent ?? "";
    expect(text.indexOf("0.1000000 XLM")).toBeLessThan(text.indexOf("Network/platform fee (paid by Amma)"));
    expect(screen.getByText(/Network\/platform fee \(paid by Amma\)/)).toBeInTheDocument();
    expect(screen.getByText(/0\.0001000 XLM/)).toBeInTheDocument();
  });
});

describe("TxDetailDialog", () => {
  it("is a modal dialog that takes focus, shows the operation id with a copy button, closes on Escape and Close", async () => {
    m.fetch.mockResolvedValue(details());
    const onClose = vi.fn();
    ui(<TxDetailDialog hash={HASH} network="public" onClose={onClose} />);
    const dialog = screen.getByRole("dialog", { name: "Transaction details" });
    expect(dialog).toHaveAttribute("aria-modal", "true");
    await waitFor(() => expect(dialog.contains(document.activeElement)).toBe(true));
    expect(await within(dialog).findByText("281344426885435393")).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole("button", { name: "Copy operation ID" }));
    await waitFor(() => expect(writeText).toHaveBeenLastCalledWith("281344426885435393"));
    expect(within(dialog).queryByRole("link", { name: /find this later in history/i })).toBeNull();
    fireEvent.keyDown(dialog, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
    fireEvent.click(within(dialog).getByRole("button", { name: "Close" }));
    expect(onClose).toHaveBeenCalledTimes(2);
  });
});
