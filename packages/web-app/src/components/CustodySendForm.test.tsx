import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";

const api = vi.hoisted(() => ({ xrp: vi.fn(), evm: vi.fn(), list: vi.fn(), status: vi.fn() }));
vi.mock("../lib/custody-send", async (orig) => {
  const real = await orig<typeof import("../lib/custody-send")>();
  return { ...real, sendCustodyXrp: api.xrp, sendCustodyEvm: api.evm, listCustodyEvmTransfers: api.list, getXrpPaymentStatus: api.status };
});
import { CustodySendForm } from "./CustodySendForm";

const FROM_X = "rMAIN0000000000000000000000000000";
const TO_X = "rf1BiGeXwwQoi8Z2ueFYTEXSwuJYfV2Jpn";
const FROM_E = "0xAAAA000000000000000000000000000000000000";
const TO_E = "0x1111111111111111111111111111111111111111";
beforeEach(() => { Object.values(api).forEach((f) => f.mockReset()); api.list.mockResolvedValue([]); sessionStorage.clear(); });

afterEach(() => vi.unstubAllEnvs());
const fill = (label: string | RegExp, value: string) => fireEvent.change(screen.getByLabelText(label), { target: { value } });

describe("XRP send form", () => {
  const review = (amount = "1.5", tag = "") => {
    fill(/Send to/, TO_X); fill(/Amount/, amount); if (tag) fill(/Destination tag/, tag);
    fireEvent.click(screen.getByRole("button", { name: "Review" }));
  };

  it("shows exactly what will be sent before asking for the password", () => {
    render(<CustodySendForm chain="xrpl" from={FROM_X} />);
    review("1.5", "42");
    expect(screen.getByText(TO_X)).toBeInTheDocument();
    expect(screen.getByText("Amount 1.5 XRP")).toBeInTheDocument();
    expect(screen.getByText("Destination tag 42")).toBeInTheDocument();
    expect(screen.getByText(/Maximum network fee: up to 0.0002 XRP/)).toBeInTheDocument();
    expect(screen.getByText("Total: up to 1.5002 XRP")).toBeInTheDocument();
    expect(screen.getByLabelText("Your Amma password")).toHaveAttribute("type", "password");
    expect(api.xrp).not.toHaveBeenCalled();
  });

  it("sends drops as a string, the tag as a number, and shows status and the explorer link", async () => {
    api.xrp.mockResolvedValue({ state: "submitted", hash: "ABC123" });
    render(<CustodySendForm chain="xrpl" from={FROM_X} />);
    review("1.5", "42");
    fill("Your Amma password", "hunter2!");
    fireEvent.click(screen.getByRole("button", { name: "Approve and send" }));
    await waitFor(() => expect(api.xrp).toHaveBeenCalled());
    const body = api.xrp.mock.calls[0][0];
    expect(body).toMatchObject({ from: FROM_X, to: TO_X, amountDrops: "1500000", destinationTag: 42, password: "hunter2!" });
    expect(body.idempotencyKey).toMatch(/^[0-9a-f-]{36}$/);
    expect(await screen.findByText(/Status: Sent, waiting for confirmation/)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /explorer/ })).toHaveAttribute("href", "https://testnet.xrpl.org/transactions/ABC123");
    expect(screen.queryByLabelText("Your Amma password")).toBeNull();
  });

  it("links to the livenet explorer in an XRP mainnet build", async () => {
    vi.stubEnv("VITE_MAINNET_CUSTODY", "on"); vi.stubEnv("VITE_XRPL_MAINNET", "on");
    try {
      api.xrp.mockResolvedValue({ state: "submitted", hash: "ABC123" });
      render(<CustodySendForm chain="xrpl" from={FROM_X} />);
      expect(screen.getByRole("heading", { name: "Send XRP" })).toBeInTheDocument();
      review("1", "");
      fill("Your Amma password", "hunter2!");
      fireEvent.click(screen.getByRole("button", { name: "Approve and send" }));
      const link = await screen.findByRole("link", { name: /explorer/ });
      expect(link).toHaveAttribute("href", "https://livenet.xrpl.org/transactions/ABC123");
      expect(link.textContent).toBe("View on the XRP Ledger explorer");
    } finally { vi.unstubAllEnvs(); }
  });

  it("refreshes an XRP payment's status from the payment status route", async () => {
    api.xrp.mockResolvedValue({ id: "pay-1", state: "submitted", hash: "ABC123" });
    render(<CustodySendForm chain="xrpl" from={FROM_X} />);
    review();
    fill("Your Amma password", "pw");
    fireEvent.click(screen.getByRole("button", { name: "Approve and send" }));
    await screen.findByText(/Status: Sent/);
    api.status.mockResolvedValue({ id: "pay-1", state: "validated_success", hash: "ABC123" });
    fireEvent.click(screen.getByRole("button", { name: "Refresh status" }));
    expect(await screen.findByText("Status: Confirmed")).toBeInTheDocument();
    expect(api.status).toHaveBeenCalledWith("pay-1");
  });

  it("moves focus to the password field on review and to the alert on error, with friendly 429 text", async () => {
    api.xrp.mockRejectedValue(new Error("Too many wrong passwords. Try again in 15 minutes."));
    render(<CustodySendForm chain="xrpl" from={FROM_X} />);
    review();
    expect(screen.getByLabelText("Your Amma password")).toHaveFocus();
    fill("Your Amma password", "pw");
    fireEvent.click(screen.getByRole("button", { name: "Approve and send" }));
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Too many wrong passwords. Try again in 15 minutes.");
    await waitFor(() => expect(alert).toHaveFocus());
  });

  it("shows the wrong-password message inline and clears the password", async () => {
    api.xrp.mockRejectedValue(new Error("That password is not right. You have 9 tries left."));
    render(<CustodySendForm chain="xrpl" from={FROM_X} />);
    review();
    fill("Your Amma password", "nope");
    fireEvent.click(screen.getByRole("button", { name: "Approve and send" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("That password is not right");
    const pw = screen.getByLabelText("Your Amma password");
    expect(pw).toHaveAttribute("aria-invalid", "true");
    expect(pw).toHaveValue("");
    expect(pw.getAttribute("aria-describedby")).toBe(screen.getByRole("alert").id);
  });

  it("shows the limit message inline", async () => {
    api.xrp.mockRejectedValue(new Error("That is more than the 100 XRP limit for one payment."));
    render(<CustodySendForm chain="xrpl" from={FROM_X} />);
    review("500");
    fill("Your Amma password", "pw");
    fireEvent.click(screen.getByRole("button", { name: "Approve and send" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("100 XRP limit");
  });

  it("keeps the same idempotency key after Cancel and a new Review while the last attempt is unresolved", async () => {
    api.xrp.mockRejectedValue(new Error("busy"));
    render(<CustodySendForm chain="xrpl" from={FROM_X} />);
    review();
    for (let i = 0; i < 2; i++) { fill("Your Amma password", "pw"); fireEvent.click(screen.getByRole("button", { name: "Approve and send" })); await waitFor(() => expect(api.xrp).toHaveBeenCalledTimes(i + 1)); await screen.findByRole("alert"); }
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    fireEvent.click(screen.getByRole("button", { name: "Review" }));
    fill("Your Amma password", "pw"); fireEvent.click(screen.getByRole("button", { name: "Approve and send" }));
    await waitFor(() => expect(api.xrp).toHaveBeenCalledTimes(3));
    const keys = api.xrp.mock.calls.map((c) => c[0].idempotencyKey);
    expect(new Set(keys).size).toBe(1);
    expect(keys[0]).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("uses a new key for the next payment once the last one is settled", async () => {
    api.xrp.mockResolvedValue({ id: "pay-1", state: "submitted", hash: "ABC123" });
    render(<CustodySendForm chain="xrpl" from={FROM_X} />);
    review(); fill("Your Amma password", "pw"); fireEvent.click(screen.getByRole("button", { name: "Approve and send" }));
    await screen.findByText(/Status: Sent/);
    review(); fill("Your Amma password", "pw"); fireEvent.click(screen.getByRole("button", { name: "Approve and send" }));
    await waitFor(() => expect(api.xrp).toHaveBeenCalledTimes(2));
    expect(api.xrp.mock.calls[1][0].idempotencyKey).not.toBe(api.xrp.mock.calls[0][0].idempotencyKey);
  });

  it("rejects bad input before any review, with described errors", () => {
    render(<CustodySendForm chain="xrpl" from={FROM_X} />);
    fill(/Send to/, "nonsense"); fill(/Amount/, "0.0000001"); fill(/Destination tag/, "x");
    fireEvent.click(screen.getByRole("button", { name: "Review" }));
    expect(screen.getAllByRole("alert")).toHaveLength(3);
    expect(screen.getByLabelText(/Send to/)).toHaveAttribute("aria-invalid", "true");
    expect(screen.queryByLabelText("Your Amma password")).toBeNull();
  });
});

describe("ETH send form", () => {
  const reviewEth = (amount = "0.01") => { fill(/Send to/, TO_E); fill(/Amount/, amount); fireEvent.click(screen.getByRole("button", { name: "Review" })); };
  const approve = () => { fill("Your Amma password", "pw"); fireEvent.click(screen.getByRole("button", { name: "Approve and send" })); };

  it("keeps the key across a reload of the page", async () => {
    api.evm.mockRejectedValueOnce(new Error("The payment could not be completed right now.")).mockResolvedValueOnce({ id: "1", state: "broadcast", hash: "0xfeed" });
    const first = render(<CustodySendForm chain="evm" from={FROM_E} />);
    reviewEth(); approve();
    await screen.findByRole("alert");
    first.unmount();
    render(<CustodySendForm chain="evm" from={FROM_E} />);
    reviewEth(); approve();
    await waitFor(() => expect(api.evm).toHaveBeenCalledTimes(2));
    expect(api.evm.mock.calls[1][0].idempotencyKey).toBe(api.evm.mock.calls[0][0].idempotencyKey);
    // "broadcast" is settled, so the key is gone.
    await waitFor(() => expect(sessionStorage.length).toBe(0));
  });

  it("shows 'status unknown' with the hash and keeps the key when the server answers 202 unknown", async () => {
    const msg = "The payment was signed but could not be confirmed as sent. Check the transfer list before trying again.";
    api.evm.mockResolvedValueOnce({ id: "1", state: "signed", hash: "0xdead", status: "unknown", error: msg }).mockResolvedValueOnce({ id: "1", state: "broadcast", hash: "0xdead" });
    render(<CustodySendForm chain="evm" from={FROM_E} />);
    reviewEth(); approve();
    expect(await screen.findByText(msg)).toBeInTheDocument();
    expect(screen.getByText("Status: Signed, being sent to the network")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /explorer/ })).toHaveAttribute("href", "https://sepolia.etherscan.io/tx/0xdead");
    reviewEth(); approve();
    await waitFor(() => expect(api.evm).toHaveBeenCalledTimes(2));
    expect(api.evm.mock.calls[1][0].idempotencyKey).toBe(api.evm.mock.calls[0][0].idempotencyKey);
  });

  it("lists the wallet's recent transfers with their state", async () => {
    const hash = "0x" + "ab".repeat(32);
    api.list.mockResolvedValue([{ id: "7", from: FROM_E.toLowerCase(), to: TO_E, amountWei: "5000000000000000", hash, state: "broadcast" }]);
    render(<CustodySendForm chain="evm" from={FROM_E} />);
    const item = await screen.findByText(/0\.005 ETH to/);
    expect(item).toHaveTextContent("Sent, waiting for confirmation");
    expect(api.list).toHaveBeenCalledWith(FROM_E);
    expect(screen.getByRole("link", { name: /^0xabab/ })).toHaveAttribute("href", `https://sepolia.etherscan.io/tx/${hash}`);
  });

  it("converts to wei exactly, shows the fee note, and sends", async () => {
    api.evm.mockResolvedValue({ state: "broadcast", hash: "0xfeed" });
    render(<CustodySendForm chain="evm" from={FROM_E} />);
    fill(/Send to/, TO_E); fill(/Amount/, "0.012345678901234567");
    fireEvent.click(screen.getByRole("button", { name: "Review" }));
    expect(screen.getByText("Amount 0.012345678901234567 ETH")).toBeInTheDocument();
    expect(screen.getByText(/network fee shown after sending/)).toBeInTheDocument();
    fill("Your Amma password", "pw");
    fireEvent.click(screen.getByRole("button", { name: "Approve and send" }));
    await waitFor(() => expect(api.evm).toHaveBeenCalled());
    expect(api.evm.mock.calls[0][0]).toMatchObject({ from: FROM_E, to: TO_E, amountWei: "12345678901234567", password: "pw" });
    expect(await screen.findByRole("link", { name: /explorer/ })).toHaveAttribute("href", "https://sepolia.etherscan.io/tx/0xfeed");
    api.list.mockResolvedValue([{ id: "1", from: FROM_E, to: TO_E, amountWei: "12345678901234567", hash: "0xfeed", state: "confirmed" }]);
    fireEvent.click(screen.getByRole("button", { name: "Refresh status" }));
    expect(await screen.findByText("Status: Confirmed")).toBeInTheDocument();
  });

  it("refuses an amount too large for the server", () => {
    render(<CustodySendForm chain="evm" from={FROM_E} />);
    fill(/Send to/, TO_E); fill(/Amount/, "1".repeat(25));
    fireEvent.click(screen.getByRole("button", { name: "Review" }));
    expect(screen.getByRole("alert")).toHaveTextContent("22 digits");
  });

  it("refuses an amount with more than 18 decimals instead of rounding", () => {
    render(<CustodySendForm chain="evm" from={FROM_E} />);
    fill(/Send to/, TO_E); fill(/Amount/, "0.0000000000000000001");
    fireEvent.click(screen.getByRole("button", { name: "Review" }));
    expect(screen.getByRole("alert")).toHaveTextContent("at most 18 decimals");
  });
});

describe("ETH send form network labels", () => {
  const toReview = () => { fill(/Send to/, TO_E); fill(/Amount/, "0.01"); fireEvent.click(screen.getByRole("button", { name: "Review" })); };
  it("titles the Ethereum form Send Sepolia ETH and shows no Real ETH badge on a testnet build", () => {
    render(<CustodySendForm chain="evm" from={FROM_E} />);
    expect(screen.getByRole("heading", { name: "Send Sepolia ETH" })).toBeInTheDocument();
    toReview();
    expect(screen.queryByText("Real ETH")).toBeNull();
  });
  it("titles the Ethereum form Send Ethereum (real ETH) and shows a Real ETH badge at review on a mainnet build", () => {
    vi.stubEnv("VITE_MAINNET_CUSTODY", "on");
    render(<CustodySendForm chain="evm" from={FROM_E} />);
    expect(screen.getByRole("heading", { name: "Send Ethereum (real ETH)" })).toBeInTheDocument();
    toReview();
    expect(screen.getByText("Real ETH")).toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/sepolia|testnet/i);
  });
  it("shows real ETH when the server says the wallet is on ethereum, even on a testnet build", () => {
    render(<CustodySendForm chain="evm" from={FROM_E} network="ethereum" />);
    expect(screen.getByRole("heading", { name: "Send Ethereum (real ETH)" })).toBeInTheDocument();
    toReview();
    expect(screen.getByText("Real ETH")).toBeInTheDocument();
  });
});
