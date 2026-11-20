import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ login: vi.fn() }));
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
vi.mock('sonner', () => ({ toast: { error: vi.fn(), info: vi.fn(), success: vi.fn() } }));

import LoginPage from '../pages/Login';
import SsoLoginPage from '../pages/SsoLogin';

type Challenge = {
  callback: (token: string) => void;
  'expired-callback'?: () => void;
  'error-callback'?: () => void;
};
let root: Root;
let challenges: Challenge[];
let remove: ReturnType<typeof vi.fn>;

beforeEach(() => {
  mocks.login.mockReset().mockRejectedValue(new Error('Invalid credentials'));
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  document.body.innerHTML = '<div id="root"></div>';
  const script = document.createElement('script');
  script.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js';
  document.head.appendChild(script);
  challenges = [];
  remove = vi.fn();
  window.turnstile = {
    render: (_container: HTMLElement, options: Challenge) => {
      challenges.push(options);
      return `synthetic-widget-${challenges.length}`;
    },
    reset: vi.fn(), remove,
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
async function submit() {
  await act(async () => {
    document.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  });
}
async function verify(token: string) {
  await act(async () => challenges.at(-1)!.callback(token));
}

describe.each(['login', 'sso'] as const)('%s challenge lifecycle', page => {
  async function render() {
    await act(async () => root.render(
      <MemoryRouter initialEntries={['/sso/login?callback=https%3A%2F%2Flms.example.invalid%2Fcallback&state=synthetic-state']}>
        {page === 'login' ? <LoginPage /> : <SsoLoginPage />}
      </MemoryRouter>,
    ));
    await change(document.querySelector<HTMLInputElement>('input[autocomplete="username"]')!, 'learner@example.invalid');
    await change(document.querySelector<HTMLInputElement>('input[type="password"]')!, 'synthetic-password');
  }

  it('requires a challenge before the first credential request', async () => {
    await render(); await submit();
    expect(mocks.login).not.toHaveBeenCalled();
  });

  it.each(['Invalid credentials', 'Human verification failed', 'Network response lost', 'Too many requests'])(
    'renews the consumed challenge after %s without retrying automatically', async error => {
      mocks.login.mockRejectedValue(new Error(error));
      await render(); await verify('synthetic-first-token'); await submit();
      expect(mocks.login).toHaveBeenCalledExactlyOnceWith('learner@example.invalid', 'synthetic-password', 'synthetic-first-token', undefined);
      expect(challenges).toHaveLength(2);
      expect(remove).toHaveBeenCalledWith('synthetic-widget-1');
      await submit(); // Dispatching directly also checks the handler, not only the button.
      expect(mocks.login).toHaveBeenCalledTimes(1);
      await verify('synthetic-new-token'); await submit();
      expect(mocks.login).toHaveBeenCalledTimes(2);
      expect(mocks.login).toHaveBeenLastCalledWith('learner@example.invalid', 'synthetic-password', 'synthetic-new-token', undefined);
    });

  it.each(['expired-callback', 'error-callback'] as const)(
    'clears a previously verified token on %s', async callback => {
      await render(); await verify('synthetic-invalidated-token');
      await act(async () => challenges.at(-1)![callback]?.());
      await submit();
      expect(mocks.login).not.toHaveBeenCalled();
    });

  it('submits only once while the credential request is pending', async () => {
    let finish!: () => void;
    mocks.login.mockImplementation(() => new Promise<void>(resolve => { finish = resolve; }));
    await render(); await verify('synthetic-once-token');
    await submit(); await submit();
    expect(mocks.login).toHaveBeenCalledTimes(1);
    await act(async () => finish());
  });

  it('keeps the verified second-factor step usable without reusing the first token', async () => {
    mocks.login.mockRejectedValueOnce(new Error('2FA_REQUIRED:totp'))
      .mockRejectedValue(new Error('Invalid verification code'));
    await render(); await verify('synthetic-first-factor'); await submit();
    expect(document.body.textContent).toContain('2FA Verification Code');
    const code = document.querySelector<HTMLInputElement>('input[inputmode="numeric"]')!;
    expect(code).toBeDefined();
    await change(code, '123456');
    const button = document.querySelector<HTMLButtonElement>('button[type="submit"]')!;
    expect(button.disabled).toBe(false);
    await submit();
    expect(mocks.login).toHaveBeenLastCalledWith('learner@example.invalid', 'synthetic-password', '', '123456');
  });
});
