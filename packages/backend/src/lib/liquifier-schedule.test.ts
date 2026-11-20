import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

// The real swap functions must never run in these tests.
vi.mock("./liquifier", () => ({
  liquifyPlatformFees: vi.fn(async () => { throw new Error("real liquifier called"); }),
  cleanupEmptyTrustlines: vi.fn(async () => { throw new Error("real cleanup called"); }),
}));

import { adminLiquify, liquifierEnabled, liquifierTick, LIQUIFIER_OFF_MESSAGE } from "./liquifier-schedule";

const SECRET = "SBQWY3DNPFWGSZTFNZSXI4TUMVZXG5DFMVZXG5DFMVZXG5DFMVZXG5DF";
const result = (n: number) => ({
  converted: Array.from({ length: n }, () => ({ asset: "USDC:GA5ZSEJY...", code: "USDC", issuer: "GA5ZSEJY", amount: "1", xlmReceived: "8", txHash: "abc" })),
  skipped: [],
  errors: [],
});
const deps = (on: boolean, converted = 1) => {
  const calls: string[] = [];
  const log = { info: vi.fn(), error: vi.fn() };
  return {
    calls,
    log,
    d: {
      enabled: () => on,
      liquify: vi.fn(async () => { calls.push("liquify"); return result(converted); }),
      cleanup: vi.fn(async () => { calls.push("cleanup"); return ["USDC"]; }),
      log,
    },
  };
};

describe("PLATFORM_LIQUIFIER_ENABLED", () => {
  it("is off unless set to on/true/1", () => {
    expect(liquifierEnabled({})).toBe(false);
    expect(liquifierEnabled({ PLATFORM_LIQUIFIER_ENABLED: "" })).toBe(false);
    expect(liquifierEnabled({ PLATFORM_LIQUIFIER_ENABLED: "off" })).toBe(false);
    expect(liquifierEnabled({ PLATFORM_LIQUIFIER_ENABLED: "yes please" })).toBe(false);
    expect(liquifierEnabled({ PLATFORM_LIQUIFIER_ENABLED: "TRUE" })).toBe(false);
    expect(liquifierEnabled({ PLATFORM_LIQUIFIER_ENABLED: " on" })).toBe(false);
    for (const v of ["on", "true", "1"]) expect(liquifierEnabled({ PLATFORM_LIQUIFIER_ENABLED: v })).toBe(true);
  });
});

describe("scheduled liquifier tick", () => {
  it("does nothing when the switch is off", async () => {
    const { d, calls } = deps(false);
    await liquifierTick(d);
    expect(calls).toEqual([]);
  });

  it("with the switch on, calls liquify then cleanup when something was converted", async () => {
    const { d, calls } = deps(true, 2);
    await liquifierTick(d);
    expect(calls).toEqual(["liquify", "cleanup"]);
    expect(d.cleanup).toHaveBeenCalledWith([{ code: "USDC", issuer: "GA5ZSEJY" }, { code: "USDC", issuer: "GA5ZSEJY" }]);
  });

  it("with the switch on, skips cleanup when nothing was converted", async () => {
    const { d, calls } = deps(true, 0);
    await liquifierTick(d);
    expect(calls).toEqual(["liquify"]);
  });

  it("catches errors and logs only the message, never the secret", async () => {
    const { d, log } = deps(true);
    const err = Object.assign(new Error("Horizon down"), { secret: SECRET, config: { PLATFORM_SECRET: SECRET } });
    d.liquify.mockRejectedValueOnce(err);
    await expect(liquifierTick(d)).resolves.toBeUndefined();
    expect(log.error).toHaveBeenCalledWith("[liquifier] Scheduled run failed:", "Horizon down");
    expect(JSON.stringify([...log.error.mock.calls, ...log.info.mock.calls])).not.toContain(SECRET);
  });

  it("catches a cleanup failure too", async () => {
    const { d, log } = deps(true);
    d.cleanup.mockRejectedValueOnce(new Error("bad seq"));
    await expect(liquifierTick(d)).resolves.toBeUndefined();
    expect(log.error).toHaveBeenCalledWith("[liquifier] Scheduled run failed:", "bad seq");
  });

  it("the default deps read the switch from the environment (off when unset)", async () => {
    const saved = process.env.PLATFORM_LIQUIFIER_ENABLED;
    delete process.env.PLATFORM_LIQUIFIER_ENABLED;
    try {
      // The mocked real functions throw if called; with the switch off they must not be.
      await expect(liquifierTick()).resolves.toBeUndefined();
      const out = await adminLiquify(1);
      expect(out.status).toBe(503);
    } finally {
      if (saved !== undefined) process.env.PLATFORM_LIQUIFIER_ENABLED = saved;
    }
  });
});

describe("admin liquify", () => {
  it("answers 503 'liquifier is switched off', calls nothing and logs a refusal when off", async () => {
    const { d, calls, log } = deps(false);
    const out = await adminLiquify(1, d);
    expect(out).toEqual({ status: 503, body: { error: LIQUIFIER_OFF_MESSAGE } });
    expect(LIQUIFIER_OFF_MESSAGE).toBe("liquifier is switched off");
    expect(calls).toEqual([]);
    expect(log.info).toHaveBeenCalledWith("[admin] Liquifier refused: switched off (user", 1, ")");
    expect(JSON.stringify(log.info.mock.calls)).not.toContain("triggered");
  });

  it("calls liquify then cleanup with the converted assets when on and returns both results", async () => {
    const { d, calls, log } = deps(true, 1);
    const out = await adminLiquify(1, d);
    expect(calls).toEqual(["liquify", "cleanup"]);
    expect(d.cleanup).toHaveBeenCalledWith([{ code: "USDC", issuer: "GA5ZSEJY" }]);
    expect(out.status).toBe(200);
    expect(out.body).toEqual({ ...result(1), cleanedTrustlines: ["USDC"] });
    expect(log.info).toHaveBeenCalledWith("[admin] Liquifier triggered by user", 1);
  });

  it("does not clean up trustlines when nothing was converted", async () => {
    const { d, calls } = deps(true, 0);
    const out = await adminLiquify(1, d);
    expect(calls).toEqual(["liquify"]);
    expect(out).toEqual({ status: 200, body: { ...result(0), cleanedTrustlines: [] } });
  });

  it("answers 500 with the message only when liquify throws", async () => {
    const { d, log } = deps(true);
    d.liquify.mockRejectedValueOnce(Object.assign(new Error("Horizon down"), { secret: SECRET }));
    const out = await adminLiquify(1, d);
    expect(out).toEqual({ status: 500, body: { error: "Horizon down" } });
    expect(log.error).toHaveBeenCalledWith("[admin] Liquifier failed:", "Horizon down");
    expect(JSON.stringify([out, ...log.error.mock.calls])).not.toContain(SECRET);
  });
});

describe("server.ts wiring", () => {
  // server.ts runs bootstrap() (DB, Horizon, app.listen) as soon as it is imported, so it cannot be loaded in a unit test.
  // Its wiring is therefore checked on the source text, as db/startup-gate-wiring.test.ts and routes/custody-sign-wiring.test.ts do;
  // the behaviour itself is tested above through liquifierTick/adminLiquify.
  const src = readFileSync(join(__dirname, "..", "server.ts"), "utf8");
  const route = src.slice(src.indexOf('"/api/v1/admin/liquify"'), src.indexOf('"/api/v1/admin/platform-balance"'));

  it("imports the liquifier pieces instead of declaring them", () => {
    expect(src).toMatch(/import \{ adminLiquify, liquifierTick \} from "\.\/lib\/liquifier-schedule";/);
    expect(src).not.toMatch(/declare const (liquifyPlatformFees|cleanupEmptyTrustlines)/);
    expect(src).not.toMatch(/KNOWN-BUG\(T-02\): these two are called below/);
  });

  it("the admin route keeps the admin check, then goes through adminLiquify", () => {
    expect(route).toContain("authMiddleware");
    const admin = route.indexOf("if (userId !== 1)");
    const call = route.indexOf("await adminLiquify(userId)");
    expect(admin).toBeGreaterThan(-1);
    expect(call).toBeGreaterThan(admin);
    expect(route).toMatch(/reply\.status\(out\.status\)\.send\(out\.body\)/);
    expect(route).toMatch(/503: \{ type: "object", properties: \{ error: \{ type: "string" \} \} \}/);
    expect(route).toMatch(/500: \{ type: "object", properties: \{ error: \{ type: "string" \} \} \}/);
    expect(route).not.toContain("Liquifier triggered");
    expect(route).not.toMatch(/liquifyPlatformFees\(|cleanupEmptyTrustlines\(/);
  });

  it("the 6-hourly interval calls liquifierTick", () => {
    expect(src).toMatch(/setInterval\(\(\) => void liquifierTick\(\), 6 \* 60 \* 60 \* 1000\);/);
  });
});
