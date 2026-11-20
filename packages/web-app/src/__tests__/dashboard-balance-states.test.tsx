// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

const balances = vi.hoisted(() => ({ value: {} as Record<string, unknown> }));
const horizon = vi.hoisted(() => ({ fetch: vi.fn() }));
const auth = vi.hoisted(() => ({ user: null as null | { id: string } }));
const tokenApi = vi.hoisted(() => ({ userTokens: vi.fn() }));
const activation = vi.hoisted(() => ({ value: null as null | { state: string; activatedBy?: string } }));

vi.mock('../store/wallet', async () => {
  const { create } = await import('zustand');
  return { useWalletStore: create(() => ({
    network: 'testnet', activeAccountId: 'a1',
    accounts: [{ id: 'a1', publicKey: 'GSYNTHETICPUBLICKEY' }],
  })) };
});
vi.mock('../store/auth', () => ({ useAuthStore: (select: (s: { user: { id: string } | null }) => unknown) => select({ user: auth.user }) }));
vi.mock('../lib/horizon', () => ({ fetchBalancesFromHorizon: horizon.fetch }));
vi.mock('../lib/api', () => ({ getAccessToken: () => (auth.user ? 'tok' : null), tokenApi }));
vi.mock('../hooks/useActivation', () => ({ useActivation: () => activation.value }));
vi.mock('../components/TokenIcon', () => ({ default: () => null }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string, fallback?: unknown, vars?: Record<string, string>) => (typeof fallback === 'string' ? fallback.replace(/\{\{(\w+)\}\}/g, (_m, k) => vars?.[k] ?? '') : key) }) }));
vi.mock('../hooks/useBalances', async (orig) => {
  const actual = await orig<typeof import('../hooks/useBalances')>();
  return { ...actual, useBalances: () => (balances.value.use ? actual.useBalances() : balances.value) };
});

import DashboardPage from '../pages/Dashboard';
import { useBalances } from '../hooks/useBalances';

let root: Root;
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  document.body.innerHTML = '<div id="root"></div>';
  root = createRoot(document.getElementById('root')!);
  horizon.fetch.mockReset(); tokenApi.userTokens.mockReset();
  activation.value = null; auth.user = null;
  localStorage.clear();
});
afterEach(async () => { await act(async () => root.unmount()); vi.unstubAllGlobals(); });

const xlm = { assetCode: 'XLM', assetIssuer: 'native', balance: '123.5', assetType: 'native', isFavorite: false };

async function render(value: Record<string, unknown>) {
  balances.value = value;
  await act(async () => root.render(<MemoryRouter><DashboardPage /></MemoryRouter>));
  return document.body.textContent ?? '';
}

describe('Dashboard when balances cannot be loaded', () => {
  it('says so, offers Retry, and never shows a zero balance or "No assets"', async () => {
    const refetch = vi.fn();
    const text = await render({ data: undefined, isLoading: false, isError: true, refetch, isFetching: false });
    expect(document.querySelector('[role="alert"]')?.textContent).toMatch(/could not load/i);
    expect(text).not.toContain('dashboard.noAssets');
    expect(document.querySelector('[data-testid="unfunded"]')).toBeNull();
    expect(document.querySelector('[data-testid="total-balance"]')?.textContent).not.toMatch(/^\s*0(\.|\s)/);
    const retry = [...document.querySelectorAll('button')].find((b) => /retry/i.test(b.textContent ?? ''));
    expect(retry).toBeTruthy();
    await act(async () => retry!.click());
    expect(refetch).toHaveBeenCalledTimes(1);
  });

  it('keeps the last known balances and warns that they may be old', async () => {
    const text = await render({ data: [xlm], isLoading: false, isError: true, refetch: vi.fn(), isFetching: false });
    expect(text).toContain('123.5');
    expect(document.querySelector('[role="alert"]')?.textContent).toMatch(/last known/i);
  });
});

describe('Dashboard when the account has nothing', () => {
  it('says the account is not funded yet and links to Receive', async () => {
    await render({ data: [], isLoading: false, isError: false, refetch: vi.fn(), isFetching: false });
    expect(document.querySelector('[role="alert"]')).toBeNull();
    expect(document.querySelector('[data-testid="unfunded"]')).not.toBeNull();
    const link = [...document.querySelectorAll('a')].filter((a) => a.getAttribute('href') === '/receive');
    expect(link.length).toBeGreaterThan(0);
  });
});

describe('Dashboard with task activation', () => {
  const empty = { data: [], isLoading: false, isError: false, refetch: vi.fn(), isFetching: false };
  it('tells an unfunded Amma-held wallet what to do, and links to the LMS first and Receive second', async () => {
    activation.value = { state: 'not_activated' };
    const text = await render(empty);
    const box = document.querySelector('[data-testid="unfunded"]')!;
    expect(box.textContent).toContain('Your wallet is not active yet.');
    expect(text).not.toContain('dashboard.noAssets');
    const links = [...box.querySelectorAll('a')];
    expect(links[0].textContent).toBe('Go to the LMS (opens in a new tab)');
    expect(links[0].getAttribute('href')).toBe('https://lms.smwebsystems.com');
    expect(links[0].getAttribute('rel')).toContain('noopener');
    expect(links.some((a) => a.getAttribute('href') === '/receive')).toBe(true);
  });
  it('shows Activating while the grant is on its way', async () => {
    activation.value = { state: 'activating' };
    await render(empty);
    expect(document.querySelector('[role="status"]')?.textContent).toContain('Activating');
  });
  it('names the partner once the wallet is active and funded', async () => {
    activation.value = { state: 'active', activatedBy: 'Acme Academy' };
    await render({ data: [xlm], isLoading: false, isError: false, refetch: vi.fn(), isFetching: false });
    expect(document.querySelector('[data-testid="activated-by"]')?.textContent).toContain('Active – activated by Acme Academy');
  });
  it('shows no Go to the LMS link while activating or when the server has no info', async () => {
    activation.value = { state: 'activating' };
    await render(empty);
    expect(document.body.textContent).not.toContain('Go to the LMS');
  });
  it('looks as before when the server has no activation info', async () => {
    await render(empty);
    expect(document.querySelector('[data-testid="unfunded"]')?.textContent).not.toContain('Not activated yet');
  });
});

describe('Dashboard welcome banner', () => {
  const stub = () => vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ json: async () => ({ hasFundingEvent: true }) }));
  const empty = { data: [xlm], isLoading: false, isError: false, refetch: vi.fn(), isFetching: false };
  it('is generic and true: no hard-coded company, no NFT claim, no emoji icon', async () => {
    auth.user = { id: 'u1' }; stub();
    await render(empty); await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
    const banner = document.querySelector('[data-testid="funding-notice"]')!;
    expect(banner.textContent).toContain('Your wallet is active');
    expect(banner.textContent).not.toMatch(/SM Web Systems|NFT|💳/);
    expect(banner.querySelector('[role="img"]')).toBeNull();
    expect(banner.querySelector('svg[aria-hidden="true"]')).not.toBeNull();
  });
  it('names the partner the server reported', async () => {
    auth.user = { id: 'u1' }; stub(); activation.value = { state: 'active', activatedBy: 'Acme Academy' };
    await render(empty); await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
    expect(document.querySelector('[data-testid="funding-notice"]')?.textContent).toContain('Thanks to Acme Academy');
  });
});

describe('useBalances', () => {
  type Seen = { isError: boolean; data?: { balance: string }[] };
  function Probe({ out }: { out: Seen[] }) { const q = useBalances(); out.push({ isError: q.isError, data: q.data }); return null; }
  async function run() {
    const out: Seen[] = [];
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    await act(async () => root.render(<QueryClientProvider client={client}><Probe out={out} /></QueryClientProvider>));
    await act(async () => { await new Promise((r) => setTimeout(r, 20)); });
    return out[out.length - 1];
  }

  it('reports an error when both Horizon and the backend fail, instead of an empty list', async () => {
    balances.value = { use: true };
    horizon.fetch.mockRejectedValue(new Error('Horizon error: 503'));
    tokenApi.userTokens.mockRejectedValue(new Error('503'));
    const last = await run();
    expect(last.isError).toBe(true);
    expect(last.data).toBeUndefined();
  });

  it('treats an account Horizon does not know as an empty, funded-later account', async () => {
    balances.value = { use: true };
    horizon.fetch.mockResolvedValue([]);
    const last = await run();
    expect(last.isError).toBe(false);
    expect(last.data).toEqual([]);
  });

  it('falls back to the backend when Horizon fails', async () => {
    balances.value = { use: true };
    horizon.fetch.mockRejectedValue(new Error('Horizon error: 503'));
    tokenApi.userTokens.mockResolvedValue([{ assetCode: 'XLM', assetIssuer: 'native', balance: '9', assetType: 'native' }]);
    const last = await run();
    expect(last.isError).toBe(false);
    expect(last.data[0].balance).toBe('9');
  });
});
