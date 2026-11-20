// @vitest-environment node
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("en.json txDetail keys", () => {
  const raw = readFileSync(new URL("./locales/en.json", import.meta.url), "utf8");
  it("has the confirmation strings and keeps CRLF line endings", () => {
    const t = JSON.parse(raw).txDetail;
    for (const k of ["title", "confirming", "operationId", "copyOp", "copyHash", "copyInnerHash", "copyDest", "copyMemo", "explorer", "history", "checkAgain", "details", "close", "platformFee", "outerHash", "innerHash"]) expect(typeof t[k]).toBe("string");
    expect(raw.includes("\r\n")).toBe(true);
    expect(/(^|[^\r])\n/.test(raw)).toBe(false);
  });
});
