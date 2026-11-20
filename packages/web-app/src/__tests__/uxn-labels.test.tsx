// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

vi.mock('../store/wallet', async () => {
  const { create } = await import('zustand');
  return { useWalletStore: create(() => ({
    network: 'testnet', activeAccountId: 'a1',
    accounts: [{ id: 'a1', publicKey: 'GSYNTHETICPUBLICKEY' }],
  })) };
});
vi.mock('../store/auth', () => ({ useAuthStore: (select: (s: { user: null }) => unknown) => select({ user: null }) }));
vi.mock('../lib/api', () => ({ getAccessToken: () => null, tokenApi: { featured: async () => [], userTokens: async () => [] } }));
vi.mock('../hooks/useActivation', () => ({ useActivation: () => null }));
vi.mock('../components/TokenIcon', () => ({ default: () => null }));
vi.mock('../components/kit/ReceiveCard', () => ({ ReceiveCard: () => null }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string, fallback?: unknown) => (typeof fallback === 'string' ? fallback : key) }) }));
vi.mock('../hooks/useBalances', () => ({
  useBalances: () => ({ data: [{ assetCode: 'XLM', assetIssuer: 'native', balance: '1', assetType: 'native' }], isLoading: false, isError: false, refetch: vi.fn(), isFetching: false }),
}));

import ReceivePage from '../pages/Receive';
import DashboardPage from '../pages/Dashboard';

let root: Root;
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  document.body.innerHTML = '<div id="root"></div>';
  root = createRoot(document.getElementById('root')!);
});
afterEach(async () => { await act(async () => root.unmount()); vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

const wrap = (ui: React.ReactNode) => (
  <QueryClientProvider client={new QueryClient()}><MemoryRouter>{ui}</MemoryRouter></QueryClientProvider>
);

describe('Receive form labels', () => {
  it('links the amount and memo labels to their fields', async () => {
    await act(async () => root.render(wrap(<ReceivePage />)));
    for (const type of ['number', 'text']) {
      const input = document.querySelector<HTMLInputElement>(`input[type="${type}"]`)!;
      expect(input.id).toBeTruthy();
      const label = document.querySelector(`label[for="${input.id}"]`);
      expect(label).not.toBeNull();
    }
    expect(document.querySelector('label[for="receive-amount"]')?.textContent).toBe('receive.amount');
    expect(document.querySelector('label[for="receive-memo"]')?.textContent).toBe('receive.memo');
  });

  it('names the token search field and its clear button', async () => {
    await act(async () => root.render(wrap(<ReceivePage />)));
    await act(async () => document.querySelector<HTMLButtonElement>('button[aria-expanded], button.w-full')!.click());
    const search = document.querySelector<HTMLInputElement>('input[placeholder="receive.searchTokens"]')!;
    expect(search.getAttribute('aria-label')).toBe('receive.searchTokens');
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
    await act(async () => { setter.call(search, 'x'); search.dispatchEvent(new Event('input', { bubbles: true })); });
    const clear = document.querySelector<HTMLButtonElement>('button[aria-label="Clear search"]')!;
    expect(clear).not.toBeNull();
    expect(clear.type).toBe('button');
    await act(async () => clear.click());
    expect(search.value).toBe('');
    expect(document.activeElement).toBe(search);
  });
});

describe('Dashboard quick actions', () => {
  it('lets a long label wrap instead of cutting it off', async () => {
    vi.stubEnv('VITE_PAYMENTS_ENABLED', 'true');
    await act(async () => root.render(wrap(<DashboardPage />)));
    const pay = document.querySelector('nav[aria-label="Quick actions"] a[href="/payments"]')!;
    const span = [...pay.querySelectorAll('span')].find((s) => s.textContent === 'Pay shop')!;
    expect(span.className).not.toContain('truncate');
    expect(span.className).toContain('text-center');
  });
});
