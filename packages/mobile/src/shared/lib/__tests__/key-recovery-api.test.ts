import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../store/auth", () => ({ useAuthStore: { getState: () => ({ accessToken: "t0k", refreshSession: async () => false }) } }));
vi.mock("../config", () => ({ API_BASE: "https://api.test" }));

import { keyRecoveryApi } from "../api";

const fetchMock = vi.fn();
const ok = (body: unknown, status = 200) => ({ ok: status < 400, status, json: async () => body });
const last = () => ({ url: fetchMock.mock.calls.at(-1)![0] as string, init: fetchMock.mock.calls.at(-1)![1] as RequestInit });

beforeEach(() => { fetchMock.mockReset(); vi.stubGlobal("fetch", fetchMock); });

describe("phone recovery API", () => {
  it("reads the status", async () => {
    fetchMock.mockResolvedValue(ok({ enabled: true, state: "waiting", readyAt: "2030-01-01T00:00:00.000Z" }));
    expect(await keyRecoveryApi.status()).toEqual({ enabled: true, state: "waiting", readyAt: "2030-01-01T00:00:00.000Z" });
    expect(last().url).toBe("https://api.test/api/v1/key-recovery/status");
  });

  it("asks for a code, starts with password and code, cancels and completes with the right bodies", async () => {
    fetchMock.mockResolvedValue(ok({ sent: true }));
    await keyRecoveryApi.sendCode();
    expect(last().url).toBe("https://api.test/api/v1/key-recovery/code");
    expect(last().init.method).toBe("POST");

    fetchMock.mockResolvedValue(ok({ state: "waiting", readyAt: "x" }));
    await keyRecoveryApi.start("pw pw pw pw", "123456");
    expect(last().url).toBe("https://api.test/api/v1/key-recovery/request");
    expect(JSON.parse(String(last().init.body))).toEqual({ password: "pw pw pw pw", code: "123456" });

    fetchMock.mockResolvedValue(ok({ cancelled: true }));
    await keyRecoveryApi.cancel();
    expect(last().url).toBe("https://api.test/api/v1/key-recovery/cancel");

    fetchMock.mockResolvedValue(ok({ phrase: "w1 w2" }));
    expect(await keyRecoveryApi.complete("pw pw pw pw")).toEqual({ phrase: "w1 w2" });
    expect(last().url).toBe("https://api.test/api/v1/key-recovery/complete");
    expect(JSON.parse(String(last().init.body))).toEqual({ password: "pw pw pw pw" });
  });

  it("passes the server's plain message through", async () => {
    fetchMock.mockResolvedValue(ok({ error: "The wait is not over yet." }, 409));
    await expect(keyRecoveryApi.complete("pw pw pw pw")).rejects.toThrow("The wait is not over yet.");
  });
});
