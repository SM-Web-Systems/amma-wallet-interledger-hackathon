// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";

const api = vi.hoisted(() => ({ cancelByToken: vi.fn() }));
vi.mock("../lib/api", () => ({ keyRecoveryApi: { cancelByToken: api.cancelByToken } }));
import RecoveryCancelPage from "../pages/RecoveryCancel";

let root: Root;
const TOKEN = "a".repeat(64);
const text = () => document.body.textContent ?? "";
const button = (label: string) => [...document.querySelectorAll("button")].find((b) => b.textContent === label)!;
async function open(search = `?token=${TOKEN}`) {
  await act(async () => root.render(<MemoryRouter initialEntries={[`/recovery/cancel${search}`]}><RecoveryCancelPage /></MemoryRouter>));
}
beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  document.body.innerHTML = '<div id="root"></div>';
  root = createRoot(document.getElementById("root")!);
});
afterEach(async () => { await act(async () => root.unmount()); vi.unstubAllGlobals(); });

describe("cancel link from the recovery alert email", () => {
  it("changes nothing just by opening the link, so mail scanners cannot cancel it", async () => {
    await open();
    expect(api.cancelByToken).not.toHaveBeenCalled();
    expect(button("Yes, cancel the recovery")).toBeTruthy();
  });

  it("cancels only after the button is pressed, then confirms", async () => {
    api.cancelByToken.mockResolvedValue({ cancelled: true });
    await open();
    await act(async () => { button("Yes, cancel the recovery").click(); });
    expect(api.cancelByToken).toHaveBeenCalledWith(TOKEN);
    expect(text()).toMatch(/cancelled/i);
    expect(text()).toMatch(/change your (account )?password/i);
  });

  it("says when the link is no longer valid", async () => {
    api.cancelByToken.mockRejectedValue(new Error("That recovery was already cancelled or finished."));
    await open();
    await act(async () => { button("Yes, cancel the recovery").click(); });
    expect(text()).toContain("already cancelled or finished");
  });

  it("explains a link with no token", async () => {
    await open("");
    expect(text()).toMatch(/not valid|no link/i);
    expect(api.cancelByToken).not.toHaveBeenCalled();
  });
});
