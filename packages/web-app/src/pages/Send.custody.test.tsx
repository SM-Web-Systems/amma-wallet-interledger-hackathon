import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";

const m = vi.hoisted(() => ({ list: vi.fn(), signAndSubmit: vi.fn(), loadAccount: vi.fn() }));
vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (k: string) => k }) }));
vi.mock("sonner", () => ({ toast: { error: vi.fn(), success: vi.fn() } }));
vi.mock("../lib/custody-wallets", () => ({ listCustodyWallets: m.list }));
vi.mock("../hooks/useBalances", () => ({ useBalances: () => ({ data: [{ assetCode: "XLM", assetIssuer: "native", balance: "100" }] }) }));
vi.mock("../lib/api", async (orig) => {
  const real = await orig<typeof import("../lib/api")>();
  return { ...real, signingApi: { ...real.signingApi, signAndSubmit: m.signAndSubmit, feeQuote: (await import("../test/fee-quote")).noFeeQuote } };
});
vi.mock("../lib/stellar", async (orig) => {
  const real = await orig<typeof import("../lib/stellar")>();
  const Server = class { loadAccount() { m.loadAccount(); return Promise.resolve(new real.StellarSdk.Account("GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN7", "1")); } };
  return { ...real, StellarSdk: { ...real.StellarSdk, Horizon: { ...real.StellarSdk.Horizon, Server } } };
});
import { useAuthStore } from "../store/auth";
import { useWalletStore } from "../store/wallet";
import { MemoryRouter } from "react-router-dom";
import SendPage from "./Send";

const Page = () => <MemoryRouter><SendPage /></MemoryRouter>;

const DEST = "GBRPYHIL2CI3FNQ4BXLFMNDLFJUNPU2HY3ZMFSHONUCEOASW7QC7OX2H";
beforeEach(() => {
  Object.values(m).forEach((f) => f.mockReset());
  useAuthStore.setState({ signingMode: "delegated" });
  useWalletStore.setState({ network: "testnet" } as never);
  vi.spyOn(useWalletStore.getState(), "getPublicKey").mockReturnValue("GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN7");
});

const start = async () => {
  fireEvent.change(screen.getByLabelText("send.destination"), { target: { value: DEST } });
  fireEvent.change(screen.getByLabelText("send.amount"), { target: { value: "5" } });
  fireEvent.click(screen.getByRole("button", { name: /send.sendButton/ }));
  // main added a review step before the password / passphrase prompt; delegated sends wait for the server's fee quote first
  await waitFor(() => expect(screen.getByRole("button", { name: /send.confirmSend/ })).toBeEnabled());
  fireEvent.click(screen.getByRole("button", { name: /send.confirmSend/ }));
};

describe("Send (Stellar) for Amma-held wallets", () => {
  it("asks for the Amma password and sends it as `password`, and shows a wrong password inline", async () => {
    m.list.mockResolvedValue([{ chain: "stellar", address: "GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN7" }]);
    m.signAndSubmit.mockRejectedValueOnce(new Error("That password is not right."));
    render(<Page />);
    await waitFor(() => expect(screen.getByRole("button", { name: /send.sendButton/ })).toBeEnabled());
    await start();
    const input = await screen.findByLabelText("Your Amma password");
    fireEvent.change(input, { target: { value: "hunter2!" } });
    fireEvent.click(screen.getByRole("button", { name: "Confirm" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("That password is not right.");
    expect(m.signAndSubmit.mock.calls[0][2]).toBe("hunter2!");
    expect(m.signAndSubmit.mock.calls[0][3]).toBe("password");
    expect(screen.getByLabelText("Your Amma password")).toHaveValue("");
  });

  it("uses the passphrase when the stellar wallet is not an Amma-held one", async () => {
    m.list.mockResolvedValue([{ chain: "stellar", address: "GOTHER" }]);
    render(<Page />);
    await waitFor(() => expect(screen.getByRole("button", { name: /send.sendButton/ })).toBeEnabled());
    await start();
    expect(await screen.findByLabelText("Wallet passphrase")).toBeInTheDocument();
  });

  it("does not fall back to the PIN when the check fails; offers a retry", async () => {
    m.list.mockRejectedValueOnce(new Error("Network down")).mockResolvedValue([{ chain: "stellar", address: "GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN7" }]);
    render(<Page />);
    expect(await screen.findByRole("alert")).toHaveTextContent("could not check");
    expect(screen.getByRole("button", { name: /send.sendButton/ })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    await waitFor(() => expect(screen.getByRole("button", { name: /send.sendButton/ })).toBeEnabled());
  });

  it("treats mainnet accounts that are not on the custody list as having no Amma wallets", async () => {
    m.list.mockRejectedValue(new Error("Amma-held wallets aren't available for this account on mainnet yet."));
    render(<Page />);
    await waitFor(() => expect(screen.getByRole("button", { name: /send.sendButton/ })).toBeEnabled());
    expect(screen.queryByText(/could not check/)).toBeNull();
    await start();
    expect(await screen.findByLabelText("Wallet passphrase")).toBeInTheDocument();
  });

  it("keeps asking for the wallet passphrase for users who hold their own keys", async () => {
    m.list.mockRejectedValue(new Error("You keep your own keys, so Amma does not manage wallets for you."));
    render(<Page />);
    await waitFor(() => expect(screen.getByRole("button", { name: /send.sendButton/ })).toBeEnabled());
    await start();
    expect(await screen.findByLabelText("Wallet passphrase")).toBeInTheDocument();
    expect(screen.queryByLabelText("Your Amma password")).toBeNull();
  });
});

describe("signAndSubmit body", () => {
  it("sends password or pin under the right key", async () => {
    const real = await vi.importActual<typeof import("../lib/api")>("../lib/api");
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ success: true }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    await real.signingApi.signAndSubmit("xdr", "pass", "secret", "password");
    await real.signingApi.signAndSubmit("xdr", "pass", "123456");
    const bodies = fetchMock.mock.calls.map((c) => JSON.parse((c as unknown as [string, RequestInit])[1].body as string));
    expect(bodies[0]).toEqual({ xdr: "xdr", networkPassphrase: "pass", password: "secret" });
    expect(bodies[1]).toEqual({ xdr: "xdr", networkPassphrase: "pass", pin: "123456" });
    vi.unstubAllGlobals();
  });
});
