import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";

// The fee-injection rebuild moved from server.ts (sign-and-submit) to lib/platform-fee.ts, so
// check at source level there that the rebuild carries the memo over.
const src = readFileSync(join(__dirname, "lib", "platform-fee.ts"), "utf-8");

describe("sign-and-submit fee rebuild keeps the memo", () => {
  it("re-adds the original memo to the rebuilt transaction", () => {
    const start = src.indexOf("Rebuild transaction with fee operations appended");
    const end = src.indexOf("finalTx = builder.build()", start);
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const block = src.slice(start, end);
    expect(block).toMatch(/tx\.memo\s*&&\s*tx\.memo\.type\s*!==\s*["']none["']/);
    expect(block).toMatch(/builder\.addMemo\(tx\.memo\)/);
  });
});
