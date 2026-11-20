import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ login: vi.fn(), toastError: vi.fn() }));
vi.mock('../store/auth', () => ({
  useAuthStore: (select: (state: unknown) => unknown) => select({
    login: mocks.login, isAuthenticated: false, isLoading: false,
  }),
}));
vi.mock('../lib/api', () => ({ getAccessToken: () => null, restoreSession: async () => false }));
vi.mock('../lib/pending-oauth', () => ({ consumePendingOAuth: () => null, peekPendingOAuth: () => null }));
vi.mock('../store/wallet', () => ({ useWalletStore: { getState: () => ({ accounts: [], activeAccountId: null }) } }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({
  t: (key: string, fallback?: string) => fallback ?? key,
}) }));
vi.mock('sonner', () => ({ toast: { error: mocks.toastError, info: vi.fn(), success: vi.fn() } }));

import LoginPage from '../pages/Login';

let root: Root;
let verifyChallenge: (token: string) => void;

beforeEach(() => {
  mocks.login.mockReset();
  mocks.toastError.mockReset();
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  document.body.innerHTML = '<div id="root"></div>';
  const script = document.createElement('script');
  script.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js';
  document.head.appendChild(script);
  window.turnstile = {
    render: (_container: HTMLElement, options: { callback: (token: string) => void }) => {
      verifyChallenge = options.callback;
      return 'synthetic-widget';
    },
    reset: vi.fn(), remove: vi.fn(),
  };
  root = createRoot(document.getElementById('root')!);
});
afterEach(async () => {
  await act(async () => root.unmount());
  document.querySelectorAll('script[src*="turnstile"]').forEach(script => script.remove());
  delete window.turnstile;
  vi.unstubAllGlobals();
});

async function change(input: HTMLInputElement, value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}
async function signInWith(error: Error) {
  mocks.login.mockRejectedValue(error);
  await act(async () => root.render(<MemoryRouter><LoginPage /></MemoryRouter>));
  await change(document.querySelector<HTMLInputElement>('input[autocomplete="username"]')!, 'learner@example.invalid');
  await change(document.querySelector<HTMLInputElement>('input[type="password"]')!, 'synthetic-password');
  await act(async () => verifyChallenge('synthetic-token'));
  await act(async () => {
    document.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  });
}

describe('login lock (WA-08)', () => {
  it('shows when sign-in opens again and links to password reset, without a toast', async () => {
    const retryAt = new Date(Date.now() + 25 * 60_000).toISOString();
    await signInWith(Object.assign(new Error('Too many wrong passwords. Sign-in is paused until 10:30 UTC. You can reset your password now.'), { status: 423, retryAt }));
    const alert = document.querySelector('[role="alert"]')!;
    expect(alert).not.toBeNull();
    const local = new Date(retryAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    expect(alert.textContent).toContain(`Sign-in is paused until ${local}`);
    expect(alert.textContent).toContain('You can reset your password now.');
    const link = alert.querySelector('a')!;
    expect(link.textContent).toBe('Reset password');
    expect(link.getAttribute('href')).toBe('/forgot-password');
    expect(mocks.toastError).not.toHaveBeenCalled();
  });

  it('falls back to the server message when there is no time', async () => {
    await signInWith(Object.assign(new Error('Too many wrong passwords. You can reset your password now.'), { status: 423 }));
    expect(document.querySelector('[role="alert"]')!.textContent).toContain('Too many wrong passwords. You can reset your password now.');
    expect(mocks.toastError).not.toHaveBeenCalled();
  });

  it('shows a wrong password inline next to the form without stealing focus, and keeps the toast', async () => {
    await signInWith(Object.assign(new Error('Invalid credentials'), { status: 401 }));
    expect(mocks.toastError).toHaveBeenCalledWith('Invalid credentials');
    const alert = document.querySelector<HTMLElement>('form [role="alert"]')!;
    expect(alert.textContent).toContain('Invalid credentials');
    expect(document.activeElement).not.toBe(alert);
  });

  it('shows a missing human check inline', async () => {
    await act(async () => root.render(<MemoryRouter><LoginPage /></MemoryRouter>));
    await change(document.querySelector<HTMLInputElement>('input[autocomplete="username"]')!, 'learner@example.invalid');
    await change(document.querySelector<HTMLInputElement>('input[type="password"]')!, 'synthetic-password');
    await act(async () => {
      document.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });
    expect(document.querySelector('form [role="alert"]')!.textContent).toContain('human verification');
  });

  it('gives the Create one link a 44px tap area', async () => {
    await act(async () => root.render(<MemoryRouter><LoginPage /></MemoryRouter>));
    const link = document.querySelector('a[href="/register"]')!;
    expect(link.className).toContain('min-h-11');
  });
});
