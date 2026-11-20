import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// server.ts runs bootstrap() when it is imported, so its wiring is checked on the source (as routes/custody-sign-wiring.test.ts does).
const src = readFileSync(join(__dirname, "..", "server.ts"), "utf8");
const start = src.indexOf("async function bootstrap()");
const gate = src.indexOf("await startupSchemaGate(", start);

describe("API start-up schema gate", () => {
  it("runs the schema gate in bootstrap() before app.listen and exits non-zero on problems", () => {
    expect(start).toBeGreaterThan(-1);
    expect(gate).toBeGreaterThan(start);
    expect(gate).toBeLessThan(src.indexOf("await app.listen(", start));
    // Before any route, plugin or worker is set up.
    expect(gate).toBeLessThan(src.indexOf("await app.register(", start));
    const block = src.slice(gate, gate + 1500);
    expect(block).toMatch(/else if \(!gate\.ok\) \{[\s\S]*process\.exit\(1\);/);
    expect(block).toContain('JSON.stringify({ check: "schema-gate", ok: false, required: gate.required, problems: gate.problems })');
    expect(src).toMatch(/import \{ startupSchemaGate \} from "\.\/db\/schema-gate";/);
  });
  it("verify-schema.ts loads packages/backend/.env like the API", () => {
    const verify = readFileSync(join(__dirname, "verify-schema.ts"), "utf8");
    expect(verify.split("\n")[0]).toMatch(/^import "dotenv\/config";/);
    expect(src.split("\n")[0]).toMatch(/^import "dotenv\/config";/);
  });
  it("serves as before when the database cannot be read at start-up (warns, does not exit)", () => {
    expect(src.slice(gate, gate + 1500)).toMatch(/if \(gate\.unreadable\) appLog\(\)\.warn\(/);
  });
});
