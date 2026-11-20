import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ signAndSubmit: vi.fn() }));
vi.mock("./api", () => ({ signingApi: { signAndSubmit: mocks.signAndSubmit }, txApi: {} }));
vi.mock("../store/auth", () => ({ useAuthStore: { getState: () => ({ signingMode: "delegated" }) } }));
vi.mock("../store/wallet", () => ({ useWalletStore: { getState: () => ({}) } }));

import { signAndSubmitXdr } from "./stellar";

beforeEach(() => mocks.signAndSubmit.mockReset());

describe("signAndSubmitXdr (other sign-and-submit callers)", () => {
  it("shows the not-confirmed message instead of a failure when the server answers 202 unknown", async () => {
    mocks.signAndSubmit.mockResolvedValue({ status: "unknown", hash: "a".repeat(64), error: "x" });
    await expect(signAndSubmitXdr("xdr", "pass", "")).rejects.toMatchObject({
      message: "The network didn't confirm in time. Check your history before trying again.", code: "timeout",
    });
  });
  it("passes a normal success through", async () => {
    mocks.signAndSubmit.mockResolvedValue({ success: true, hash: "b".repeat(64) });
    await expect(signAndSubmitXdr("xdr", "pass", "")).resolves.toMatchObject({ success: true });
  });
});
