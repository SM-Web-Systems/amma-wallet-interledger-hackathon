import { act, useEffect } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../store/auth', () => ({
  useAuthStore: (select: (state: unknown) => unknown) => select({ login: vi.fn(), isAuthenticated: false, isLoading: false }),
}));
vi.mock('../lib/api', () => ({ getAccessToken: () => null, restoreSession: async () => false }));
vi.mock('../lib/pending-oauth', () => ({ consumePendingOAuth: () => null, peekPendingOAuth: () => null }));
vi.mock('../store/wallet', () => ({ useWalletStore: { getState: () => ({ accounts: [], activeAccountId: null }) } }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string, fallback?: string) => fallback ?? key }) }));
vi.mock('sonner', () => ({ toast: { error: vi.fn(), info: vi.fn(), success: vi.fn() } }));
vi.mock('../components/Turnstile', () => ({ Turnstile: () => null }));

import LoginPage from '../pages/Login';

const claim = '/lms/claim#message=U00gV2Vi&return=https%3A%2F%2Flms.example.invalid%2Fclaim';
const seen: { state: unknown } = { state: 'not reached' };
function Register() {
  const state = useLocation().state;
  useEffect(() => { seen.state = state; }, [state]);
  return <p>register page</p>;
}
let root: Root;

beforeEach(() => {
  seen.state = 'not reached';
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  document.body.innerHTML = '<div id="root"></div>';
  root = createRoot(document.getElementById('root')!);
});
afterEach(async () => { await act(async () => root.unmount()); vi.unstubAllGlobals(); });

async function createOne(state: unknown) {
  await act(async () => root.render(
    <MemoryRouter initialEntries={[{ pathname: '/login', state }]}>
      <Routes><Route path="/login" element={<LoginPage />} /><Route path="/register" element={<Register />} /></Routes>
    </MemoryRouter>));
  const link = document.querySelector<HTMLAnchorElement>('a[href="/register"]')!;
  expect(link.textContent).toContain('auth.createOne');
  await act(async () => link.click());
}

describe('Login to Register claim hand-off', () => {
  it('passes a valid claim returnTo on to Register', async () => {
    await createOne({ returnTo: claim });
    expect(seen.state).toEqual({ returnTo: claim });
  });
  it('does not pass a lookalike returnTo, or any other state', async () => {
    await createOne({ returnTo: '//evil.example/lms/claim#message=a&return=b', xrplApproval: '/x', paymentReturn: '/y' });
    expect(seen.state == null || (seen.state as { returnTo?: unknown }).returnTo === undefined).toBe(true);
    expect(JSON.stringify(seen.state ?? {})).not.toMatch(/evil|xrplApproval|paymentReturn/);
  });
});
