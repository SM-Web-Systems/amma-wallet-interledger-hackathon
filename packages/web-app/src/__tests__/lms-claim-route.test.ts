// @vitest-environment node
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// The LMS reward claim page must always be routable. It once sat inside the Pay shop block, which is only
// compiled in when VITE_PAYMENTS_ENABLED=true, so on the live site /lms/claim fell through to /dashboard.
const app = readFileSync(fileURLToPath(new URL("../App.tsx", import.meta.url)), "utf8");

describe("LMS claim route", () => {
  it("exists and is not inside the VITE_PAYMENTS_ENABLED block", () => {
    const claim = app.indexOf('path="/lms/claim"');
    const gate = app.indexOf("VITE_PAYMENTS_ENABLED==='true'&&<>");
    const gateEnd = app.indexOf("</>}", gate);
    expect(claim).toBeGreaterThan(-1);
    expect(gate).toBeGreaterThan(-1);
    expect(claim < gate || claim > gateEnd).toBe(true);
  });

  it("keeps the payments routes behind the flag", () => {
    const gate = app.indexOf("VITE_PAYMENTS_ENABLED==='true'&&<>");
    const gateEnd = app.indexOf("</>}", gate);
    const block = app.slice(gate, gateEnd);
    expect(block).toContain('path="/payments"');
    expect(block).toContain('path="/payments/consent"');
  });
});
