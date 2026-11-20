// @vitest-environment jsdom
// Regression: an OAuth relying party (e.g. the CRM) sends a signed-out user to
// /oauth/authorize → /login. Signing in must go straight back to the consent
// flow. Before the fix, AuthRoute showed /dashboard (with balances) for the whole
// wallet sync, and only then did the login handler resume the OAuth request.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter, Routes, Route, useLocation } from 'react-router-dom';

const m = vi.hoisted(() => ({ token: null as string | null, finishSync: () => {}, visited: [] as string[] }));
vi.mock('../store/auth', async () => {
  const { create } = await import('zustand');
  return {
    useAuthStore: create((set: (s: object) => void) => ({
      user: null, isAuthenticated: false, isLoading: false,
      // This mock flips isAuthenticated before its wallet sync, unlike the real login() (which syncs first), to keep the race covered.
      register: async () => {
        m.token = 'synthetic-token';
        set({ isAuthenticated: true, user: { id: 8 } });
      },
      login: async () => {
        m.token = 'synthetic-token';
        set({ isAuthenticated: true, user: { id: 7 } });
        await new Promise<void>((resolve) => { m.finishSync = resolve; });
      },
    })),
  };
});
vi.mock('../store/wallet', () => ({ useWalletStore: { getState: () => ({ accounts: [{}], activeAccountId: 'a' }) } }));
vi.mock('../lib/api', () => ({ getAccessToken: () => m.token }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (k: string, f?: string) => f ?? k }) }));
vi.mock('sonner', () => ({ toast: { error: vi.fn(), info: vi.fn(), success: vi.fn() } }));
vi.mock('../components/Turnstile', () => ({
  Turnstile: ({ onVerify }: { onVerify: (t: string) => void }) => <button type="button" onClick={() => onVerify('captcha')}>Complete verification</button>,
}));

import { useAuthStore } from '../store/auth';
import AuthRoute from '../components/AuthRoute';
import LoginPage from '../pages/Login';
import RegisterPage from '../pages/Register';
import OAuthConsent from '../pages/OAuthConsent';

const CONSENT_QS = '?client_id=crm&redirect_uri=https%3A%2F%2Fcrm.example.invalid%2Fauth%2Fcallback&state=s1';
let root: Root;
let fetchMock: ReturnType<typeof vi.fn>;

function Spy() { m.visited.push(useLocation().pathname); return null; }

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  fetchMock = vi.fn(() => new Promise(() => {})); // never resolves: no real network
  vi.stubGlobal('fetch', fetchMock);
  sessionStorage.clear();
  m.token = null; m.visited = [];
  (useAuthStore as unknown as { setState: (s: object) => void }).setState({ user: null, isAuthenticated: false, isLoading: false });
  document.body.innerHTML = '<div id="root"></div>';
  root = createRoot(document.getElementById('root')!);
});
afterEach(async () => { await act(async () => root.unmount()); vi.unstubAllGlobals(); });

async function render(entry: string) {
  window.history.replaceState(null, '', entry); // OAuthConsent saves window.location.search, as in a real browser
  await act(async () => root.render(
    <MemoryRouter initialEntries={[entry]}>
      <Spy />
      <Routes>
        <Route path="/oauth/authorize" element={<OAuthConsent />} />
        <Route path="/login" element={<AuthRoute><LoginPage /></AuthRoute>} />
        <Route path="/register" element={<AuthRoute><RegisterPage /></AuthRoute>} />
        <Route path="/dashboard" element={<p>Wallet dashboard</p>} />
      </Routes>
    </MemoryRouter>,
  ));
}
async function type(el: HTMLInputElement, value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
}
async function signIn() {
  await type(document.querySelector<HTMLInputElement>('input[autocomplete="username"]')!, 'staff@example.invalid');
  await type(document.querySelector<HTMLInputElement>('input[type="password"]')!, 'synthetic-password');
  await act(async () => [...document.querySelectorAll('button')].find((b) => b.textContent === 'Complete verification')!.click());
  await act(async () => { document.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); });
}

describe('OAuth sign-in returns to the relying party', () => {
  it('goes back to the consent flow after sign-in and never visits the dashboard', async () => {
    await render(`/oauth/authorize${CONSENT_QS}`);
    expect(m.visited.at(-1)).toBe('/login');

    await signIn();
    // While the wallet sync is still running, the user must already be back on the consent flow.
    expect(m.visited.at(-1)).toBe('/oauth/authorize');
    expect(document.body.textContent).not.toContain('Wallet dashboard');
    await act(async () => m.finishSync());

    expect(m.visited).not.toContain('/dashboard');
    expect(document.body.textContent).not.toContain('Wallet dashboard');
    expect(m.visited.at(-1)).toBe('/oauth/authorize');
    const authorizeCall = fetchMock.mock.calls.find(([url]) => String(url).includes('/api/v1/oauth/authorize'));
    expect(String(authorizeCall?.[0])).toContain('client_id=crm');
  });

  it('clears the saved request once the consent page takes it over', async () => {
    await render(`/oauth/authorize${CONSENT_QS}`);
    expect(sessionStorage.getItem('pendingOAuth')).toBe(CONSENT_QS);
    await signIn();
    await act(async () => m.finishSync());
    expect(sessionStorage.getItem('pendingOAuth')).toBeNull();
  });

  it('a signed-in user opening /login with no pending request still goes to the dashboard', async () => {
    m.token = 'synthetic-token';
    (useAuthStore as unknown as { setState: (s: object) => void }).setState({ isAuthenticated: true });
    await render('/login');
    expect(m.visited.at(-1)).toBe('/dashboard');
  });

  it('signing up mid-OAuth also returns to the consent flow and keeps it', async () => {
    sessionStorage.setItem('pendingOAuth', CONSENT_QS); // saved by the consent page before the user chose "Create one"
    await render('/register');
    await type(document.querySelector<HTMLInputElement>('input[type="email"]')!, 'new@example.invalid');
    const [pw, confirm] = [...document.querySelectorAll<HTMLInputElement>('input[type="password"]')];
    await type(pw, 'Synthetic1pass');
    await type(confirm, 'Synthetic1pass');
    await act(async () => [...document.querySelectorAll('button')].find((b) => b.textContent === 'Complete verification')!.click());
    await act(async () => { document.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); });

    expect(m.visited).not.toContain('/dashboard');
    expect(m.visited.at(-1)).toBe('/oauth/authorize');
  });
});
