import { afterEach, describe, expect, it, vi } from "vitest";
import { signingApi } from "./api";
import { extractStellarError } from "./stellar";

afterEach(() => vi.unstubAllGlobals());

describe("sign-and-submit rejections reach the Send page as the server's own text", () => {
  it.each([
    [400, "That account doesn't exist on the Stellar network yet. Send at least 1 XLM to create it.", "op_no_destination"],
    [504, "The Stellar network didn't confirm in time. Check your history before trying again.", "timeout"],
  ])("status %i", async (status, error, code) => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ error, code }), { status })));
    const thrown = await signingApi.signAndSubmit("XDR", "passphrase", "secret").then(() => null, (e: unknown) => e);
    expect(thrown).toBeInstanceOf(Error);
    // This is exactly what Send.tsx shows beside the Send button.
    expect(extractStellarError(thrown)).toBe(error);
    // The server's top-level result code stays on the error too.
    expect((thrown as { code?: string }).code).toBe(code);
  });
});
