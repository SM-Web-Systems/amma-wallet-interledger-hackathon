import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { IDBFactory } from "fake-indexeddb";
import { useAuthStore } from "../store/auth";

const ADDR = "0x6b30c7d7657A83141186Cd8c155CDB90C8750371";
const api = vi.hoisted(() => ({ config: vi.fn(), bal: vi.fn(), hist: vi.fn() }));
vi.mock("../lib/api", async (orig) => ({
  ...(await orig<typeof import("../lib/api")>()),
  request: async (path: string) => {
    if (path.includes("/custody/evm/config")) return api.config();
    if (path.includes("/custody/evm/balances")) return api.bal(path);
    if (path.includes("/custody/evm/history")) return api.hist(path);
    if (path.includes("/custody/evm/transfers")) return { transfers: [] };
    throw new Error("unexpected " + path);
  },
}));
const stable = vi.hoisted(() => ({ network: "ethereum", value: undefined as unknown }));
vi.mock("../lib/use-custody-wallets", () => ({
  shortAddress: (a: string) => a,
  useCustodyWallets: () => {
    if (!stable.value) stable.value = { status: "on", wallets: [{ chain: "evm", network: stable.network, address: "0x6b30c7d7657A83141186Cd8c155CDB90C8750371", name: "Main", index: 0, active: true }], message: "", working: false, add: () => undefined, makeMain: () => undefined, rename: () => undefined };
    return stable.value;
  },
}));
import EvmWalletPage from "./EvmWallet";

beforeEach(() => {
  stable.value = undefined; stable.network = "ethereum";
  vi.stubGlobal("indexedDB", new IDBFactory());
  vi.stubGlobal("fetch", vi.fn());
  Object.values(api).forEach((f) => f.mockReset());
  api.config.mockResolvedValue({ serverData: true, simulate: true, alerts: false, network: "ethereum" });
  api.bal.mockResolvedValue({ address: ADDR.toLowerCase(), network: "ethereum", wei: "2000000000000000000", tokens: [], tokensUnavailable: false });
  api.hist.mockResolvedValue({ address: ADDR.toLowerCase(), transfers: [], pageKey: null });
  useAuthStore.setState({ user: { id: 7 } as never, isAuthenticated: true });
});
afterEach(async () => {
  await waitFor(() => expect(document.querySelector('[aria-busy="true"]')).toBeNull());
  cleanup(); vi.unstubAllEnvs(); vi.unstubAllGlobals();
});

describe("Ethereum page on a mainnet custody build", () => {
  beforeEach(() => vi.stubEnv("VITE_MAINNET_CUSTODY", "on"));

  it("never tells a mainnet user that Amma-held ETH is test money", async () => {
    render(<EvmWalletPage />);
    await screen.findByTestId("evm-server-balances");
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("Ethereum");
    expect(screen.queryByText(/Test network only/)).toBeNull();
    const send = screen.getByRole("region", { name: "Send ETH" });
    expect(send.textContent).not.toMatch(/sepolia|testnet|test eth|faucet/i);
    expect(screen.getByRole("region", { name: "Receive Ethereum (real ETH)" }).textContent).not.toMatch(/sepolia/i);
  });

  it("labels the Amma-held receive section and balances as real ETH", async () => {
    render(<EvmWalletPage />);
    expect(await screen.findByRole("region", { name: "Receive Ethereum (real ETH)" })).toBeInTheDocument();
    expect((await screen.findByTestId("evm-server-balances")).textContent).toMatch(/ETH: 2/);
    await waitFor(() => expect(document.body.textContent).toMatch(/2 ETH/));
    expect(document.body.textContent).not.toMatch(/SepoliaETH/);
  });

  it("keeps device-wallet sections on Sepolia wording and hides the device send form for an Amma wallet", async () => {
    render(<EvmWalletPage />);
    await screen.findByTestId("evm-server-balances");
    expect(screen.queryByRole("heading", { name: "Send Sepolia ETH" })).toBeNull();
    expect(screen.getByText(/Wallets on this device use Sepolia/)).toBeInTheDocument();
  });
});

describe("Ethereum page on a testnet build", () => {
  it("still says Sepolia everywhere for a Sepolia Amma wallet", async () => {
    stable.network = "sepolia";
    api.config.mockResolvedValue({ serverData: true, simulate: true, alerts: false, network: "sepolia" });
    api.bal.mockResolvedValue({ address: ADDR.toLowerCase(), network: "sepolia", wei: "1000000000000000000", tokens: [], tokensUnavailable: false });
    render(<EvmWalletPage />);
    expect(await screen.findByRole("region", { name: "Receive Sepolia ETH" })).toBeInTheDocument();
    expect(screen.getByText(/Test network only/)).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Send Sepolia ETH" })).toBeInTheDocument();
    await waitFor(() => expect(document.body.textContent).toMatch(/1 SepoliaETH/));
  });
  it("says real ETH when the server reports the wallet on ethereum, even without the build flag", async () => {
    render(<EvmWalletPage />);
    expect(await screen.findByRole("region", { name: "Receive Ethereum (real ETH)" })).toBeInTheDocument();
    expect(screen.queryByText(/Test network only/)).toBeNull();
    expect(screen.getByRole("heading", { name: "Send Ethereum (real ETH)" })).toBeInTheDocument();
  });
});

describe("Ethereum RPC errors name the network the wallet is on", () => {
  it("says Ethereum, not Sepolia, for an Amma-held mainnet wallet", async () => {
    const { explain } = await import("../lib/evm/messages");
    const { EvmError } = await import("@amma-wallet/evm-core");
    expect(explain(new EvmError("EVM_RPC_UNAVAILABLE"), true)).toBe("The Ethereum RPC is unavailable. Try again.");
    expect(explain(new EvmError("EVM_RPC_WRONG_CHAIN"), true)).toBe("The configured RPC is not on Ethereum, so it was not used.");
    expect(explain(new EvmError("EVM_RPC_MALFORMED"), true)).toBe("The Ethereum RPC is unavailable. Try again.");
    expect(explain(new EvmError("EVM_RPC_UNAVAILABLE"))).toBe("Sepolia RPC is unavailable. Try again.");
  });
});
