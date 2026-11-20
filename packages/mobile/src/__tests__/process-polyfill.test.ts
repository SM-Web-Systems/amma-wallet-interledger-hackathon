import { describe, it, expect } from "vitest";
import { ensureProcess } from "../process-polyfill";

// Hermes on Expo SDK 58 has a `process` without `version`. readable-stream
// (pulled in by stellar-sdk → eventsource) calls process.version.slice() at
// import time, which crashed the app on launch.
describe("ensureProcess", () => {
  it("creates process with env and version when it is missing", () => {
    const g: any = {};
    ensureProcess(g);
    expect(g.process.env).toEqual({});
    expect(typeof g.process.version).toBe("string");
    expect(g.process.version.slice(0, 5)).toBe("v18.0");
  });

  it("adds version and env to an existing process without them", () => {
    const g: any = { process: {} };
    ensureProcess(g);
    expect(typeof g.process.version).toBe("string");
    expect(g.process.env).toEqual({});
  });

  it("keeps an existing version and env", () => {
    const env = { A: "1" };
    const g: any = { process: { version: "v20.1.0", env } };
    ensureProcess(g);
    expect(g.process.version).toBe("v20.1.0");
    expect(g.process.env).toBe(env);
  });
});
