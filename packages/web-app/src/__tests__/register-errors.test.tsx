import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ register: vi.fn(), toastError: vi.fn() }));
vi.mock('../store/auth', () => ({ useAuthStore: (select: (s: unknown) => unknown) => select({ register: mocks.register, isLoading: false }) }));
vi.mock('../store/wallet', () => ({ useWalletStore: { getState: () => ({ accounts: [], activeAccountId: null }) } }));
vi.mock('../lib/pending-oauth', () => ({ peekPendingOAuth: () => null }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string, fallback?: string) => fallback ?? key }) }));
vi.mock('sonner', () => ({ toast: { error: mocks.toastError, success: vi.fn() } }));
vi.mock('../components/Turnstile', () => ({ Turnstile: ({ onVerify }: { onVerify: (token: string) => void }) =>
  <button type="button" onClick={() => onVerify('synthetic-captcha')}>Complete verification</button> }));

import RegisterPage from '../pages/Register';

let root: Root;
beforeEach(async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  mocks.register.mockReset();
  mocks.toastError.mockReset();
  document.body.innerHTML = '<div id="root"></div>';
  root = createRoot(document.getElementById('root')!);
  await act(async () => root.render(<MemoryRouter><RegisterPage /></MemoryRouter>));
});
afterEach(async () => { await act(async () => root.unmount()); vi.unstubAllGlobals(); });

async function change(input: HTMLInputElement, value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}
const email = () => document.querySelector<HTMLInputElement>('input[type="email"]')!;
async function fillRest() {
  const [password, confirm] = [...document.querySelectorAll<HTMLInputElement>('input[type="password"]')];
  await change(password, 'Synthetic-Passw0rd');
  await change(confirm, 'Synthetic-Passw0rd');
  await act(async () => [...document.querySelectorAll('button')].find((b) => b.textContent === 'Complete verification')!.click());
}
async function submit() {
  await act(async () => { document.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); });
}

describe('register errors (UXN-05, UXN-10)', () => {
  it('says what is wrong with an invalid email when the field loses focus', async () => {
    await change(email(), 'thandi@');
    await act(async () => { email().dispatchEvent(new FocusEvent('focusout', { bubbles: true })); });
    const alert = document.querySelector('#register-email-error')!;
    expect(alert.getAttribute('role')).toBe('alert');
    expect(alert.textContent).toContain('Enter a full email address');
    expect(email().getAttribute('aria-invalid')).toBe('true');
    expect(email().getAttribute('aria-describedby')).toBe('register-email-error');
  });

  it('clears the email message once the address is valid', async () => {
    await change(email(), 'thandi@');
    await act(async () => { email().dispatchEvent(new FocusEvent('focusout', { bubbles: true })); });
    await change(email(), 'thandi@example.invalid');
    expect(document.querySelector('#register-email-error')).toBeNull();
  });

  it('blocks submit on an invalid email, shows the message and focuses the field', async () => {
    await change(email(), 'thandi@');
    await fillRest();
    await submit();
    expect(mocks.register).not.toHaveBeenCalled();
    expect(document.querySelector('#register-email-error')!.textContent).toContain('Enter a full email address');
    expect(document.activeElement).toBe(email());
  });

  it('shows a server error inline without stealing focus, and keeps the toast', async () => {
    mocks.register.mockRejectedValue(new Error('Email already registered'));
    await change(email(), 'new@example.invalid');
    await fillRest();
    await submit();
    expect(mocks.toastError).toHaveBeenCalledWith('Email already registered');
    const alert = document.querySelector<HTMLElement>('form [role="alert"]')!;
    expect(alert.textContent).toContain('Email already registered');
    expect(document.activeElement).not.toBe(alert);
  });

  it('turns off the browser bubble so the inline email message shows', () => {
    expect(document.querySelector('form')!.noValidate).toBe(true);
    expect(email().type).toBe('email');
  });

  it('gives the Sign in link a 44px tap area', () => {
    expect(document.querySelector('a[href="/login"]')!.className).toContain('min-h-11');
  });
});
