// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';

vi.mock('../store/wallet', async () => {
  const {create} = await import('zustand');
  return {useWalletStore: create(() => ({
    network: 'testnet', activeAccountId: 'a1',
    accounts: [{id: 'a1', publicKey: 'GSYNTHETICPUBLICKEY'}],
  }))};
});
vi.mock('../store/auth', () => ({useAuthStore: (select: (s: any) => any) => select({user: null})}));
vi.mock('../hooks/useBalances', () => ({useBalances: () => ({data: [], isLoading: false})}));
vi.mock('../lib/api', () => ({getAccessToken: () => null}));
vi.mock('../hooks/useActivation', () => ({ useActivation: () => null }));
vi.mock('../components/TokenIcon', () => ({default: () => null}));
vi.mock('react-i18next', () => ({useTranslation: () => ({t: (key: string, fallback?: string) => fallback ?? key})}));

import {useWalletStore} from '../store/wallet';
import DashboardPage from '../pages/Dashboard';
const {balanceRefetchInterval} = await vi.importActual<typeof import('../hooks/useBalances')>('../hooks/useBalances');

let root: Root;
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  document.body.innerHTML = '<div id="root"></div>';
  root = createRoot(document.getElementById('root')!);
});
afterEach(async () => {await act(async () => root.unmount()); vi.unstubAllGlobals();});

async function renderDashboard(network: 'testnet' | 'public') {
  useWalletStore.setState({network});
  await act(async () => root.render(<MemoryRouter><DashboardPage /></MemoryRouter>));
  return document.querySelector('[data-testid="network-badge"]')?.textContent?.trim();
}

describe('Dashboard network badge', () => {
  it('says Testnet when the wallet is on testnet', async () => {
    expect(await renderDashboard('testnet')).toBe('Testnet');
  });
  it('says Mainnet when the wallet is on the public network', async () => {
    expect(await renderDashboard('public')).toBe('Mainnet');
  });
});

describe('Dashboard network badge legibility', () => {
  it('uses at least 12px text and the darker amber for contrast on testnet', async () => {
    await renderDashboard('testnet');
    const cls = document.querySelector('[data-testid="network-badge"]')!.className;
    expect(cls).toContain('text-xs');
    expect(cls).not.toContain('text-[10px]');
    expect(cls).toContain('text-amber-800');
  });
  it('uses at least 12px text on mainnet', async () => {
    await renderDashboard('public');
    expect(document.querySelector('[data-testid="network-badge"]')!.className).toContain('text-xs');
  });
});

describe('balance refresh while a new testnet wallet is being funded', () => {
  it('polls quickly on testnet until the account has balances', () => {
    expect(balanceRefetchInterval('testnet', [])).toBe(3_000);
    expect(balanceRefetchInterval('testnet', undefined)).toBe(3_000);
  });
  it('returns to the normal interval once balances load', () => {
    expect(balanceRefetchInterval('testnet', [{balance: '10000'}])).toBe(15_000);
  });
  it('does not poll faster on mainnet, where empty accounts may stay unfunded', () => {
    expect(balanceRefetchInterval('public', [])).toBe(15_000);
  });
});
