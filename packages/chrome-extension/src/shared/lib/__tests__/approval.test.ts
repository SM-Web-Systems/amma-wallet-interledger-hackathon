// TODO D5: fixing the `@/` path alias for tsc exposed that "connect" read
// `walletStore.activePublicKey`, which does not exist, so dApps got
// `{ address: undefined }`. The result building is now a tested function.
import { describe, expect, it, vi } from "vitest";
import { Keypair } from "@stellar/stellar-sdk";
import { buildApprovalResult } from "../approval";

const kp = Keypair.random();
const unlocked = { publicKey: kp.publicKey(), secretKey: kp.secret() };

describe("buildApprovalResult", () => {
  it("connect returns the active account's address", async () => {
    await expect(buildApprovalResult({ method: "connect", params: {} }, unlocked)).resolves.toEqual({ address: kp.publicKey() });
  });

  it("connect fails when there is no active account", async () => {
    await expect(buildApprovalResult({ method: "connect", params: {} }, { publicKey: null, secretKey: null })).rejects.toThrow(/no active wallet/i);
  });

  it("signMessage returns a signature that verifies", async () => {
    const r = (await buildApprovalResult({ method: "signMessage", params: { message: "hello" } }, unlocked)) as { signedMessage: string; signerAddress: string };
    expect(r.signerAddress).toBe(kp.publicKey());
    expect(kp.verify(Buffer.from("hello"), Buffer.from(r.signedMessage, "base64"))).toBe(true);
  });

  it("signAuthEntry signs the decoded entry", async () => {
    const entry = Buffer.from("auth-entry-bytes");
    const r = (await buildApprovalResult({ method: "signAuthEntry", params: { authEntry: entry.toString("base64") } }, unlocked)) as { signedAuthEntry: string };
    expect(kp.verify(entry, Buffer.from(r.signedAuthEntry, "base64"))).toBe(true);
  });

  it.each(["signTransaction", "signAuthEntry", "signMessage"])("%s refuses while locked", async (method) => {
    await expect(buildApprovalResult({ method, params: { message: "x", authEntry: "", xdr: "" } }, { publicKey: kp.publicKey(), secretKey: null })).rejects.toThrow(/locked/i);
  });

  it("rejects unknown methods", async () => {
    await expect(buildApprovalResult({ method: "exportKey", params: {} }, unlocked)).rejects.toThrow(/unsupported/i);
  });

  it("an Amma-held wallet approves a transaction through the server with the login password", async () => {
    const serverSign = vi.fn(async (_xdr: string) => "SIGNED-XDR");
    const r = await buildApprovalResult({ method: "signTransaction", params: { xdr: "UNSIGNED" } }, { publicKey: kp.publicKey(), secretKey: null, serverSign });
    expect(serverSign).toHaveBeenCalledWith("UNSIGNED");
    expect(r).toEqual({ signedTxXdr: "SIGNED-XDR", signerAddress: kp.publicKey() });
  });

  it("an Amma-held wallet can't sign raw messages or auth entries yet", async () => {
    const serverSign = vi.fn(async () => "x");
    for (const method of ["signMessage", "signAuthEntry"]) {
      await expect(buildApprovalResult({ method, params: { message: "hi", authEntry: "AA==" } }, { publicKey: kp.publicKey(), secretKey: null, serverSign })).rejects.toThrow(/Amma holds this wallet/);
    }
    expect(serverSign).not.toHaveBeenCalled();
  });
});
