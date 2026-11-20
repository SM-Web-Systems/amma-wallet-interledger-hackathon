// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";

const api = vi.hoisted(() => ({
  status: vi.fn(), sendCode: vi.fn(), start: vi.fn(), cancel: vi.fn(), complete: vi.fn(),
}));
const store = vi.hoisted(() => ({ reset: vi.fn() }));
vi.mock("../lib/api", () => ({ keyRecoveryApi: { status: api.status, sendCode: api.sendCode, start: api.start, cancel: api.cancel, complete: api.complete, cancelByToken: vi.fn() } }));
vi.mock("../store/wallet", () => ({ useWalletStore: (sel: (s: unknown) => unknown) => sel({ resetPassphraseFromPhrase: store.reset }) }));
vi.mock("sonner", () => ({ toast: { error: vi.fn(), success: vi.fn() } }));

import RecoverWalletPage from "./RecoverWallet";

let root: Root;
const PHRASE = "illness spike retreat truth genius clock brain pass fit cave bargain toe";
const text = () => document.body.textContent ?? "";
const button = (label: string | RegExp) => [...document.querySelectorAll("button")].find((b) => (typeof label === "string" ? b.textContent === label : label.test(b.textContent ?? "")))!;
async function type(label: string, value: string) {
  const el = document.querySelector(`input[aria-label="${label}"]`) as HTMLInputElement;
  const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  await act(async () => { set.call(el, value); el.dispatchEvent(new Event("input", { bubbles: true })); });
}
const click = async (label: string | RegExp) => act(async () => { button(label).click(); });
async function open() {
  await act(async () => root.render(<MemoryRouter><RecoverWalletPage /></MemoryRouter>));
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  document.body.innerHTML = '<div id="root"></div>';
  root = createRoot(document.getElementById("root")!);
  api.status.mockResolvedValue({ enabled: true, state: "none" });
  api.sendCode.mockResolvedValue({ sent: true });
  api.start.mockResolvedValue({ state: "waiting", readyAt: new Date(Date.now() + 48 * 3600_000).toISOString() });
  api.cancel.mockResolvedValue({ cancelled: true });
  api.complete.mockResolvedValue({ phrase: PHRASE });
  store.reset.mockResolvedValue({ updated: 1, serverSynced: true });
});
afterEach(async () => { await act(async () => root.unmount()); vi.unstubAllGlobals(); });

describe("recover my wallet", () => {
  it("explains the wait before asking for anything", async () => {
    await open();
    expect(text()).toContain("48 hours");
    expect(text()).toMatch(/cancel/i);
    expect(api.sendCode).not.toHaveBeenCalled();
  });

  it("says so when recovery is not switched on", async () => {
    api.status.mockResolvedValue({ enabled: false, state: "none" });
    await open();
    expect(text()).toMatch(/not available/i);
    expect(button("Email me a code")).toBeUndefined();
  });

  it("emails a code, then starts recovery with the password and the code", async () => {
    await open();
    await click("Email me a code");
    expect(api.sendCode).toHaveBeenCalledTimes(1);
    await type("Account password", "my account password");
    await type("6 digit code", "123456");
    await click("Start recovery");
    expect(api.start).toHaveBeenCalledWith("my account password", "123456");
    expect(text()).toMatch(/waiting/i);
  });

  it("shows when it can finish and lets the owner cancel while waiting", async () => {
    api.status.mockResolvedValue({ enabled: true, state: "waiting", readyAt: new Date(Date.now() + 3600_000).toISOString() });
    await open();
    expect(text()).toMatch(/can finish after/i);
    await click("Cancel recovery");
    expect(api.cancel).toHaveBeenCalledTimes(1);
  });

  it("asks for a new passphrase before it opens anything, then sets it from the recovered phrase", async () => {
    api.status.mockResolvedValue({ enabled: true, state: "ready", readyAt: new Date(Date.now() - 1000).toISOString() });
    await open();
    await type("Account password", "my account password");
    await type("New wallet passphrase", "short");
    await type("Repeat new wallet passphrase", "short");
    await click("Finish recovery");
    expect(api.complete).not.toHaveBeenCalled(); // a weak passphrase stops it before the one-time phrase is released
    expect(text()).toMatch(/at least/i);

    await type("New wallet passphrase", "a brand new passphrase 42");
    await type("Repeat new wallet passphrase", "a brand new passphrase 42");
    await click("Finish recovery");
    expect(api.complete).toHaveBeenCalledWith("my account password");
    expect(store.reset).toHaveBeenCalledWith(PHRASE, "a brand new passphrase 42");
    expect(text()).toMatch(/recovered/i);
    expect(text()).not.toContain("illness");
  });

  it("does not release the phrase when the two passphrases differ", async () => {
    api.status.mockResolvedValue({ enabled: true, state: "ready", readyAt: new Date(Date.now() - 1000).toISOString() });
    await open();
    await type("Account password", "my account password");
    await type("New wallet passphrase", "a brand new passphrase 42");
    await type("Repeat new wallet passphrase", "another new passphrase 43");
    await click("Finish recovery");
    expect(api.complete).not.toHaveBeenCalled();
    expect(text()).toMatch(/do not match/i);
  });

  it("if the new passphrase cannot be set after the phrase is released, shows the phrase once so it is not lost", async () => {
    api.status.mockResolvedValue({ enabled: true, state: "ready", readyAt: new Date(Date.now() - 1000).toISOString() });
    store.reset.mockRejectedValue(new Error("browser storage failed"));
    await open();
    await type("Account password", "my account password");
    await type("New wallet passphrase", "a brand new passphrase 42");
    await type("Repeat new wallet passphrase", "a brand new passphrase 42");
    await click("Finish recovery");
    expect(text()).toContain(PHRASE);
    expect(text()).toMatch(/write.*down|keep.*safe/i);
  });
});
