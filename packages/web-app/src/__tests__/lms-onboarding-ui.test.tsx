// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, StrictMode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';

const mocks = vi.hoisted(() => ({login: vi.fn(), addEmail: vi.fn(), resend: vi.fn(), fetch: vi.fn(), token: null as string | null}));
vi.mock('../store/auth', async () => {
  const {create} = await import('zustand');
  return {useAuthStore: create(() => ({user: null, isAuthenticated: false, isLoading: false, login: mocks.login}))};
});
vi.mock('../lib/api', () => ({getAccessToken: () => mocks.token, restoreSession: async () => false, authApi: {addEmail: mocks.addEmail, resendVerification: mocks.resend}}));
vi.mock('react-i18next', () => ({useTranslation: () => ({t: (key: string, fallback?: string) => fallback ?? key})}));
vi.mock('sonner', () => ({toast: {error: vi.fn(), info: vi.fn()}}));
vi.mock('../components/Turnstile', () => ({Turnstile: ({onVerify}: {onVerify: (token: string) => void}) =>
  <button type="button" onClick={() => onVerify('synthetic-captcha')}>Complete verification</button>}));

import {useAuthStore} from '../store/auth';
import SsoLoginPage from '../pages/SsoLogin';
import AccountEmail from '../components/AccountEmail';

let root: Root;
const phoneUser = {id: 42, email: null, firstName: 'Synthetic', isEmailVerified: false};
beforeEach(() => {
  vi.clearAllMocks(); mocks.token = null;
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  mocks.fetch.mockImplementation(() => new Promise(() => {})); // Never navigate or contact an origin.
  vi.stubGlobal('fetch', mocks.fetch);
  useAuthStore.setState({user: null, isAuthenticated: false, isLoading: false});
  document.body.innerHTML = '<div id="root"></div>';
  root = createRoot(document.getElementById('root')!);
});
afterEach(async () => {await act(async () => root.unmount()); vi.unstubAllGlobals();});
async function renderSso(strict = false) {
  const page = <MemoryRouter initialEntries={['/sso/login?callback=https%3A%2F%2Flms.example.invalid%2Fcallback&state=synthetic-state']}><SsoLoginPage /></MemoryRouter>;
  await act(async () => root.render(strict ? <StrictMode>{page}</StrictMode> : page));
}
async function change(input: HTMLInputElement, value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value);
    input.dispatchEvent(new Event('input', {bubbles: true}));
  });
}
async function submitLogin() {
  await change(document.querySelector<HTMLInputElement>('input[autocomplete="username"]')!, '+27123456789');
  await change(document.querySelector<HTMLInputElement>('input[type="password"]')!, 'synthetic-password');
  const captcha = [...document.querySelectorAll('button')].find(button => button.textContent === 'Complete verification')!;
  await act(async () => captcha.click());
  await act(async () => {document.querySelector('form')!.dispatchEvent(new Event('submit', {bubbles: true, cancelable: true}));});
}

describe('LMS SSO browser contract', () => {
  it('continues after an existing session finishes hydration', async () => {
    await renderSso();
    expect(mocks.fetch).not.toHaveBeenCalled();
    mocks.token = 'synthetic-session';
    await act(async () => useAuthStore.setState({user: phoneUser as any, isAuthenticated: true}));
    expect(mocks.fetch).toHaveBeenCalledTimes(1);
    const [url, options] = mocks.fetch.mock.calls[0];
    expect(url).toBe('/api/v1/sso/token');
    expect(JSON.parse(options.body)).toEqual({callbackUrl: 'https://lms.example.invalid/callback', state: 'synthetic-state'});
    expect(options.headers.Authorization).toBe('Bearer synthetic-session');
  });
  it('does not issue duplicate assertions during development strict effects', async () => {
    mocks.token = 'synthetic-session';
    useAuthStore.setState({user: phoneUser as any, isAuthenticated: true});
    await renderSso(true);
    expect(mocks.fetch).toHaveBeenCalledTimes(1);
  });
  it('does not exchange an old token when attempted credentials fail', async () => {
    mocks.token = 'stale-other-session';
    mocks.login.mockRejectedValue(new Error('Invalid credentials'));
    await renderSso(); await submitLogin();
    expect(mocks.fetch).not.toHaveBeenCalled();
  });
  it('waits for the second factor instead of exchanging an assertion', async () => {
    mocks.login.mockRejectedValue(new Error('2FA_REQUIRED:totp'));
    await renderSso(); await submitLogin();
    expect(mocks.fetch).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain('2FA Verification Code');
  });
  it('issues one assertion when successful login updates authentication state', async () => {
    mocks.login.mockImplementation(async () => {
      mocks.token = 'new-session';
      useAuthStore.setState({user: phoneUser as any, isAuthenticated: true});
    });
    await renderSso(); await submitLogin();
    expect(mocks.login).toHaveBeenCalledWith('+27123456789', 'synthetic-password', 'synthetic-captcha', undefined);
    expect(mocks.fetch).toHaveBeenCalledTimes(1);
  });
  it('issues one assertion when the redirect starts before login finishes syncing wallets', async () => {
    // login() sets isAuthenticated, then awaits wallet sync; the effect's assertion completes meanwhile.
    let finishWalletSync!: () => void;
    mocks.login.mockImplementation(async () => {
      mocks.token = 'new-session';
      useAuthStore.setState({user: phoneUser as any, isAuthenticated: true});
      await new Promise<void>(resolve => { finishWalletSync = resolve; });
    });
    mocks.fetch.mockResolvedValue({ok: true, json: async () => ({assertionToken: 'synthetic-assertion'})});
    vi.spyOn(console, 'error').mockImplementation(() => {}); // jsdom does not implement cross-origin navigation
    await renderSso(); await submitLogin();
    expect(mocks.fetch).toHaveBeenCalledTimes(1);
    await act(async () => finishWalletSync());
    expect(mocks.fetch).toHaveBeenCalledTimes(1);
  });
});

describe('phone-only email recovery UI', () => {
  async function renderEmail() {
    useAuthStore.setState({user: phoneUser as any, isAuthenticated: true});
    await act(async () => root.render(<AccountEmail />));
  }
  async function submitEmail() {
    await change(document.querySelector<HTMLInputElement>('input[type="email"]')!, 'Owner@example.invalid');
    await change(document.querySelector<HTMLInputElement>('input[type="password"]')!, 'proof');
    await act(async () => {document.querySelector('form')!.dispatchEvent(new Event('submit', {bubbles: true, cancelable: true}));});
  }
  it('supports saved-but-undelivered email followed by resend without a Stellar wallet', async () => {
    mocks.addEmail.mockResolvedValue({success: true, verificationSent: false, message: 'Email saved. Resend verification email to retry.'});
    mocks.resend.mockResolvedValue({success: true, verificationSent: true, message: 'Verification email sent'});
    await renderEmail(); await submitEmail();
    expect(mocks.addEmail).toHaveBeenCalledWith({email: 'Owner@example.invalid', currentPassword: 'proof'});
    expect(useAuthStore.getState().user).toMatchObject({email: null, pendingEmail: 'owner@example.invalid', isEmailVerified: false});
    expect(document.querySelector('[role="status"]')?.textContent).toContain('Resend verification');
    await act(async () => {document.querySelector('form')!.dispatchEvent(new Event('submit', {bubbles: true, cancelable: true}));});
    expect(mocks.resend).toHaveBeenCalledTimes(1);
    expect(document.querySelector('[role="status"]')?.textContent).toBe('Verification email sent');
  });
  it('shows resend delivery failures without marking the account verified', async () => {
    await renderEmail();
    await act(async () => useAuthStore.setState({user: {...phoneUser, email: 'owner@example.invalid'} as any}));
    mocks.resend.mockRejectedValue(new Error('Verification email could not be sent. Please retry.'));
    await act(async () => {document.querySelector('form')!.dispatchEvent(new Event('submit', {bubbles: true, cancelable: true}));});
    expect(document.querySelector('[role="alert"]')?.textContent).toContain('retry');
    expect(useAuthStore.getState().user?.isEmailVerified).toBe(false);
  });
  it('shows a pending address after reload and lets the owner replace it', async () => {
    useAuthStore.setState({user: {...phoneUser, pendingEmail: 'typo@example.invalid'} as any, isAuthenticated: true});
    await act(async () => root.render(<AccountEmail />));
    expect(document.body.textContent).toContain('typo@example.invalid');
    expect(document.querySelector('input[type="email"]')).toBeNull();
    const change2 = [...document.querySelectorAll('button')].find(button => button.textContent === 'Use a different email')!;
    await act(async () => {change2.dispatchEvent(new MouseEvent('click', {bubbles: true}));});
    mocks.addEmail.mockResolvedValue({success: true, verificationSent: true, message: 'Open the verification link'});
    await submitEmail();
    expect(mocks.addEmail).toHaveBeenCalledWith({email: 'Owner@example.invalid', currentPassword: 'proof'});
    expect(useAuthStore.getState().user).toMatchObject({email: null, pendingEmail: 'owner@example.invalid'});
    expect(document.body.textContent).toContain('owner@example.invalid');
  });
  it('does not offer to change an established address', async () => {
    useAuthStore.setState({user: {...phoneUser, email: 'owner@example.invalid'} as any, isAuthenticated: true});
    await act(async () => root.render(<AccountEmail />));
    expect([...document.querySelectorAll('button')].some(button => button.textContent === 'Use a different email')).toBe(false);
  });
  it('does not apply a late add-email result to a different signed-in account', async () => {
    let resolve!: (result: object) => void;
    mocks.addEmail.mockImplementation(() => new Promise(done => {resolve = done;}));
    await renderEmail(); await submitEmail();
    await act(async () => useAuthStore.setState({user: {...phoneUser, id: 99} as any}));
    await act(async () => resolve({success: true, message: 'Email saved'}));
    expect(useAuthStore.getState().user).toMatchObject({id: 99, email: null});
    expect(document.querySelector('[role="status"]')).toBeNull();
  });
});
