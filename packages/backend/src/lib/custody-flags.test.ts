import { describe, expect, it } from "vitest";
import { MAINNET_CUSTODY_WARNING, custodyAllowedForUser, custodyFlagsFromEnv, parseMainnetUserIds, warnIfMainnetCustody } from "./custody-flags";
import { setAppLogger } from "./app-log";

describe("XRP on mainnet in the custody flags", () => {
  const base = { STELLAR_NETWORK: "public", MAINNET_CUSTODY: "on", CUSTODY_SERVER_SIGNING: "true" };
  it("is off unless XRPL_MAINNET_CUSTODY=on with XRPL_NETWORK=mainnet", () => {
    expect(custodyFlagsFromEnv(base).xrplMainnet).toBeUndefined();
    expect(custodyFlagsFromEnv({ ...base, XRPL_MAINNET_CUSTODY: "off" }).xrplMainnet).toBeUndefined();
    expect(custodyFlagsFromEnv({ ...base, XRPL_MAINNET_CUSTODY: "on", XRPL_NETWORK: "mainnet" }).xrplMainnet).toBe(true);
    expect(custodyFlagsFromEnv({ CUSTODY_SERVER_SIGNING: "true" }).xrplMainnet).toBeUndefined();
  });
  it("refuses start-up on inconsistent combinations", () => {
    expect(() => custodyFlagsFromEnv({ ...base, XRPL_MAINNET_CUSTODY: "on" })).toThrow(/XRPL_NETWORK=mainnet/);
    expect(() => custodyFlagsFromEnv({ CUSTODY_SERVER_SIGNING: "true", XRPL_MAINNET_CUSTODY: "on", XRPL_NETWORK: "mainnet" })).toThrow(/MAINNET_CUSTODY=on/);
    expect(() => custodyFlagsFromEnv({ ...base, XRPL_NETWORK: "mainnet" })).toThrow(/XRPL_MAINNET_CUSTODY=on/);
    expect(() => custodyFlagsFromEnv({ ...base, XRPL_MAINNET_CUSTODY: "yes", XRPL_NETWORK: "mainnet" })).toThrow(/on or off/);
  });
  it("still refuses welcome funding with XRP on mainnet", () => {
    expect(() => custodyFlagsFromEnv({ ...base, XRPL_MAINNET_CUSTODY: "on", XRPL_NETWORK: "mainnet", WELCOME_FUNDING: "true" })).toThrow(/never allowed on mainnet/);
  });
});

describe("custody flags", () => {
  it("are off by default", () => {
    expect(custodyFlagsFromEnv({})).toEqual({ serverSigning: false, welcomeFunding: false, sepoliaWei: 10000000000000000n, dailyCap: 50 });
  });
  it("parse values", () => {
    const f = custodyFlagsFromEnv({ CUSTODY_SERVER_SIGNING: "true", WELCOME_FUNDING: "true", WELCOME_SEPOLIA_WEI: "5", WELCOME_DAILY_CAP: "7", STELLAR_NETWORK: "testnet" });
    expect(f).toEqual({ serverSigning: true, welcomeFunding: true, sepoliaWei: 5n, dailyCap: 7 });
  });
  it("refuses either flag on mainnet, but allows mainnet with both off", () => {
    expect(() => custodyFlagsFromEnv({ CUSTODY_SERVER_SIGNING: "true", STELLAR_NETWORK: "public" })).toThrow(/testnet/i);
    expect(() => custodyFlagsFromEnv({ WELCOME_FUNDING: "true", STELLAR_NETWORK: "public" })).toThrow(/testnet/i);
    expect(() => custodyFlagsFromEnv({ STELLAR_NETWORK: "public" })).not.toThrow();
  });
  it("allows custody flags only on testnet (allowlist)", () => {
    for (const net of ["mainnet", "pubnet", "PUBLIC", "public", "futurenet"]) {
      expect(() => custodyFlagsFromEnv({ CUSTODY_SERVER_SIGNING: "true", STELLAR_NETWORK: net })).toThrow(/testnet/i);
      expect(() => custodyFlagsFromEnv({ WELCOME_FUNDING: "1", STELLAR_NETWORK: net })).toThrow(/testnet/i);
    }
    expect(() => custodyFlagsFromEnv({ CUSTODY_SERVER_SIGNING: "true" })).not.toThrow();
    expect(() => custodyFlagsFromEnv({ CUSTODY_SERVER_SIGNING: "true", STELLAR_NETWORK: "testnet" })).not.toThrow();
    expect(() => custodyFlagsFromEnv({ STELLAR_NETWORK: "mainnet" })).not.toThrow();
  });
  it("bounds WELCOME_SEPOLIA_WEI to 1..0.1 ETH and never echoes the value", () => {
    for (const v of ["0", "-5", "100000000000000001", "0x16345785D8A0001", "abc"]) {
      let msg = "";
      try { custodyFlagsFromEnv({ WELCOME_SEPOLIA_WEI: v }); } catch (e) { msg = (e as Error).message; }
      expect(msg).toMatch(/WELCOME_SEPOLIA_WEI/);
      if (v.length > 3) expect(msg).not.toContain(v);
    }
    expect(custodyFlagsFromEnv({ WELCOME_SEPOLIA_WEI: "100000000000000000" }).sepoliaWei).toBe(10n ** 17n);
    expect(custodyFlagsFromEnv({ WELCOME_SEPOLIA_WEI: "0x2386F26FC10000" }).sepoliaWei).toBe(10n ** 16n);
    expect(custodyFlagsFromEnv({ WELCOME_SEPOLIA_WEI: "1" }).sepoliaWei).toBe(1n);
  });

  describe('mainnet custody gate', () => {
    const base = { STELLAR_NETWORK: 'public', CUSTODY_SERVER_SIGNING: 'true' };
    it('still refuses public without MAINNET_CUSTODY, and any other value than on', () => {
      expect(() => custodyFlagsFromEnv(base)).toThrow(/testnet/i);
      for (const v of ['true', '1', 'off', 'ON', '']) expect(() => custodyFlagsFromEnv({ ...base, MAINNET_CUSTODY: v })).toThrow(/testnet/i);
    });
    it('starts on public with MAINNET_CUSTODY=on and marks the flags mainnet', () => {
      const f = custodyFlagsFromEnv({ ...base, MAINNET_CUSTODY: 'on' });
      expect(f.serverSigning).toBe(true);
      expect(f.mainnet).toBe(true);
    });
    it('never allows welcome funding on mainnet, even with MAINNET_CUSTODY=on', () => {
      expect(() => custodyFlagsFromEnv({ ...base, MAINNET_CUSTODY: 'on', WELCOME_FUNDING: 'true' })).toThrow(/welcome funding/i);
      expect(() => custodyFlagsFromEnv({ STELLAR_NETWORK: 'public', MAINNET_CUSTODY: 'on', WELCOME_FUNDING: '1' })).toThrow(/welcome funding/i);
    });
    it('refuses MAINNET_CUSTODY=on on a server that is not on the public network', () => {
      expect(() => custodyFlagsFromEnv({ MAINNET_CUSTODY: 'on', CUSTODY_SERVER_SIGNING: 'true' })).toThrow(/MAINNET_CUSTODY/);
      expect(() => custodyFlagsFromEnv({ MAINNET_CUSTODY: 'on', STELLAR_NETWORK: 'testnet' })).toThrow(/MAINNET_CUSTODY/);
    });
    it('warns loudly at start-up on mainnet only', () => {
      const lines: string[] = [];
      setAppLogger({ info: () => {}, error: () => {}, warn: (_o, m) => lines.push(m) });
      warnIfMainnetCustody(custodyFlagsFromEnv({ CUSTODY_SERVER_SIGNING: 'true' }));
      expect(lines).toEqual([]);
      warnIfMainnetCustody(custodyFlagsFromEnv({ ...base, MAINNET_CUSTODY: 'on', CUSTODY_MAINNET_USER_IDS: '1' }));
      expect(lines).toEqual([MAINNET_CUSTODY_WARNING]);
      expect(MAINNET_CUSTODY_WARNING).toBe('MAINNET CUSTODY ON with a local master key — test balances only');
    });
    it('leaves testnet flags without a mainnet marker', () => {
      expect(custodyFlagsFromEnv({ CUSTODY_SERVER_SIGNING: 'true' }).mainnet).toBeUndefined();
    });
  });

  describe('mainnet allow-list (CUSTODY_MAINNET_USER_IDS)', () => {
    const main = { CUSTODY_SERVER_SIGNING: 'true', STELLAR_NETWORK: 'public', MAINNET_CUSTODY: 'on' };
    it('parses comma-separated positive integers, with spaces', () => {
      expect([...parseMainnetUserIds('13,366,367')]).toEqual([13, 366, 367]);
      expect([...parseMainnetUserIds(' 13 , 7 ')]).toEqual([13, 7]);
      expect([...parseMainnetUserIds('5,5')]).toEqual([5]);
    });
    it('treats unset or blank as an empty list', () => {
      expect(parseMainnetUserIds(undefined).size).toBe(0);
      expect(parseMainnetUserIds('').size).toBe(0);
      expect(parseMainnetUserIds('   ').size).toBe(0);
    });
    it.each(['abc', '1,,2', '1,', ',1', '0', '-3', '1.5', '1e3', '0x10', '1;2', '9007199254740993', '1 2'])('throws a clear message for %j', (raw) => {
      expect(() => parseMainnetUserIds(raw)).toThrow(/CUSTODY_MAINNET_USER_IDS/);
      expect(() => custodyFlagsFromEnv({ ...main, CUSTODY_MAINNET_USER_IDS: raw })).toThrow(/CUSTODY_MAINNET_USER_IDS/);
    });
    it('is read into the flags on mainnet only', () => {
      const f = custodyFlagsFromEnv({ ...main, CUSTODY_MAINNET_USER_IDS: '13,366' });
      expect([...f.mainnetUserIds!]).toEqual([13, 366]);
      expect(custodyFlagsFromEnv(main).mainnetUserIds?.size).toBe(0);
    });
    it('allows listed users only on mainnet, and nobody when the list is empty', () => {
      const f = custodyFlagsFromEnv({ ...main, CUSTODY_MAINNET_USER_IDS: '13,366' });
      expect(custodyAllowedForUser(f, 13)).toBe(true);
      expect(custodyAllowedForUser(f, 14)).toBe(false);
      expect(custodyAllowedForUser(custodyFlagsFromEnv(main), 13)).toBe(false);
      expect(custodyAllowedForUser({ mainnet: true }, 13)).toBe(false);
    });
    it('is ignored on testnet, even when malformed', () => {
      const f = custodyFlagsFromEnv({ CUSTODY_SERVER_SIGNING: 'true', CUSTODY_MAINNET_USER_IDS: 'not,a,list' });
      expect(f.mainnetUserIds).toBeUndefined();
      expect(f.mainnet).toBeUndefined();
      expect(custodyAllowedForUser(f, 99)).toBe(true);
      expect(custodyAllowedForUser(custodyFlagsFromEnv({ CUSTODY_SERVER_SIGNING: 'true', CUSTODY_MAINNET_USER_IDS: '13' }), 99)).toBe(true);
    });
    it('warns once at start-up when mainnet custody is on with no users, and not otherwise', () => {
      const lines: string[] = [];
      setAppLogger({ info: () => {}, error: () => {}, warn: (_o, m) => lines.push(m) });
      warnIfMainnetCustody(custodyFlagsFromEnv({ ...main, CUSTODY_MAINNET_USER_IDS: '13' }));
      expect(lines).toEqual([MAINNET_CUSTODY_WARNING]);
      lines.length = 0;
      warnIfMainnetCustody(custodyFlagsFromEnv(main));
      expect(lines).toHaveLength(2);
      expect(lines[1]).toMatch(/no account may use/);
    });
  });
});
