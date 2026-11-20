import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent, waitFor, act } from "@testing-library/react";

const m = vi.hoisted(() => ({ list: vi.fn(), sign: vi.fn(), deviceSign: vi.fn() }));
vi.mock("../lib/custody-wallets", () => ({ listCustodyWallets: m.list, signLmsClaimWithAmma: m.sign }));
vi.mock("../lib/lmsClaim", async (orig) => ({ ...(await orig<typeof import("../lib/lmsClaim")>()), signLmsClaim: m.deviceSign }));
import { useWalletStore } from "../store/wallet";
import { LMS_CLAIM_PREFIX } from "../lib/lmsClaim";
import LmsClaimSign from "./LmsClaimSign";

const DEST = "GBRPYHIL2CI3FNQ4BXLFMNDLFJUNPU2HY3ZMFSHONUCEOASW7QC7OX2H";
const message = [LMS_CLAIM_PREFIX, "claim:0c6b7a3e-1d2f-4a5b-8c9d-0e1f2a3b4c5d", `destination:${DEST}`, "amount_stroops:1000000", `expires:${new Date(Date.now() + 600_000).toISOString()}`, `nonce:${"a".repeat(64)}`].join("\n");
const b64url = (s: string) => btoa(String.fromCharCode(...new TextEncoder().encode(s))).replace(/\+/g, "-").replace(/\//g, "_");
const RETURN = "https://lms.smwebsystems.com/student/rewards/claim";
let assign: ReturnType<typeof vi.fn>;
const original = window.location;

beforeEach(() => {
  Object.values(m).forEach((f) => f.mockReset());
  assign = vi.fn();
  Object.defineProperty(window, "location", { configurable: true, value: { hash: `#message=${b64url(message)}&return=${encodeURIComponent(RETURN)}`, assign } });
  useWalletStore.setState({ accounts: [] } as never);
});
afterEach(() => Object.defineProperty(window, "location", { configurable: true, value: original }));

const returned = () => new URLSearchParams(new URL(assign.mock.calls[0][0]).hash.slice(1));

describe("LmsClaimSign", () => {
  it("disables Approve with 'Checking your wallet…' while it looks for an Amma-held wallet", async () => {
    let resolve!: (v: unknown) => void;
    m.list.mockReturnValue(new Promise((r) => { resolve = r; }));
    render(<LmsClaimSign />);
    expect(screen.getByRole("button", { name: /Checking your wallet/ })).toBeDisabled();
    expect(screen.queryByLabelText("Your Amma password")).toBeNull();
    resolve([]);
    await waitFor(() => expect(screen.queryByText(/Checking your wallet/)).toBeNull());
    expect(screen.getByLabelText("Wallet passphrase")).toBeInTheDocument();
  });

  it("asks for the Amma password when the destination is an Amma-held Stellar wallet, posts it, and returns the signature to the LMS", async () => {
    m.list.mockResolvedValue([{ chain: "xrpl", network: "testnet", address: "rX", name: "x", index: 0, active: true }, { chain: "stellar", network: "testnet", address: DEST, name: "Main", index: 0, active: true }]);
    m.sign.mockResolvedValue("SIG==");
    render(<LmsClaimSign />);
    const input = await screen.findByLabelText("Your Amma password");
    expect(input).toHaveAttribute("type", "password");
    expect(input).toHaveAttribute("autocomplete", "current-password");
    expect(screen.queryByLabelText("Wallet passphrase")).toBeNull();
    fireEvent.change(input, { target: { value: "hunter2!" } });
    fireEvent.click(screen.getByRole("button", { name: "Approve" }));
    await waitFor(() => expect(assign).toHaveBeenCalled());
    expect(m.sign).toHaveBeenCalledWith(message, "hunter2!");
    expect(m.deviceSign).not.toHaveBeenCalled();
    expect(new URL(assign.mock.calls[0][0]).origin).toBe("https://lms.smwebsystems.com");
    expect(Object.fromEntries(returned())).toEqual({ claim: "0c6b7a3e-1d2f-4a5b-8c9d-0e1f2a3b4c5d", signature: "SIG==" });
  });

  it.each([
    ["wrong password", "That password is not correct.", /not correct/],
    ["too many tries", "Too many wrong passwords. Try again in 15 minutes.", /Too many/],
    ["frozen", "This account is frozen while a recovery request is waiting.", /frozen/],
    ["switched off", "Approving with your Amma password is not switched on here yet.", /can't approve this claim right now\. Go back to the LMS/],
    ["bare 503", "API error 503", /can't approve this claim right now\. Go back to the LMS/],
  ])("shows %s in plain English and clears the password", async (_n, serverText, shown) => {
    m.list.mockResolvedValue([{ chain: "stellar", network: "testnet", address: DEST, name: "Main", index: 0, active: true }]);
    m.sign.mockRejectedValue(new Error(serverText));
    render(<LmsClaimSign />);
    fireEvent.change(await screen.findByLabelText("Your Amma password"), { target: { value: "pw" } });
    fireEvent.click(screen.getByRole("button", { name: "Approve" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(shown);
    expect(screen.getByLabelText("Your Amma password")).toHaveValue("");
    expect(assign).not.toHaveBeenCalled();
  });

  it("explains a bare status error instead of showing 'API error 429'", async () => {
    m.list.mockResolvedValue([{ chain: "stellar", network: "testnet", address: DEST, name: "Main", index: 0, active: true }]);
    m.sign.mockRejectedValue(new Error("API error 429"));
    render(<LmsClaimSign />);
    fireEvent.change(await screen.findByLabelText("Your Amma password"), { target: { value: "pw" } });
    fireEvent.click(screen.getByRole("button", { name: "Approve" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Too many tries in a minute. Wait a minute, then try again.");
  });

  it("keeps the device path when the destination is not an Amma-held wallet", async () => {
    m.list.mockResolvedValue([{ chain: "stellar", network: "testnet", address: "GOTHER", name: "Main", index: 0, active: true }]);
    m.deviceSign.mockResolvedValue("DEVICESIG==");
    render(<LmsClaimSign />);
    const input = await screen.findByLabelText("Wallet passphrase");
    expect(screen.queryByLabelText("Your Amma password")).toBeNull();
    fireEvent.change(input, { target: { value: "device pass" } });
    fireEvent.click(screen.getByRole("button", { name: "Approve" }));
    await waitFor(() => expect(assign).toHaveBeenCalled());
    expect(m.deviceSign.mock.calls[0][0]).toBe(message);
    expect(m.deviceSign.mock.calls[0][2]).toBe("device pass");
    expect(m.sign).not.toHaveBeenCalled();
    expect(returned().get("signature")).toBe("DEVICESIG==");
  });

  it("falls back to the device path when the wallet list is unavailable (self-custody or custody off)", async () => {
    m.list.mockRejectedValue(new Error("You keep your own keys"));
    render(<LmsClaimSign />);
    expect(await screen.findByLabelText("Wallet passphrase")).toBeInTheDocument();
    expect(screen.queryByLabelText("Your Amma password")).toBeNull();
  });

  it.each([
    ["403 not an Amma-held wallet", "That is not one of your Amma-held wallets."],
    ["409 cannot sign", "Amma can't sign for this wallet. Use your wallet passphrase."],
    ["409 own keys", "You keep your own keys, so Amma does not sign for you. Use your wallet passphrase."],
  ])("switches to the device passphrase with a note after %s", async (_n, serverText) => {
    m.list.mockResolvedValue([{ chain: "stellar", network: "testnet", address: DEST, name: "Main", index: 0, active: true }]);
    m.sign.mockRejectedValue(new Error(serverText));
    m.deviceSign.mockResolvedValue("DEVICESIG==");
    render(<LmsClaimSign />);
    fireEvent.change(await screen.findByLabelText("Your Amma password"), { target: { value: "pw" } });
    fireEvent.click(screen.getByRole("button", { name: "Approve" }));
    const input = await screen.findByLabelText("Wallet passphrase");
    expect(screen.queryByLabelText("Your Amma password")).toBeNull();
    expect(screen.getByRole("status")).toHaveTextContent(/wallet passphrase/i);
    expect(input).toHaveValue("");
    fireEvent.change(input, { target: { value: "device pass" } });
    fireEvent.click(screen.getByRole("button", { name: "Approve" }));
    await waitFor(() => expect(assign).toHaveBeenCalled());
    expect(m.deviceSign.mock.calls[0][2]).toBe("device pass");
    expect(returned().get("signature")).toBe("DEVICESIG==");
  });

  it("does not switch paths on a wrong password", async () => {
    m.list.mockResolvedValue([{ chain: "stellar", network: "testnet", address: DEST, name: "Main", index: 0, active: true }]);
    m.sign.mockRejectedValue(new Error("That password is not correct."));
    render(<LmsClaimSign />);
    fireEvent.change(await screen.findByLabelText("Your Amma password"), { target: { value: "pw" } });
    fireEvent.click(screen.getByRole("button", { name: "Approve" }));
    await screen.findByRole("alert");
    expect(screen.getByLabelText("Your Amma password")).toBeInTheDocument();
  });
});

const AMMA = [{ chain: "stellar", network: "testnet", address: DEST, name: "Main", index: 0, active: true }];
const EXPIRED_TEXT = "This claim expired. Go back to the LMS and start a new one.";
function openWith(msg: string, ret = RETURN) {
  Object.defineProperty(window, "location", { configurable: true, value: { hash: `#message=${b64url(msg)}&return=${encodeURIComponent(ret)}`, assign } });
}
const expiringIn = (ms: number) => message.replace(/^expires:.*$/m, `expires:${new Date(Date.now() + ms).toISOString()}`);
const linkFragment = () => Object.fromEntries(new URLSearchParams(new URL(screen.getByRole("link", { name: "Back to the LMS" }).getAttribute("href")!).hash.slice(1)));
async function approveWithAmma() {
  fireEvent.change(await screen.findByLabelText("Your Amma password"), { target: { value: "pw" } });
  fireEvent.click(screen.getByRole("button", { name: "Approve" }));
  return screen.findByRole("alert");
}

describe("LmsClaimSign: one term for the password", () => {
  it("says 'Your Amma password' everywhere for an Amma-held wallet and never 'passphrase'", async () => {
    m.list.mockResolvedValue(AMMA);
    render(<LmsClaimSign />);
    const field = await screen.findByLabelText("Your Amma password");
    expect(field).toHaveAttribute("autocomplete", "current-password");
    expect(field).toHaveAttribute("name", "password");
    expect(document.body.textContent).not.toMatch(/passphrase/i);
    expect(screen.getByText(/password you use to sign in to Amma/i)).toBeInTheDocument();
  });

  it("keeps 'Wallet passphrase' for a device-only wallet and labels it as a different secret", async () => {
    m.list.mockResolvedValue([]);
    render(<LmsClaimSign />);
    const field = await screen.findByLabelText("Wallet passphrase");
    expect(field).toHaveAttribute("autocomplete", "off");
    expect(screen.queryByLabelText("Your Amma password")).toBeNull();
    expect(screen.getByText(/kept only on this device/i)).toHaveTextContent(/not your Amma password/i);
  });
});

describe("LmsClaimSign: Approve while the password is empty", () => {
  it("is disabled with a visible reason, then enabled once something is typed (Amma password)", async () => {
    m.list.mockResolvedValue(AMMA);
    render(<LmsClaimSign />);
    const field = await screen.findByLabelText("Your Amma password");
    const approve = screen.getByRole("button", { name: "Approve" });
    expect(approve).toBeDisabled();
    const reason = screen.getByText("Enter your Amma password to approve.");
    expect(approve).toHaveAccessibleDescription("Enter your Amma password to approve.");
    expect(reason).toBeVisible();
    fireEvent.change(field, { target: { value: "x" } });
    expect(approve).toBeEnabled();
    expect(screen.queryByText("Enter your Amma password to approve.")).toBeNull();
  });

  it("names the wallet passphrase for a device-only wallet", async () => {
    m.list.mockResolvedValue([]);
    render(<LmsClaimSign />);
    await waitFor(() => expect(screen.getByLabelText("Wallet passphrase")).toBeEnabled());
    expect(screen.getByRole("button", { name: "Approve" })).toBeDisabled();
    expect(screen.getByText("Enter your wallet passphrase to approve.")).toBeVisible();
  });
});

describe("LmsClaimSign: expiry", () => {
  afterEach(() => vi.useRealTimers());

  it("shows a countdown that ticks down", () => {
    vi.useFakeTimers();
    openWith(expiringIn(125_000));
    m.list.mockReturnValue(new Promise(() => {}));
    render(<LmsClaimSign />);
    expect(screen.getByTestId("claim-countdown")).toHaveTextContent("2:05 left");
    act(() => { vi.advanceTimersByTime(5_000); });
    expect(screen.getByTestId("claim-countdown")).toHaveTextContent("2:00 left");
  });

  it("replaces the form with the expired message and a Back to the LMS link when the time runs out", () => {
    vi.useFakeTimers();
    openWith(expiringIn(3_000));
    m.list.mockResolvedValue(AMMA);
    render(<LmsClaimSign />);
    expect(screen.getByRole("form", { name: "Reward claim" })).toBeInTheDocument();
    act(() => { vi.advanceTimersByTime(4_000); });
    expect(screen.getByRole("alert")).toHaveTextContent(EXPIRED_TEXT);
    expect(linkFragment()).toEqual({ claim: "0c6b7a3e-1d2f-4a5b-8c9d-0e1f2a3b4c5d", error: "expired" });
    expect(screen.queryByRole("button", { name: "Approve" })).toBeNull();
  });

  it("shows the expired message and a Back to the LMS link when the claim is already expired and the return URL is valid", () => {
    openWith(expiringIn(-60_000));
    render(<LmsClaimSign />);
    expect(screen.getByRole("alert")).toHaveTextContent(EXPIRED_TEXT);
    const link = screen.getByRole("link", { name: "Back to the LMS" });
    expect(link.getAttribute("href")!.startsWith(RETURN + "#")).toBe(true);
    expect(screen.queryByRole("form", { name: "Reward claim" })).toBeNull();
    expect(m.list).not.toHaveBeenCalled();
    expect(assign).not.toHaveBeenCalled();
  });

  it("offers the same link to the LMS app's return address", () => {
    openWith(expiringIn(-60_000), "lmsmobile://reward-claim");
    render(<LmsClaimSign />);
    expect(screen.getByRole("link", { name: "Back to the LMS" }).getAttribute("href")!.startsWith("lmsmobile://reward-claim#")).toBe(true);
  });

  it("shows no link when the return URL is not allowed", () => {
    openWith(expiringIn(-60_000), "https://lms.example.invalid/claim");
    render(<LmsClaimSign />);
    expect(screen.getByRole("alert")).toHaveTextContent(EXPIRED_TEXT);
    expect(screen.queryByRole("link", { name: "Back to the LMS" })).toBeNull();
  });

  it("never puts a signature or password in the link, only claim and a fixed error value", () => {
    openWith(expiringIn(-60_000));
    render(<LmsClaimSign />);
    const href = screen.getByRole("link", { name: "Back to the LMS" }).getAttribute("href")!;
    expect(href).not.toMatch(/signature|password|declined/);
    expect(Object.keys(linkFragment()).sort()).toEqual(["claim", "error"]);
  });

  it("offers the link when the server says the claim is no longer valid", async () => {
    m.list.mockResolvedValue(AMMA);
    m.sign.mockRejectedValue(new Error("This is not a valid LMS reward claim."));
    render(<LmsClaimSign />);
    expect(await approveWithAmma()).toHaveTextContent(EXPIRED_TEXT);
    expect(linkFragment()).toEqual({ claim: "0c6b7a3e-1d2f-4a5b-8c9d-0e1f2a3b4c5d", error: "expired" });
  });

  it("offers the link when the device path finds the claim expired", async () => {
    m.list.mockResolvedValue([]);
    m.deviceSign.mockRejectedValue(new Error("This claim has expired. Start a new claim in the LMS."));
    render(<LmsClaimSign />);
    await waitFor(() => expect(screen.getByLabelText("Wallet passphrase")).toBeEnabled());
    fireEvent.change(screen.getByLabelText("Wallet passphrase"), { target: { value: "device pass" } });
    fireEvent.click(screen.getByRole("button", { name: "Approve" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(EXPIRED_TEXT);
    expect(screen.getByRole("link", { name: "Back to the LMS" })).toBeInTheDocument();
  });

  it("keeps a malformed claim's own sentence and still offers the way back", () => {
    openWith("not a claim");
    render(<LmsClaimSign />);
    expect(screen.getByRole("alert")).toHaveTextContent("This is not an LMS reward claim.");
    expect(screen.getByRole("link", { name: "Back to the LMS" })).toBeInTheDocument();
  });
});

describe("LmsClaimSign: plain 429 and 503 text", () => {
  it("explains a 503 with a next step and a way back, without sending anything to the LMS", async () => {
    m.list.mockResolvedValue(AMMA);
    m.sign.mockRejectedValue(new Error("Approving with your Amma password is not switched on here yet."));
    render(<LmsClaimSign />);
    expect(await approveWithAmma()).toHaveTextContent(/^Amma can't approve this claim right now\. Go back to the LMS and try again later\.$/);
    expect(linkFragment()).toEqual({ claim: "0c6b7a3e-1d2f-4a5b-8c9d-0e1f2a3b4c5d", error: "unavailable" });
    expect(assign).not.toHaveBeenCalled();
  });

  it("turns the global rate-limit text into a one-minute wait with no link", async () => {
    m.list.mockResolvedValue(AMMA);
    m.sign.mockRejectedValue(new Error("Too many requests. Please slow down."));
    render(<LmsClaimSign />);
    expect(await approveWithAmma()).toHaveTextContent(/^Too many tries in a minute\. Wait a minute, then try again\.$/);
    expect(screen.queryByRole("link", { name: "Back to the LMS" })).toBeNull();
  });

  it("keeps the server's 15-minute password-lock sentence", async () => {
    m.list.mockResolvedValue(AMMA);
    m.sign.mockRejectedValue(new Error("Too many wrong passwords. Try again in 15 minutes."));
    render(<LmsClaimSign />);
    expect(await approveWithAmma()).toHaveTextContent(/^Too many wrong passwords\. Try again in 15 minutes\.$/);
  });
});

describe("LmsClaimSign: returns to the LMS are unchanged", () => {
  it("Decline still returns claim + declined=1 and Approve claim + signature, nothing else", async () => {
    m.list.mockResolvedValue(AMMA);
    m.sign.mockResolvedValue("SIG==");
    const { unmount } = render(<LmsClaimSign />);
    await screen.findByLabelText("Your Amma password");
    fireEvent.click(screen.getByRole("button", { name: "Decline" }));
    expect(Object.fromEntries(returned())).toEqual({ claim: "0c6b7a3e-1d2f-4a5b-8c9d-0e1f2a3b4c5d", declined: "1" });
    unmount(); assign.mockClear();
    render(<LmsClaimSign />);
    fireEvent.change(await screen.findByLabelText("Your Amma password"), { target: { value: "pw" } });
    fireEvent.click(screen.getByRole("button", { name: "Approve" }));
    await waitFor(() => expect(assign).toHaveBeenCalled());
    expect(Object.fromEntries(returned())).toEqual({ claim: "0c6b7a3e-1d2f-4a5b-8c9d-0e1f2a3b4c5d", signature: "SIG==" });
  });
});

describe("LmsClaimSign: expiry edge cases", () => {
  afterEach(() => vi.useRealTimers());

  it("ends the expired sentence with a full stop", () => {
    openWith(expiringIn(-60_000));
    render(<LmsClaimSign />);
    expect(screen.getByRole("alert").textContent).toBe("This claim expired. Go back to the LMS and start a new one.");
  });

  it("sends no password when the clock has passed expiry but the 1-second tick has not run yet", async () => {
    vi.useFakeTimers();
    openWith(expiringIn(3_000));
    m.list.mockResolvedValue(AMMA);
    render(<LmsClaimSign />);
    await act(async () => { await Promise.resolve(); });
    fireEvent.change(screen.getByLabelText("Your Amma password"), { target: { value: "pw" } });
    vi.setSystemTime(Date.now() + 4_000);
    fireEvent.click(screen.getByRole("button", { name: "Approve" }));
    expect(m.sign).not.toHaveBeenCalled();
    expect(m.deviceSign).not.toHaveBeenCalled();
  });

  it("drops any fragment from the return URL in the Back to the LMS link", () => {
    openWith(expiringIn(-60_000), RETURN + "#token=abc&x=1");
    render(<LmsClaimSign />);
    expect(linkFragment()).toEqual({ claim: "0c6b7a3e-1d2f-4a5b-8c9d-0e1f2a3b4c5d", error: "expired" });
  });
});

describe("LmsClaimSign: the real expired-claim case", () => {
  afterEach(() => vi.useRealTimers());

  it("sends no request when Approve is pressed after the clock passed expiry (page loaded while valid)", async () => {
    vi.useFakeTimers();
    openWith(expiringIn(60_000));
    m.list.mockResolvedValue(AMMA);
    render(<LmsClaimSign />);
    await act(async () => { await Promise.resolve(); });
    fireEvent.change(screen.getByLabelText("Your Amma password"), { target: { value: "pw" } });
    vi.setSystemTime(Date.now() + 61_000);
    fireEvent.click(screen.getByRole("button", { name: "Approve" }));
    expect(m.sign).not.toHaveBeenCalled();
  });

  it("shows the expired state when the server answers claim_expired, whatever its text says", async () => {
    m.list.mockResolvedValue(AMMA);
    m.sign.mockRejectedValue(Object.assign(new Error("Some other server wording"), { code: "claim_expired" }));
    render(<LmsClaimSign />);
    expect(await approveWithAmma()).toHaveTextContent(EXPIRED_TEXT);
    expect(screen.queryByRole("button", { name: "Approve" })).toBeNull();
    expect(screen.queryByLabelText("Your Amma password")).toBeNull();
    expect(linkFragment()).toEqual({ claim: "0c6b7a3e-1d2f-4a5b-8c9d-0e1f2a3b4c5d", error: "expired" });
  });

  it("removes the form after the server's plain 'not a valid claim' answer too", async () => {
    m.list.mockResolvedValue(AMMA);
    m.sign.mockRejectedValue(new Error("This is not a valid LMS reward claim."));
    render(<LmsClaimSign />);
    await approveWithAmma();
    expect(screen.queryByRole("button", { name: "Approve" })).toBeNull();
  });
});

describe("LmsClaimSign: network label", () => {
  const open = (msg: string) => Object.defineProperty(window, "location", { configurable: true, value: { hash: `#message=${b64url(msg)}&return=${encodeURIComponent(RETURN)}`, assign } });
  afterEach(() => useWalletStore.setState({ network: "public" } as never));

  it("shows Mainnet next to the amount when the app is on the public network", () => {
    useWalletStore.setState({ network: "public" } as never);
    m.list.mockResolvedValue([]);
    render(<LmsClaimSign />);
    expect(screen.getByTestId("claim-network")).toHaveTextContent("Mainnet");
    expect(screen.getByTestId("claim-amount").parentElement).toContainElement(screen.getByTestId("claim-network"));
  });

  it("shows Testnet when the app is on testnet", () => {
    useWalletStore.setState({ network: "testnet" } as never);
    m.list.mockResolvedValue([]);
    render(<LmsClaimSign />);
    expect(screen.getByTestId("claim-network")).toHaveTextContent("Testnet");
  });

  it("does not block Approve for today's claim text, which names no network", async () => {
    useWalletStore.setState({ network: "public" } as never);
    m.list.mockResolvedValue([]);
    render(<LmsClaimSign />);
    fireEvent.change(await screen.findByLabelText("Wallet passphrase"), { target: { value: "pw" } });
    expect(screen.getByRole("button", { name: "Approve" })).toBeEnabled();
  });

  it("warns and disables Approve when a signed network line disagrees with the app's network", async () => {
    useWalletStore.setState({ network: "public" } as never);
    open(message + "\nnetwork:testnet");
    m.list.mockResolvedValue([]);
    render(<LmsClaimSign />);
    expect(screen.getByRole("alert")).toHaveTextContent("This claim is for Testnet, but this wallet is on Mainnet.");
    fireEvent.change(await screen.findByLabelText("Wallet passphrase"), { target: { value: "pw" } });
    expect(screen.getByRole("button", { name: "Approve" })).toBeDisabled();
  });

  it("approves normally when a signed network line matches", async () => {
    useWalletStore.setState({ network: "testnet" } as never);
    open(message + "\nnetwork:testnet");
    m.list.mockResolvedValue([]);
    m.deviceSign.mockResolvedValue("SIG==");
    render(<LmsClaimSign />);
    expect(screen.queryByRole("alert")).toBeNull();
    fireEvent.change(await screen.findByLabelText("Wallet passphrase"), { target: { value: "pw" } });
    fireEvent.click(screen.getByRole("button", { name: "Approve" }));
    await waitFor(() => expect(assign).toHaveBeenCalled());
    // The signed text is passed through untouched, network line included.
    expect(m.deviceSign.mock.calls[0][0]).toBe(message + "\nnetwork:testnet");
  });
});

describe("LmsClaimSign: network mismatch is a blocking, explained state", () => {
  const open = (msg: string) => Object.defineProperty(window, "location", { configurable: true, value: { hash: `#message=${b64url(msg)}&return=${encodeURIComponent(RETURN)}`, assign } });
  afterEach(() => useWalletStore.setState({ network: "public" } as never));

  it("names the mismatch as the reason Approve is off, even with a password typed", async () => {
    useWalletStore.setState({ network: "public" } as never);
    open(message + "\nnetwork:testnet");
    m.list.mockResolvedValue([]);
    render(<LmsClaimSign />);
    fireEvent.change(await screen.findByLabelText("Wallet passphrase"), { target: { value: "pw" } });
    const approve = screen.getByRole("button", { name: "Approve" });
    expect(approve).toBeDisabled();
    expect(approve).toHaveAccessibleDescription(/for Testnet.*on Mainnet/);
  });

  it("does not sign when the form is submitted despite the mismatch", async () => {
    useWalletStore.setState({ network: "public" } as never);
    open(message + "\nnetwork:testnet");
    m.list.mockResolvedValue([]);
    render(<LmsClaimSign />);
    fireEvent.change(await screen.findByLabelText("Wallet passphrase"), { target: { value: "pw" } });
    fireEvent.submit(screen.getByRole("form", { name: "Reward claim" }));
    expect(m.deviceSign).not.toHaveBeenCalled();
    expect(assign).not.toHaveBeenCalled();
  });
});
