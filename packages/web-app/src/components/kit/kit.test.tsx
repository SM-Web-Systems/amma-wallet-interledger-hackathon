import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { StatusChip } from "./StatusChip";
import { FieldError } from "./FieldError";
import { ReviewPanel } from "./ReviewPanel";
import { BalanceState } from "./BalanceState";
import { ReceiveCard } from "./ReceiveCard";
import { MemoryRouter } from "react-router-dom";
import type { ReactNode } from "react";
import { TONE_CLASSES, type Tone } from "../../lib/payment-display";

describe("StatusChip", () => {
  it.each(Object.keys(TONE_CLASSES) as Tone[])("renders the %s tone from the one tone map", (tone) => {
    render(<StatusChip tone={tone}>Label</StatusChip>);
    const chip = screen.getByText("Label");
    for (const cls of TONE_CLASSES[tone].split(" ")) expect(chip.className).toContain(cls);
    expect(chip.className).toContain("rounded-full");
  });
});

describe("FieldError", () => {
  it("is an alert with the id a field can point to", () => {
    render(<FieldError id="send-amount-error">Enter an amount.</FieldError>);
    const alert = screen.getByRole("alert");
    expect(alert).toHaveAttribute("id", "send-amount-error");
    expect(alert).toHaveTextContent("Enter an amount.");
    expect(alert.className).toContain("text-stellar-danger-text");
  });
  it("renders nothing for whitespace, null or false, but shows a zero", () => {
    const { container, rerender } = render(<FieldError id="x">{"   "}</FieldError>);
    expect(container).toBeEmptyDOMElement();
    rerender(<FieldError id="x">{null}</FieldError>);
    expect(container).toBeEmptyDOMElement();
    rerender(<FieldError id="x">{false}</FieldError>);
    expect(container).toBeEmptyDOMElement();
    rerender(<FieldError id="x">{0}</FieldError>);
    expect(screen.getByRole("alert")).toHaveTextContent("0");
  });
  it("renders nothing when there is no message", () => {
    const { container } = render(<FieldError id="x">{""}</FieldError>);
    expect(container).toBeEmptyDOMElement();
  });
});

describe("ReviewPanel", () => {
  const rows = [
    { label: "Amount", value: "5 XLM" },
    { label: "Destination", value: <span>GABC</span> },
  ];
  const base = { title: "Review payment", rows, backLabel: "Back", confirmLabel: "Confirm and send", busyLabel: "Sending…" };

  it("shows the title, every row as a label with its value, and focuses the title when it opens", () => {
    render(<ReviewPanel {...base} onBack={() => {}} onConfirm={() => {}} />);
    const heading = screen.getByRole("heading", { name: "Review payment" });
    expect(heading).toHaveFocus();
    expect(screen.getByText("Amount").tagName).toBe("DT");
    expect(screen.getByText("5 XLM").tagName).toBe("DD");
    expect(screen.getByText("GABC")).toBeInTheDocument();
  });
  it("calls back and confirm from its two buttons", () => {
    const onBack = vi.fn();
    const onConfirm = vi.fn();
    render(<ReviewPanel {...base} onBack={onBack} onConfirm={onConfirm} />);
    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    fireEvent.click(screen.getByRole("button", { name: "Confirm and send" }));
    expect(onBack).toHaveBeenCalledTimes(1);
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });
  it("while busy disables both buttons and shows the busy label", () => {
    render(<ReviewPanel {...base} busy onBack={() => {}} onConfirm={() => {}} />);
    expect(screen.getByRole("button", { name: "Back" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Sending…" })).toBeDisabled();
  });
  it("shows an error as an alert, and extra content such as a warning above the buttons", () => {
    render(
      <ReviewPanel {...base} error="Not enough funds." onBack={() => {}} onConfirm={() => {}}>
        <p>Check the memo.</p>
      </ReviewPanel>,
    );
    expect(screen.getByRole("alert")).toHaveTextContent("Not enough funds.");
    expect(screen.getByText("Check the memo.")).toBeInTheDocument();
  });
  it("shows no alert when there is no error", () => {
    render(<ReviewPanel {...base} onBack={() => {}} onConfirm={() => {}} />);
    expect(screen.queryByRole("alert")).toBeNull();
  });
});

describe("ReviewPanel ids", () => {
  it("uses the ids it is given for the heading and the error", () => {
    render(
      <ReviewPanel
        title="Review"
        rows={[]}
        error="Failed."
        titleId="my-title"
        errorId="my-error"
        backLabel="Back"
        confirmLabel="Go"
        busyLabel="…"
        onBack={() => {}}
        onConfirm={() => {}}
      />,
    );
    expect(screen.getByRole("heading")).toHaveAttribute("id", "my-title");
    expect(screen.getByRole("alert")).toHaveAttribute("id", "my-error");
  });
});

describe("BalanceState", () => {
  const labels = {
    loadFailed: "Could not load your balance.",
    loadFailedHint: "Your funds are safe.",
    retry: "Retry",
    stale: "Could not refresh. These are your last known balances.",
    empty: "Nothing here yet.",
    receive: "Receive",
  };
  const base = { labels, onRetry: () => {}, receiveHref: "/receive" };
  const wrap = (ui: ReactNode) => render(<MemoryRouter>{ui}</MemoryRouter>);

  it("shows a spinner with a name while loading, and no result text", () => {
    wrap(<BalanceState {...base} state="loading" stale={false}>list</BalanceState>);
    expect(screen.getByRole("status")).toBeInTheDocument();
    expect(screen.queryByText("list")).toBeNull();
    expect(screen.queryByText("Nothing here yet.")).toBeNull();
  });
  it("shows a failed load as an alert with Retry, never as an empty wallet", () => {
    const onRetry = vi.fn();
    wrap(<BalanceState {...base} onRetry={onRetry} state="error" stale={false}>list</BalanceState>);
    expect(screen.getByRole("alert")).toHaveTextContent("Could not load your balance.");
    expect(screen.getByText("Your funds are safe.")).toBeInTheDocument();
    expect(screen.queryByText("Nothing here yet.")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });
  it("disables Retry while a retry is running", () => {
    wrap(<BalanceState {...base} retrying state="error" stale={false}>list</BalanceState>);
    expect(screen.getByRole("button", { name: "Retry" })).toBeDisabled();
  });
  it("shows an empty account with a link to receive", () => {
    wrap(<BalanceState {...base} state="unfunded" stale={false}>list</BalanceState>);
    expect(screen.getByTestId("unfunded")).toHaveTextContent("Nothing here yet.");
    expect(screen.getByRole("link", { name: "Receive" })).toHaveAttribute("href", "/receive");
    expect(screen.queryByRole("alert")).toBeNull();
  });
  it("shows the list when ready, and a stale warning with Retry above it after a failed refresh", () => {
    wrap(<BalanceState {...base} state="ready" stale>list</BalanceState>);
    expect(screen.getByText("list")).toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent("last known balances");
    expect(screen.getByRole("button", { name: "Retry" })).toBeInTheDocument();
  });
  describe("task activation", () => {
    const activationLabels = {
      notActivated: "Not activated yet — complete an eligible task",
      activating: "Activating… This usually takes under a minute.",
      delayed: "Activation is taking longer than usual. We'll keep trying.",
      failed: "Activation didn't go through. The partner has been told and nothing was charged.",
      active: (partner: string | null) => (partner ? `Active – activated by ${partner}` : "Active"),
    };
    const withActivation = { ...base, labels: { ...labels, activation: activationLabels } };

    it("tells an unfunded Amma wallet that it is not activated yet and still offers Receive", () => {
      wrap(<BalanceState {...withActivation} state="unfunded" stale={false} activation={{ state: "not_activated" }}>list</BalanceState>);
      expect(screen.getByTestId("unfunded")).toHaveTextContent("Not activated yet — complete an eligible task");
      expect(screen.queryByText("Nothing here yet.")).toBeNull();
      expect(screen.getByRole("link", { name: "Receive" })).toHaveAttribute("href", "/receive");
    });
    it.each([
      ["activating", "Activating… This usually takes under a minute.", "status"],
      ["delayed", "Activation is taking longer than usual.", "status"],
      ["failed", "Activation didn't go through.", "status"],
    ] as const)("shows the %s copy", (state, text, role) => {
      wrap(<BalanceState {...withActivation} state="unfunded" stale={false} activation={{ state }}>list</BalanceState>);
      expect(screen.getByRole(role)).toHaveTextContent(text);
      expect(screen.getByTestId("unfunded")).toHaveAttribute("data-activation", state);
    });
    it("names the partner once the wallet is active, above the balances", () => {
      wrap(<BalanceState {...withActivation} state="ready" stale={false} activation={{ state: "active", partner: "SM Web Systems LMS" }}>list</BalanceState>);
      expect(screen.getByTestId("activated-by")).toHaveTextContent("Active – activated by SM Web Systems LMS");
      expect(screen.getByText("list")).toBeInTheDocument();
    });
    it("says plain Active when the account existed already and no partner is known", () => {
      wrap(<BalanceState {...withActivation} state="ready" stale={false} activation={{ state: "active", partner: null }}>list</BalanceState>);
      expect(screen.queryByTestId("activated-by")).toBeNull();
    });
    it("says nothing about activation while funded but not activated, while loading, and on a failed load", () => {
      for (const state of ["ready", "loading", "error"] as const) {
        const { unmount } = wrap(<BalanceState {...withActivation} state={state} stale={false} activation={{ state: "not_activated" }}>list</BalanceState>);
        expect(screen.queryByText(/Not activated yet/)).toBeNull();
        expect(screen.queryByTestId("activated-by")).toBeNull();
        unmount();
      }
    });
    it("looks exactly as before without activation info, or without activation labels", () => {
      wrap(<BalanceState {...base} state="unfunded" stale={false}>list</BalanceState>);
      expect(screen.getByTestId("unfunded")).toHaveTextContent("Nothing here yet.");
      cleanup();
      wrap(<BalanceState {...base} state="unfunded" stale={false} activation={{ state: "not_activated" }}>list</BalanceState>);
      expect(screen.getByTestId("unfunded")).toHaveTextContent("Nothing here yet.");
    });
  });
  it("shows no warning when ready and fresh", () => {
    wrap(<BalanceState {...base} state="ready" stale={false}>list</BalanceState>);
    expect(screen.queryByRole("alert")).toBeNull();
  });
});

describe("ReceiveCard", () => {
  const labels = {
    yourAddress: "Your address",
    copyAddress: "Copy address",
    copied: "Address copied",
    copyFailed: "Could not copy. Select the address and copy it by hand.",
    share: "Share",
    downloadQr: "Download QR",
    qrTitle: "QR code for this address",
  };
  const address = "GABCDEFGHIJKLMNOPQRSTUVWXYZ234567ABCDEFGHIJKLMNOPQRSTUVW";
  const setClipboard = (writeText: (t: string) => Promise<void>) =>
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
  const setShare = (share: unknown) => Object.defineProperty(navigator, "share", { value: share, configurable: true });

  afterEach(() => {
    vi.useRealTimers();
    setShare(undefined);
  });

  it("shows the QR code with its title, the full address and the network", () => {
    render(<ReceiveCard address={address} network="Stellar mainnet" labels={labels} />);
    expect(screen.getByTitle("QR code for this address")).toBeInTheDocument();
    expect(screen.getByText(address)).toBeInTheDocument();
    expect(screen.getByText("Stellar mainnet")).toBeInTheDocument();
    expect(screen.getByText("Your address")).toBeInTheDocument();
  });
  it("encodes a payment link when given one, else the address", () => {
    const { container, rerender } = render(<ReceiveCard address={address} labels={labels} />);
    const plain = container.querySelector("svg path:last-of-type")?.getAttribute("d");
    rerender(<ReceiveCard address={address} qrValue="web+stellar:pay?destination=X&amount=5" labels={labels} />);
    const link = container.querySelector("svg path:last-of-type")?.getAttribute("d");
    expect(plain).toBeTruthy();
    expect(link).not.toEqual(plain);
  });
  it("copies the address and announces it, then clears the confirmation", async () => {
    vi.useFakeTimers();
    const writeText = vi.fn().mockResolvedValue(undefined);
    setClipboard(writeText);
    render(<ReceiveCard address={address} labels={labels} />);
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Copy address" })); });
    expect(writeText).toHaveBeenCalledWith(address);
    expect(screen.getByRole("status")).toHaveTextContent("Address copied");
    await act(async () => { vi.advanceTimersByTime(2100); });
    expect(screen.getByRole("status")).toHaveTextContent("");
  });
  it("says so when the copy is refused, instead of pretending it worked", async () => {
    setClipboard(vi.fn().mockRejectedValue(new Error("denied")));
    render(<ReceiveCard address={address} labels={labels} />);
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Copy address" })); });
    expect(screen.getByRole("alert")).toHaveTextContent("Could not copy");
    expect(screen.getByRole("status")).toHaveTextContent("");
  });
  it("offers Share only when the browser can share, and shares the address", async () => {
    const { rerender } = render(<ReceiveCard address={address} labels={labels} />);
    expect(screen.queryByRole("button", { name: "Share" })).toBeNull();
    const share = vi.fn().mockResolvedValue(undefined);
    setShare(share);
    rerender(<ReceiveCard address={address} network="Stellar" labels={labels} key="again" />);
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Share" })); });
    expect(share).toHaveBeenCalledWith({ title: "Stellar", text: address });
  });
  it("ignores a cancelled share sheet", async () => {
    const share = vi.fn().mockRejectedValue(new DOMException("closed", "AbortError"));
    setShare(share);
    render(<ReceiveCard address={address} labels={labels} />);
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Share" })); });
    expect(share).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("alert")).toBeNull();
  });
  it("clears the copy error after a while, and a later good copy clears it at once", async () => {
    vi.useFakeTimers();
    const writeText = vi.fn().mockRejectedValueOnce(new Error("denied")).mockResolvedValue(undefined);
    setClipboard(writeText);
    render(<ReceiveCard address={address} labels={labels} />);
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Copy address" })); });
    expect(screen.getByRole("alert")).toBeInTheDocument();
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Copy address" })); });
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.getByRole("status")).toHaveTextContent("Address copied");
  });
  it("does not leave a timer running after it unmounts", async () => {
    vi.useFakeTimers();
    setClipboard(vi.fn().mockResolvedValue(undefined));
    const { unmount } = render(<ReceiveCard address={address} labels={labels} />);
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Copy address" })); });
    expect(vi.getTimerCount()).toBe(1);
    unmount();
    expect(vi.getTimerCount()).toBe(0);
  });
  it("gives two cards on one page different error ids", () => {
    const { container } = render(<><ReceiveCard address={address} labels={labels} qrId="a" /><ReceiveCard address={address} labels={labels} qrId="b" /></>);
    expect(container.querySelectorAll("svg#a, svg#b")).toHaveLength(2);
  });
  it("shows a memo or destination tag when the chain needs one, and the extra line under the QR", () => {
    render(
      <ReceiveCard address={address} memoOrTag={{ label: "Destination tag", value: "48213" }} labels={labels}>
        <p>XRP</p>
      </ReceiveCard>,
    );
    expect(screen.getByText("Destination tag")).toBeInTheDocument();
    expect(screen.getByText("48213")).toBeInTheDocument();
    expect(screen.getByText("XRP")).toBeInTheDocument();
  });
  it("has a Download button", () => {
    render(<ReceiveCard address={address} labels={labels} />);
    expect(screen.getByRole("button", { name: "Download QR" })).toBeInTheDocument();
  });
});
