import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";

const api = vi.hoisted(() => ({ evm: vi.fn(), preview: vi.fn() }));
vi.mock("../lib/custody-send", async (orig) => ({ ...(await orig<typeof import("../lib/custody-send")>()), sendCustodyEvm: api.evm, listCustodyEvmTransfers: vi.fn() }));
vi.mock("../lib/eth-server-data", async (orig) => ({ ...(await orig<typeof import("../lib/eth-server-data")>()), previewEvmSend: api.preview }));
import { CustodySendForm } from "./CustodySendForm";

const FROM = "0xAAAA000000000000000000000000000000000000";
const TO = "0x1111111111111111111111111111111111111111";
beforeEach(() => { api.evm.mockReset(); api.preview.mockReset(); });
const fill = (label: string | RegExp, value: string) => fireEvent.change(screen.getByLabelText(label), { target: { value } });
const review = () => { fill(/Send to/, TO); fill(/Amount/, "0.5"); fireEvent.click(screen.getByRole("button", { name: "Review" })); };

describe("Ethereum send preview (server)", () => {
  it("asks the server to simulate the exact payment and shows the result before the password prompt", async () => {
    api.preview.mockResolvedValue({ changes: [{ asset: "ETH", direction: "out", amount: "0.5" }], gasEstimateWei: "42000000000000", warnings: [] });
    render(<CustodySendForm chain="evm" from={FROM} serverPreview />);
    review();
    expect(await screen.findByLabelText("Payment preview")).toHaveTextContent("Leaves your wallet: 0.5 ETH");
    expect(screen.getByLabelText("Payment preview")).toHaveTextContent("about 0.000042 ETH");
    expect(api.preview).toHaveBeenCalledWith({ from: FROM, to: TO, amountWei: "500000000000000000" });
    expect(screen.getByLabelText("Your Amma password")).toBeInTheDocument();
    expect(api.evm).not.toHaveBeenCalled();
  });

  it("shows each warning prominently and still lets the user decide", async () => {
    api.preview.mockResolvedValue({ changes: [{ asset: "ETH", direction: "out", amount: "0.5" }, { asset: "USDC", direction: "out", amount: "100" }], gasEstimateWei: null, warnings: ["This would also move 100 USDC out of your wallet."] });
    render(<CustodySendForm chain="evm" from={FROM} serverPreview />);
    review();
    expect(await screen.findByText("This would also move 100 USDC out of your wallet.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Approve and send" })).toBeInTheDocument();
  });

  it("says it was not simulated when the preview fails, and the send still works", async () => {
    api.preview.mockRejectedValue(new Error("down"));
    api.evm.mockResolvedValue({ state: "broadcast", hash: "0xabc" });
    render(<CustodySendForm chain="evm" from={FROM} serverPreview />);
    review();
    expect(await screen.findByText(/It was not simulated/)).toBeInTheDocument();
    fill("Your Amma password", "pw");
    fireEvent.click(screen.getByRole("button", { name: "Approve and send" }));
    await waitFor(() => expect(api.evm).toHaveBeenCalled());
  });

  it("does not call the server when the preview is off (default) or for an invalid address", async () => {
    render(<CustodySendForm chain="evm" from={FROM} />);
    review();
    expect(screen.getByLabelText("Your Amma password")).toBeInTheDocument();
    expect(screen.queryByLabelText("Payment preview")).toBeNull();
    expect(api.preview).not.toHaveBeenCalled();
  });
  it("does not preview a payment that fails the local checks", async () => {
    render(<CustodySendForm chain="evm" from={FROM} serverPreview />);
    fill(/Send to/, "nope"); fill(/Amount/, "1");
    fireEvent.click(screen.getByRole("button", { name: "Review" }));
    expect(await screen.findByText(/valid Ethereum address/)).toBeInTheDocument();
    expect(api.preview).not.toHaveBeenCalled();
  });
});
