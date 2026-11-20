import { describe, expect, it } from "vitest";
import { Keypair } from "@stellar/stellar-sdk";
import { activationFlagsFromEnv, activationOn, treasurySecretFromEnv } from "./activation-flags";

const SECRET = Keypair.random().secret();
const testnet = { TASK_ACTIVATION: "on", TASK_ACTIVATION_STELLAR_TREASURY_SECRET: SECRET };
const mainnet = { ...testnet, STELLAR_NETWORK: "public", MAINNET_CUSTODY: "on", TASK_ACTIVATION_MAINNET: "on" };

describe("activation flags", () => {
  it("is off by default and for any value that is not on, true or 1", () => {
    for (const env of [{}, { TASK_ACTIVATION: "off" }, { TASK_ACTIVATION: "yes" }, { TASK_ACTIVATION: "" }]) {
      expect(activationOn(env)).toBe(false);
      expect(activationFlagsFromEnv(env).enabled).toBe(false);
    }
    for (const v of ["on", "true", "1"]) expect(activationOn({ TASK_ACTIVATION: v })).toBe(true);
  });

  it("an off flag never needs a treasury key and ignores bad optional values", () => {
    expect(() => activationFlagsFromEnv({ TASK_ACTIVATION_CHAINS: "xrpl", ACTIVATION_STELLAR_GRANT_STROOPS: "nope" })).not.toThrow();
  });

  it("testnet defaults: stellar only, 1.1 XLM, caps, 3 per user", () => {
    const f = activationFlagsFromEnv(testnet);
    expect(f).toMatchObject({ enabled: true, mainnet: false, network: "testnet", chains: ["stellar"], stellarGrantStroops: 11_000_000n, globalDailyCap: 1000, userDailyCap: 3 });
    expect(JSON.stringify(f, (_k, v) => (typeof v === "bigint" ? v.toString() : v))).not.toContain(SECRET);
  });

  it("needs a well-formed treasury secret and never echoes it", () => {
    expect(() => activationFlagsFromEnv({ TASK_ACTIVATION: "on" })).toThrow("TASK_ACTIVATION_STELLAR_TREASURY_SECRET");
    const bad = "SBADSECRET" + "X".repeat(40);
    let message = "";
    try { activationFlagsFromEnv({ TASK_ACTIVATION: "on", TASK_ACTIVATION_STELLAR_TREASURY_SECRET: bad }); } catch (e) { message = (e as Error).message; }
    expect(message).toContain("TASK_ACTIVATION_STELLAR_TREASURY_SECRET");
    expect(message).not.toContain(bad);
    // A public key is not a secret key.
    expect(() => activationFlagsFromEnv({ TASK_ACTIVATION: "on", TASK_ACTIVATION_STELLAR_TREASURY_SECRET: Keypair.random().publicKey() })).toThrow();
    expect(treasurySecretFromEnv(testnet)).toBe(SECRET);
  });

  it("supports the stellar chain only in phase 1", () => {
    expect(activationFlagsFromEnv({ ...testnet, TASK_ACTIVATION_CHAINS: "stellar" }).chains).toEqual(["stellar"]);
    for (const chains of ["xrpl", "stellar,evm", "stellar,xrpl", "bitcoin", ""]) {
      if (chains === "") continue;
      expect(() => activationFlagsFromEnv({ ...testnet, TASK_ACTIVATION_CHAINS: chains })).toThrow("stellar");
    }
  });

  it("bounds the grant and the caps", () => {
    expect(activationFlagsFromEnv({ ...testnet, ACTIVATION_STELLAR_GRANT_STROOPS: "20000000" }).stellarGrantStroops).toBe(20_000_000n);
    for (const v of ["0", "-1", "20000001", "1.5", "abc"]) expect(() => activationFlagsFromEnv({ ...testnet, ACTIVATION_STELLAR_GRANT_STROOPS: v })).toThrow("ACTIVATION_STELLAR_GRANT_STROOPS");
    expect(activationFlagsFromEnv({ ...testnet, ACTIVATION_DAILY_CAP_STELLAR: "7" }).globalDailyCap).toBe(7);
    expect(() => activationFlagsFromEnv({ ...testnet, ACTIVATION_DAILY_CAP_STELLAR: "-1" })).toThrow("ACTIVATION_DAILY_CAP_STELLAR");
  });

  describe("mainnet", () => {
    it("is refused unless MAINNET_CUSTODY=on, STELLAR_NETWORK=public and TASK_ACTIVATION_MAINNET=on all hold", () => {
      expect(() => activationFlagsFromEnv({ ...testnet, STELLAR_NETWORK: "public" })).toThrow(/mainnet/i);
      expect(() => activationFlagsFromEnv({ ...testnet, STELLAR_NETWORK: "public", MAINNET_CUSTODY: "on" })).toThrow("TASK_ACTIVATION_MAINNET");
      expect(() => activationFlagsFromEnv({ ...testnet, STELLAR_NETWORK: "public", TASK_ACTIVATION_MAINNET: "on" })).toThrow(/mainnet/i);
      expect(() => activationFlagsFromEnv({ ...testnet, MAINNET_CUSTODY: "on", TASK_ACTIVATION_MAINNET: "on" })).toThrow(/mainnet/i);
      expect(() => activationFlagsFromEnv({ ...testnet, TASK_ACTIVATION_MAINNET: "on" })).toThrow("TASK_ACTIVATION_MAINNET");
      expect(() => activationFlagsFromEnv({ ...mainnet, TASK_ACTIVATION_MAINNET: "true" })).toThrow("TASK_ACTIVATION_MAINNET");
    });
    it("with all three it runs on the public network with the mainnet caps", () => {
      expect(activationFlagsFromEnv(mainnet)).toMatchObject({ enabled: true, mainnet: true, network: "public", globalDailyCap: 100 });
    });
    it("off stays off on mainnet without any extra flag", () => {
      expect(activationFlagsFromEnv({ STELLAR_NETWORK: "public", MAINNET_CUSTODY: "on" }).enabled).toBe(false);
    });
  });

  it("reads the pause file path, if any", () => {
    expect(activationFlagsFromEnv(testnet).controlFile).toBeUndefined();
    expect(activationFlagsFromEnv({ ...testnet, TASK_ACTIVATION_CONTROL_FILE: "/etc/amma/activation-control.json" }).controlFile).toBe("/etc/amma/activation-control.json");
  });

  it("business wallets need business credits and a key provider, and stay off mainnet for now", () => {
    expect(activationFlagsFromEnv(testnet).businessWallets).toBe(false);
    const on = { ...testnet, BUSINESS_CREDITS: "on", BUSINESS_WALLETS: "on", KEY_WRAP_PROVIDER: "local" };
    expect(activationFlagsFromEnv(on)).toMatchObject({ businessCredits: true, businessWallets: true });
    expect(() => activationFlagsFromEnv({ ...on, BUSINESS_CREDITS: "" })).toThrow("BUSINESS_CREDITS=on");
    expect(() => activationFlagsFromEnv({ ...on, KEY_WRAP_PROVIDER: "" })).toThrow("KEY_WRAP_PROVIDER");
    expect(() => activationFlagsFromEnv({ ...mainnet, BUSINESS_CREDITS: "on", BUSINESS_WALLETS: "on", KEY_WRAP_PROVIDER: "local" })).toThrow("testnet only");
  });

  it("business deposits need business wallets and an escalation address", () => {
    const wallets = { ...testnet, BUSINESS_CREDITS: "on", BUSINESS_WALLETS: "on", KEY_WRAP_PROVIDER: "local" };
    expect(activationFlagsFromEnv(wallets).businessDeposits).toBeUndefined();
    expect(activationFlagsFromEnv({ ...wallets, BUSINESS_DEPOSITS: "on", BUSINESS_ESCALATION_EMAIL: "owner@example.test" })).toMatchObject({ businessDeposits: true, escalationEmail: "owner@example.test" });
    expect(() => activationFlagsFromEnv({ ...wallets, BUSINESS_DEPOSITS: "on" })).toThrow("BUSINESS_ESCALATION_EMAIL");
    expect(() => activationFlagsFromEnv({ ...wallets, BUSINESS_WALLETS: "", BUSINESS_DEPOSITS: "on", BUSINESS_ESCALATION_EMAIL: "owner@example.test" })).toThrow("BUSINESS_WALLETS=on");
  });

  it("fee sweeps need business deposits", () => {
    const deposits = { ...testnet, BUSINESS_CREDITS: "on", BUSINESS_WALLETS: "on", KEY_WRAP_PROVIDER: "local", BUSINESS_DEPOSITS: "on", BUSINESS_ESCALATION_EMAIL: "owner@example.test" };
    expect(activationFlagsFromEnv(deposits).businessFeeSweeps).toBeUndefined();
    expect(activationFlagsFromEnv({ ...deposits, BUSINESS_FEE_SWEEPS: "on" }).businessFeeSweeps).toBe(true);
    expect(() => activationFlagsFromEnv({ ...deposits, BUSINESS_DEPOSITS: "", BUSINESS_FEE_SWEEPS: "on" })).toThrow("BUSINESS_DEPOSITS=on");
  });

  it("business controls need business credits and the owner's alert address, and are testnet only", () => {
    const credits = { ...testnet, BUSINESS_CREDITS: "on" };
    expect(activationFlagsFromEnv(credits).businessControls).toBeUndefined();
    expect(activationFlagsFromEnv({ ...credits, BUSINESS_CONTROLS: "on", BUSINESS_ESCALATION_EMAIL: "owner@example.test" })).toMatchObject({ businessControls: true, escalationEmail: "owner@example.test" });
    expect(() => activationFlagsFromEnv({ ...credits, BUSINESS_CONTROLS: "on" })).toThrow("BUSINESS_ESCALATION_EMAIL");
    expect(() => activationFlagsFromEnv({ ...testnet, BUSINESS_CONTROLS: "on", BUSINESS_ESCALATION_EMAIL: "owner@example.test" })).toThrow("BUSINESS_CREDITS=on");
    expect(() => activationFlagsFromEnv({ ...mainnet, BUSINESS_CREDITS: "on", BUSINESS_CONTROLS: "on", BUSINESS_ESCALATION_EMAIL: "owner@example.test" })).toThrow("testnet only");
  });
});
