// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import en from '../i18n/locales/en.json';

const mocks = vi.hoisted(() => ({ history: vi.fn() }));
vi.mock('../store/wallet', async () => {
  const { create } = await import('zustand');
  return { useWalletStore: create(() => ({ accounts: [{ id: 'a', publicKey: 'GSYNTHETIC' }], activeAccountId: 'a', network: 'testnet' })) };
});
vi.mock('../lib/api', () => ({ txApi: { history: mocks.history } }));
vi.mock('../components/TxDetailDialog', () => ({ default: () => null }));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, opt?: unknown) => {
      const found = key.split('.').reduce<unknown>((o, k) => (o as Record<string, unknown> | undefined)?.[k], en);
      if (typeof found === 'string') return found;
      return typeof opt === 'string' ? opt : key;
    },
  }),
}));

import HistoryPage from '../pages/History';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root; let host: HTMLDivElement;
async function mount() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await act(async () => {
    root.render(<QueryClientProvider client={qc}><MemoryRouter><HistoryPage /></MemoryRouter></QueryClientProvider>);
  });
  await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
}
beforeEach(() => { host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host); mocks.history.mockReset(); });
afterEach(() => { act(() => root.unmount()); host.remove(); });

describe('History error and empty states', () => {
  it('shows plain English with Retry, no raw server text, and Retry refetches', async () => {
    mocks.history.mockRejectedValueOnce(new Error('Internal Server Error')).mockResolvedValueOnce([]);
    await mount();
    const alert = host.querySelector('[role="alert"]')!;
    expect(alert.textContent).toContain('We could not load your history');
    expect(alert.textContent).toContain('Your funds are safe');
    expect(host.textContent).not.toMatch(/Internal Server Error|backend/i);
    const retry = [...host.querySelectorAll('button')].find((b) => b.textContent === 'Try again')!;
    expect(retry).toBeTruthy();
    await act(async () => { retry.click(); });
    await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
    expect(mocks.history).toHaveBeenCalledTimes(2);
    expect(host.querySelector('[role="alert"]')).toBeNull();
  });

  it('empty state says what to do next and links to Receive', async () => {
    mocks.history.mockResolvedValue([]);
    await mount();
    expect(host.textContent).toContain('No transactions yet.');
    expect(host.textContent).toContain('Money you receive will appear here.');
    const link = host.querySelector('a[href="/receive"]')!;
    expect(link.textContent).toBe('Receive');
  });
});
