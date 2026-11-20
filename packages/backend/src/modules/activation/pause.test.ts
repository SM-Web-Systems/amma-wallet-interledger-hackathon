import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { activationPaused } from "./pause";

const dir = mkdtempSync(join(tmpdir(), "activation-pause-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
const file = (content: string) => { const p = join(dir, `c${Math.random()}.json`); writeFileSync(p, content); return p; };

describe("activationPaused", () => {
  it("is never paused without a configured file", () => { expect(activationPaused(undefined)).toBe(false); expect(activationPaused("")).toBe(false); });
  it("follows the file and rereads it every time", () => {
    const p = file('{"paused":false}');
    expect(activationPaused(p)).toBe(false);
    writeFileSync(p, '{"paused":true}');
    expect(activationPaused(p)).toBe(true);
    writeFileSync(p, '{"paused":false}');
    expect(activationPaused(p)).toBe(false);
  });
  it.each([["a missing file", join(dir, "nope.json")], ["empty", file("")], ["not JSON", file("paused")], ["a string flag", file('{"paused":"no"}')],
    ["an extra key", file('{"paused":false,"x":1}')], ["an array", file("[]")], ["too big", file(`{"paused":false,"pad":"${"x".repeat(300)}"}`)],
  ])("fails closed for %s", (_n, p) => { expect(activationPaused(p as string)).toBe(true); });
});
