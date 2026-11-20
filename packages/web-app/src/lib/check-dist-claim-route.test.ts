// @vitest-environment node
import { describe, expect, it, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";

type Result = { ok: boolean; problems: string[] };
// Plain .mjs helper shared with the post-deploy check; loaded by path so the TS project need not type it.
const script = pathToFileURL(resolve(__dirname, "../../scripts/check-dist-claim-route.mjs")).href;
const { checkDist } = (await import(/* @vite-ignore */ script)) as { checkDist: (dir: string) => Result };

const made: string[] = [];
function dist(files: Record<string, string>) {
  const d = mkdtempSync(join(tmpdir(), "dist-"));
  made.push(d);
  mkdirSync(join(d, "assets"));
  writeFileSync(join(d, "index.html"), "<html></html>");
  for (const [name, body] of Object.entries(files)) writeFileSync(join(d, "assets", name), body);
  return d;
}
afterEach(() => { while (made.length) rmSync(made.pop()!, { recursive: true, force: true }); });

const ROUTER = 'o.jsx(Route,{path:"/lms/claim",element:x})';
const PAGE = 'children:"Approve LMS reward claim"';

describe("checkDist: the built bundle carries the LMS claim route", () => {
  it("passes when the router chunk names /lms/claim and a LmsClaimSign chunk holds the page", () => {
    expect(checkDist(dist({ "index-abc.js": ROUTER, "LmsClaimSign-xyz.js": PAGE })).ok).toBe(true);
  });
  it("accepts the backtick quoting the production minifier uses", () => {
    expect(checkDist(dist({ "index-abc.js": "K,{path:`/lms/claim`,element:t}", "LmsClaimSign-xyz.js": PAGE })).ok).toBe(true);
  });
  it("fails when /lms/claim appears only as unrelated text, not as a route path", () => {
    expect(checkDist(dist({ "index-abc.js": 'href:"/lms/claim"', "LmsClaimSign-xyz.js": PAGE })).ok).toBe(false);
  });
  it("fails when the route string is missing from every chunk (the PR #200 failure)", () => {
    const r = checkDist(dist({ "index-abc.js": 'path:"/payments"', "LmsClaimSign-xyz.js": PAGE }));
    expect(r.ok).toBe(false);
    expect(r.problems.join(" ")).toMatch(/\/lms\/claim/);
  });
  it("fails when the LmsClaimSign chunk is missing", () => {
    const r = checkDist(dist({ "index-abc.js": ROUTER }));
    expect(r.ok).toBe(false);
    expect(r.problems.join(" ")).toMatch(/LmsClaimSign/);
  });
  it("fails when the chunk exists but lacks the Approve page text", () => {
    expect(checkDist(dist({ "index-abc.js": ROUTER, "LmsClaimSign-xyz.js": "nothing" })).ok).toBe(false);
  });
  it("fails on a missing dist directory", () => {
    expect(checkDist(join(tmpdir(), "no-such-dist-dir")).ok).toBe(false);
  });
});

describe("CLI entry", () => {
  it("exits 1 on a bad dist even when run through a symlinked or junctioned scripts directory", async () => {
    const { symlinkSync, unlinkSync } = await import("node:fs");
    const { spawnSync } = await import("node:child_process");
    const link = join(tmpdir(), `scripts-link-${process.pid}`);
    symlinkSync(resolve(__dirname, "../../scripts"), link, "junction");
    let r;
    try {
      r = spawnSync(process.execPath, [join(link, "check-dist-claim-route.mjs"), dist({ "index-abc.js": "nothing" })], { encoding: "utf8" });
    } finally { unlinkSync(link); }
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/FAIL/);
  });
});
