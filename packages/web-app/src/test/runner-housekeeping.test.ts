// @vitest-environment node
import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// The CI runner's disk has filled up before and failed builds. A job cleans it. CI for this repository now runs on
// CircleCI, so the job is started by hand only, not on a schedule. It must stay safe: it may remove build cache
// and dangling images, but never anything a running or rollback container needs.
const path = `${process.cwd()}/../../.github/workflows/runner-housekeeping.yml`;

describe("runner housekeeping workflow", () => {
  it("exists, can be started by hand and no longer runs on a schedule", () => {
    expect(existsSync(path)).toBe(true);
    const text = readFileSync(path, "utf8");
    expect(text).not.toMatch(/schedule:\s*\n\s*- cron:/);
    expect(text).toContain("workflow_dispatch:");
  });

  it("never prunes images, volumes or containers that could be in use or kept for rollback", () => {
    const text = readFileSync(path, "utf8");
    const commands = text.split("\n").filter((l) => !l.trim().startsWith("#")).join("\n");
    expect(commands).not.toMatch(/docker system prune/);
    expect(commands).not.toMatch(/docker volume prune/);
    expect(commands).not.toMatch(/docker container prune/);
    expect(commands).not.toMatch(/docker image prune/);
    expect(commands).not.toMatch(/docker network prune/);
    expect(commands).not.toMatch(/docker builder prune[^\n]*(\s-[a-z]*a|--all)/);
    expect(commands).not.toMatch(/docker (rm|rmi|volume rm|image rm|container rm)\b/);
  });

  it("reports disk use before and after, and fails loudly when the disk is still nearly full", () => {
    const text = readFileSync(path, "utf8");
    expect(text).toMatch(/df -h/);
    expect(text).toMatch(/docker system df/);
    expect(text).toMatch(/-ge 85/);
    expect(text).toMatch(/exit 1/);
    expect(text).toMatch(/\/var\/lib\/docker/);
  });

  it("does not run two cleanups at once, has no token rights and never deletes sockets, pid files or recent temp files", () => {
    const text = readFileSync(path, "utf8");
    expect(text).toMatch(/concurrency:\s*\n\s*group: runner-housekeeping/);
    expect(text).toMatch(/permissions:\s*\n\s*contents: none/);
    expect(text).not.toMatch(/secrets\./);
    expect(text).toMatch(/-atime \+7 -mtime \+7/);
    expect(text).toMatch(/! -name '\*\.sock'/);
    expect(text).not.toMatch(/rm -rf/);
  });
});
