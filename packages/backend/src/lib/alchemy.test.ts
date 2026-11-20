import { describe, expect, it } from "vitest";
import { AlchemyError, alchemyCall, alchemyUrlFromEnv, ethDataFlagsFromEnv } from "./alchemy";

const URL_WITH_KEY = "https://eth-mainnet.g.alchemy.com/v2/SECRETKEY123";

describe("ethDataFlagsFromEnv", () => {
  it("is all off by default and on only for the exact value 'on'", () => {
    expect(ethDataFlagsFromEnv({})).toEqual({ serverData: false, sendSimulate: false, alerts: false });
    expect(ethDataFlagsFromEnv({ ETH_SERVER_DATA: "true", ETH_SEND_SIMULATE: "1", ETH_ALERTS: "ON" })).toEqual({ serverData: false, sendSimulate: false, alerts: false });
    expect(ethDataFlagsFromEnv({ ETH_SERVER_DATA: "on", ETH_SEND_SIMULATE: "on", ETH_ALERTS: "on" })).toEqual({ serverData: true, sendSimulate: true, alerts: true });
  });
});

describe("alchemyUrlFromEnv", () => {
  it("uses the mainnet URL only on mainnet and the Sepolia URLs otherwise; only https", () => {
    const main = { MAINNET_CUSTODY: "on", STELLAR_NETWORK: "public", CUSTODY_ETH_RPC_URL: URL_WITH_KEY, CUSTODY_SEPOLIA_RPC_URL: "https://sepolia.invalid/x" };
    expect(alchemyUrlFromEnv(main)).toBe(URL_WITH_KEY);
    expect(alchemyUrlFromEnv({ ...main, CUSTODY_ETH_RPC_URL: undefined })).toBeNull();
    expect(alchemyUrlFromEnv({ CUSTODY_SEPOLIA_RPC_URL: "https://s.invalid/a", CUSTODY_ETH_RPC_URL: URL_WITH_KEY })).toBe("https://s.invalid/a");
    expect(alchemyUrlFromEnv({ WELCOME_SEPOLIA_RPC_URL: "https://w.invalid/a" })).toBe("https://w.invalid/a");
    expect(alchemyUrlFromEnv({ CUSTODY_SEPOLIA_RPC_URL: "http://insecure.invalid" })).toBeNull();
    expect(alchemyUrlFromEnv({})).toBeNull();
  });
});

describe("alchemyCall", () => {
  const ok = (result: unknown) => async () => ({ ok: true, status: 200, json: async () => ({ result }) });
  it("returns the result and sends a JSON-RPC body", async () => {
    let seen: any;
    const r = await alchemyCall(URL_WITH_KEY, "eth_getBalance", ["0x1", "latest"], async (u, init) => { seen = { u, body: JSON.parse(init.body) }; return ok("0x1")(); });
    expect(r).toBe("0x1");
    expect(seen.body).toMatchObject({ jsonrpc: "2.0", method: "eth_getBalance", params: ["0x1", "latest"] });
  });
  it("turns every failure into a short code that never contains the URL", async () => {
    const fails: [string, () => Promise<any>][] = [
      ["network", async () => { throw new Error(`fetch failed ${URL_WITH_KEY}`); }],
      ["http_429", async () => ({ ok: false, status: 429, json: async () => ({}) })],
      ["rpc_-32000", async () => ({ ok: true, status: 200, json: async () => ({ error: { code: -32000, message: URL_WITH_KEY } }) })],
      ["bad_response", async () => ({ ok: true, status: 200, json: async () => ({}) })],
    ];
    for (const [code, f] of fails) {
      const e = await alchemyCall<any>(URL_WITH_KEY, "m", [], f).catch((x): any => x);
      expect(e).toBeInstanceOf(AlchemyError);
      expect(e.code).toBe(code);
      expect(JSON.stringify([e.message, e.code, String(e.stack).split("\n")[0]])).not.toContain("SECRETKEY123");
    }
  });
  it("times out", async () => {
    const e = await alchemyCall<any>(URL_WITH_KEY, "m", [], (_u, init) => new Promise((_r, rej) => init.signal!.addEventListener("abort", () => rej(new Error("aborted")))), 20).catch((x): any => x);
    expect(e.code).toBe("timeout");
  });
});

import { exactAmount } from "./alchemy";
describe("exactAmount", () => {
  it("is exact from hex value and hex decimals (real record shape)", () => {
    expect(exactAmount({ value: "0x38d7ea4c68000", address: null, decimal: "0x12" } as any, 0.001)).toBe("0.001");
    expect(exactAmount({ value: "0xbc614e", decimal: "0x6" }, 12.345678)).toBe("12.345678");
    expect(exactAmount({ value: "0x16345785d8a0001", decimal: "0x12" }, 0.1)).toBe("0.100000000000000001");
    expect(exactAmount({ value: "0xde0b6b3a7640000", decimal: "0x12" }, 1)).toBe("1");
    expect(exactAmount({ value: "0x1", decimal: "0x12" }, 1e-18)).toBe("0.000000000000000001");
    expect(exactAmount({ rawValue: "0x38d7ea4c68000", decimals: 18 }, null)).toBe("0.001");
    expect(exactAmount({ value: "0x0", decimal: "0x12" }, 0)).toBe("0");
  });
  it("falls back to the number only when the raw parts are missing or bad", () => {
    expect(exactAmount(null, 0.25)).toBe("0.25");
    expect(exactAmount({ value: "zz", decimal: "0x12" }, 0.5)).toBe("0.5");
    expect(exactAmount({ value: "0x1" }, 0.5)).toBe("0.5");
    expect(exactAmount(undefined, null)).toBeNull();
    expect(exactAmount(undefined, Number.NaN)).toBeNull();
  });
});
