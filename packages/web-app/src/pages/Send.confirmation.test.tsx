import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";

const m = vi.hoisted(() => ({ list: vi.fn(), signAndSubmit: vi.fn(), details: vi.fn() }));
vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (k: string, d?: unknown) => (typeof d === "string" ? d : k) }) }));
vi.mock("sonner", () => ({ toast: { error: vi.fn(), success: vi.fn() } }));
vi.mock("../lib/custody-wallets", () => ({ listCustodyWallets: m.list }));
vi.mock("../hooks/useBalances", () => ({ useBalances: () => ({ data: [{ assetCode: "XLM", assetIssuer: "native", balance: "100" }] }) }));
vi.mock("../lib/stellar-tx-details", async (orig) => ({ ...(await orig<typeof import("../lib/stellar-tx-details")>()), fetchTxDetailsWithRetry: m.details }));
vi.mock("../lib/api", async (orig) => {
  const real = await orig<typeof import("../lib/api")>();
  return { ...real, signingApi: { ...real.signingApi, signAndSubmit: m.signAndSubmit, feeQuote: (await import("../test/fee-quote")).noFeeQuote } };
});
vi.mock("../lib/stellar", async (orig) => {
  const real = await orig<typeof import("../lib/stellar")>();
  const Server = class { loadAccount() { return Promise.resolve(new real.StellarSdk.Account("GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN7", "1")); } };
  return { ...real, StellarSdk: { ...real.StellarSdk, Horizon: { ...real.StellarSdk.Horizon, Server } } };
});
import { useAuthStore } from "../store/auth";
import { useWalletStore } from "../store/wallet";
import { MemoryRouter } from "react-router-dom";
import { mapHorizonTx } from "../lib/stellar-tx-details";
import SendPage from "./Send";

const ME = "GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN7";
const DEST = "GBRPYHIL2CI3FNQ4BXLFMNDLFJUNPU2HY3ZMFSHONUCEOASW7QC7OX2H";
const HASH = "d02a0de8e5d6" + "a".repeat(52);

beforeEach(() => {
  Object.values(m).forEach((f) => f.mockReset());
  useAuthStore.setState({ signingMode: "delegated" });
  useWalletStore.setState({ network: "public" } as never);
  vi.spyOn(useWalletStore.getState(), "getPublicKey").mockReturnValue(ME);
});

describe("Send success shows the transaction confirmation", () => {
  it("after an Amma-password send, fetches the hash on the active network and shows the operation id", async () => {
    m.list.mockResolvedValue([{ chain: "stellar", address: ME }]);
    m.signAndSubmit.mockResolvedValue({ success: true, result: { hash: HASH } });
    m.details.mockResolvedValue(mapHorizonTx(
      { hash: HASH, ledger: 5, created_at: "2026-11-16T05:36:12Z", fee_charged: "100", memo_type: "none" },
      [{ id: "281344426885435393", type: "payment", from: ME, to: DEST, amount: "5.0000000", asset_type: "native" }], "public"));
    render(<MemoryRouter><SendPage /></MemoryRouter>);
    await waitFor(() => expect(screen.getByRole("button", { name: /send.sendButton/ })).toBeEnabled());
    fireEvent.change(screen.getByLabelText("send.destination"), { target: { value: DEST } });
    fireEvent.change(screen.getByLabelText("send.amount"), { target: { value: "5" } });
    fireEvent.click(screen.getByRole("button", { name: /send.sendButton/ }));
    // Delegated sends wait for the server's fee quote before Confirm is enabled.
    await waitFor(() => expect(screen.getByRole("button", { name: /Confirm and send/ })).toBeEnabled());
    fireEvent.click(screen.getByRole("button", { name: /Confirm and send/ }));
    fireEvent.change(await screen.findByLabelText("Your Amma password"), { target: { value: "hunter2!" } });
    fireEvent.click(screen.getByRole("button", { name: "Confirm" }));
    expect(await screen.findByText("281344426885435393")).toBeInTheDocument();
    expect(m.details).toHaveBeenCalledWith("public", HASH, expect.anything());
    expect(screen.getByRole("link", { name: /stellar\.expert/i })).toHaveAttribute("href", `https://stellar.expert/explorer/public/tx/${HASH}`);
  });
});
