import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { internalHosts, internalRafikiUrlAllowed, rafikiUrlAllowed, xrplFundingRailAllowed } from './configuration';
import { RafikiAdmin } from './rafiki';

describe('XRP funding rail (Interledger)', () => {
  const MAIN = { STELLAR_NETWORK: 'public', MAINNET_CUSTODY: 'on', XRPL_NETWORK: 'mainnet', XRPL_MAINNET_CUSTODY: 'on', XRPL_MAINNET_WS: 'wss://xrplcluster.com/', XRPL_ENABLED: 'true' };
  it('is registered with a partner on XRPL testnet, as before', () => {
    expect(xrplFundingRailAllowed(true, { XRPL_ENABLED: 'true' })).toBe(true);
    expect(xrplFundingRailAllowed(false, { XRPL_ENABLED: 'true' })).toBe(false);
    expect(xrplFundingRailAllowed(true, {})).toBe(false);
  });
  it('is never registered when the XRP pipeline is on mainnet (it reads testnet wallets only)', () => {
    expect(xrplFundingRailAllowed(true, MAIN)).toBe(false);
  });
  it('the runtime uses the guard', () => {
    expect(readFileSync(join(__dirname, 'runtime.ts'), 'utf8')).toMatch(/if\(xrplFundingRailAllowed\(!!partner\)\)adapters\.push\(new XrplFundingAdapter/);
  });
});

const prod = (hosts?: string) => ({ NODE_ENV: 'production', ...(hosts === undefined ? {} : { PAYMENTS_INTERNAL_HOSTS: hosts }) });

describe('rafikiUrlAllowed', () => {
  it('accepts https for both Rafiki URLs', () => {
    expect(rafikiUrlAllowed('RAFIKI_AUTH_URL', 'https://ilp-auth-testnet.ammawallet.com', prod())).toBe(true);
    expect(rafikiUrlAllowed('RAFIKI_INTERACTION_URL', 'https://auth.example.org/interact', prod())).toBe(true);
  });

  it('keeps plain http for the interaction URL outside production, as before', () => {
    expect(rafikiUrlAllowed('RAFIKI_INTERACTION_URL', 'http://auth-a:3009', { NODE_ENV: 'test' })).toBe(true);
  });

  it('refuses plain http in production unless the host is a listed in-network service', () => {
    expect(rafikiUrlAllowed('RAFIKI_INTERACTION_URL', 'http://auth-a:3009', prod())).toBe(false);
    expect(rafikiUrlAllowed('RAFIKI_INTERACTION_URL', 'http://auth-a:3009', prod('auth-a'))).toBe(true);
    expect(rafikiUrlAllowed('RAFIKI_INTERACTION_URL', 'http://AUTH-A:3009', prod(' auth-a , peer-a '))).toBe(true);
    expect(rafikiUrlAllowed('RAFIKI_INTERACTION_URL', 'http://auth-b:3009', prod('auth-a'))).toBe(false);
  });

  it('never lets the allow-list open a public name, an IP or the auth URL', () => {
    expect(rafikiUrlAllowed('RAFIKI_INTERACTION_URL', 'http://auth.ammawallet.com:3009', prod('auth.ammawallet.com'))).toBe(false);
    expect(rafikiUrlAllowed('RAFIKI_INTERACTION_URL', 'http://10.0.0.5:3009', prod('10.0.0.5'))).toBe(false);
    expect(rafikiUrlAllowed('RAFIKI_AUTH_URL', 'http://auth-a:3006', prod('auth-a'))).toBe(false);
    expect(rafikiUrlAllowed('RAFIKI_AUTH_URL', 'http://auth-a:3006', { NODE_ENV: 'test' })).toBe(false);
  });

  it('refuses credentials, other schemes and unparsable values', () => {
    expect(rafikiUrlAllowed('RAFIKI_INTERACTION_URL', 'https://user:pw@auth.example.org', prod())).toBe(false);
    expect(rafikiUrlAllowed('RAFIKI_INTERACTION_URL', 'http://user:pw@auth-a:3009', prod('auth-a'))).toBe(false);
    expect(rafikiUrlAllowed('RAFIKI_INTERACTION_URL', 'ftp://auth-a', prod('auth-a'))).toBe(false);
    expect(rafikiUrlAllowed('RAFIKI_INTERACTION_URL', '', prod('auth-a'))).toBe(false);
    expect(rafikiUrlAllowed('RAFIKI_INTERACTION_URL', undefined, prod('auth-a'))).toBe(false);
  });
});

describe('internalHosts', () => {
  it('keeps only single-label service names', () => {
    expect(internalHosts({ PAYMENTS_INTERNAL_HOSTS: 'auth-a, peer_a,,x.y,10.0.0.1,-bad' })).toEqual(['auth-a', 'peer_a']);
    expect(internalHosts({})).toEqual([]);
  });
});

describe('Rafiki Admin GraphQL URLs (private, may be in-network http)', () => {
  it('apply the same internal-host rule as the interaction URL', () => {
    expect(internalRafikiUrlAllowed('http://ilpt-peer-a:3001/graphql', prod())).toBe(false);
    expect(internalRafikiUrlAllowed('http://ilpt-peer-a:3001/graphql', prod('ilpt-peer-a,ilpt-auth-a'))).toBe(true);
    expect(internalRafikiUrlAllowed('http://admin.example.org/graphql', prod('admin.example.org'))).toBe(false);
    expect(internalRafikiUrlAllowed('https://admin.example.org/graphql', prod())).toBe(true);
    expect(internalRafikiUrlAllowed('http://peer-a:3001/graphql', { NODE_ENV: 'test' })).toBe(true);
  });

  it('RafikiAdmin refuses a plain http admin URL in production unless its host is listed', () => {
    const secret = 'x'.repeat(32);
    const saved = { NODE_ENV: process.env.NODE_ENV, PAYMENTS_INTERNAL_HOSTS: process.env.PAYMENTS_INTERNAL_HOSTS };
    try {
      process.env.NODE_ENV = 'production'; delete process.env.PAYMENTS_INTERNAL_HOSTS;
      expect(() => new RafikiAdmin('http://ilpt-peer-a:3001/graphql', 't', secret)).toThrow('INVALID_RAFIKI_URL');
      process.env.PAYMENTS_INTERNAL_HOSTS = 'ilpt-peer-a';
      expect(() => new RafikiAdmin('http://ilpt-peer-a:3001/graphql', 't', secret)).not.toThrow();
      expect(() => new RafikiAdmin('http://other:3001/graphql', 't', secret)).toThrow('INVALID_RAFIKI_URL');
      expect(() => new RafikiAdmin('not a url', 't', secret)).toThrow('INVALID_RAFIKI_URL');
    } finally {
      for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    }
  });
});
