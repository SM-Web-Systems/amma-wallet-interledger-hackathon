// @vitest-environment jsdom
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import en from '../i18n/locales/en.json';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, fallback?: string) =>
      key.split('.').reduce<unknown>((o, k) => (o as Record<string, unknown> | undefined)?.[k], en) as string | undefined ?? fallback ?? key,
  }),
}));

import ForgotPasswordPage from '../pages/ForgotPassword';

type Reply = { status?: number; body?: unknown };
let fetchMock: ReturnType<typeof vi.fn>;

function replyWith(replies: Record<string, Reply>) {
  fetchMock = vi.fn(async (url: string) => {
    const path = Object.keys(replies).find((p) => String(url).endsWith(p));
    const r = (path && replies[path]) || { status: 404, body: {} };
    const status = r.status ?? 200;
    return { ok: status < 400, status, json: async () => r.body ?? { success: true } } as Response;
  });
  vi.stubGlobal('fetch', fetchMock);
}

const sentMessage = 'If that number is registered, we sent a code.';
const label = (text: string) => screen.getByLabelText(new RegExp(text, 'i'));
const bodyOf = (i = 0) => JSON.parse(fetchMock.mock.calls[i][1].body);

function renderPage() {
  render(<MemoryRouter><ForgotPasswordPage /></MemoryRouter>);
}
function submitIdentifier(value: string) {
  fireEvent.change(label('Email or phone number'), { target: { value } });
  fireEvent.click(screen.getByRole('button', { name: /continue/i }));
}
async function toCodeStep(phone = '+27 82 123 4567') {
  submitIdentifier(phone);
  await screen.findByText(sentMessage);
}

beforeEach(() => vi.unstubAllGlobals());
afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals(); });

describe('Forgot password with a phone number', () => {
  it('sends an email reset when the input contains @', async () => {
    replyWith({ '/auth/forgot-password': {} });
    renderPage();
    submitIdentifier('a@example.com');
    await screen.findByText(en.auth.resetEmailSent);
    expect(fetchMock.mock.calls[0][0]).toMatch(/\/api\/v1\/auth\/forgot-password$/);
    expect(bodyOf()).toEqual({ email: 'a@example.com' });
  });

  it('sends an SMS code when the input is a phone number', async () => {
    replyWith({ '/auth/forgot-password-sms': {} });
    renderPage();
    submitIdentifier('+27 82 123 4567');
    await screen.findByText(sentMessage);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toMatch(/\/api\/v1\/auth\/forgot-password-sms$/);
    expect(bodyOf()).toEqual({ phoneNumber: '+27821234567' });
  });

  it('asks for the country code instead of sending a number without one', async () => {
    replyWith({});
    renderPage();
    submitIdentifier('27 82 123 4567');
    expect((await screen.findByRole('alert')).textContent).toMatch(/country code/i);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('sends a South African number typed as 082 123 4567 as +27821234567', async () => {
    replyWith({ '/auth/forgot-password-sms': {} });
    renderPage();
    submitIdentifier('082 123 4567');
    await screen.findByText(sentMessage);
    expect(bodyOf()).toEqual({ phoneNumber: '+27821234567' });
  });

  it('shows every password rule as not met before anything is typed', async () => {
    replyWith({ '/auth/forgot-password-sms': {} });
    renderPage();
    await toCodeStep();
    expect(screen.getAllByText(/^, not met$/i).length).toBe(5);
    expect(screen.queryAllByText(/^, met$/i).length).toBe(0);
    expect(document.querySelectorAll('li .lucide-check').length).toBe(0);
    expect(document.querySelectorAll('li .lucide-x').length).toBe(5);
  });

  it('shows the same sent message whether or not the number is registered', async () => {
    replyWith({ '/auth/forgot-password-sms': { body: { success: true, message: 'If that number is registered, a code has been sent.' } } });
    renderPage();
    await toCodeStep('+27821234567');
    const first = screen.getByText(sentMessage).textContent;
    cleanup();
    replyWith({ '/auth/forgot-password-sms': { body: { success: true, message: 'something else entirely' } } });
    renderPage();
    await toCodeStep('+14155552671');
    expect(screen.getByText(sentMessage).textContent).toBe(first);
  });

  it('resets the password with the code and shows the sign-in link', async () => {
    replyWith({ '/auth/forgot-password-sms': {}, '/auth/reset-password-sms': {} });
    renderPage();
    await toCodeStep();
    fireEvent.change(label('6-digit code'), { target: { value: '123456' } });
    fireEvent.change(screen.getByLabelText(/^new password/i), { target: { value: 'Newpass123' } });
    fireEvent.change(screen.getByLabelText(/^confirm password/i), { target: { value: 'Newpass123' } });
    fireEvent.click(screen.getByRole('button', { name: /change password/i }));
    await screen.findByText(en.auth.passwordChanged);
    expect(fetchMock.mock.calls[1][0]).toMatch(/\/api\/v1\/auth\/reset-password-sms$/);
    expect(bodyOf(1)).toEqual({ phoneNumber: '+27821234567', code: '123456', newPassword: 'Newpass123' });
    expect(screen.getByRole('link', { name: /sign in/i }).getAttribute('href')).toBe('/login');
  });

  it('keeps the user on the code step with an inline error when the code is wrong', async () => {
    replyWith({ '/auth/forgot-password-sms': {}, '/auth/reset-password-sms': { status: 400, body: { error: 'Invalid or expired code' } } });
    renderPage();
    await toCodeStep();
    fireEvent.change(label('6-digit code'), { target: { value: '000000' } });
    fireEvent.change(screen.getByLabelText(/^new password/i), { target: { value: 'Newpass123' } });
    fireEvent.change(screen.getByLabelText(/^confirm password/i), { target: { value: 'Newpass123' } });
    fireEvent.click(screen.getByRole('button', { name: /change password/i }));
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toBe(en.auth.codeWrong);
    expect(label('6-digit code')).toBeTruthy();
    expect(screen.queryByText(en.auth.passwordChanged)).toBeNull();
    expect(screen.getByRole('button', { name: /send a new code/i })).toBeTruthy();
    await waitFor(() => expect(document.activeElement).toBe(label('6-digit code')));
  });

  it('marks the code field one-time-code and the password fields new-password', async () => {
    replyWith({ '/auth/forgot-password-sms': {} });
    renderPage();
    expect(label('Email or phone number').getAttribute('autocomplete')).toBe('username');
    await toCodeStep();
    const code = label('6-digit code');
    expect(code.getAttribute('autocomplete')).toBe('one-time-code');
    expect(code.getAttribute('inputmode')).toBe('numeric');
    expect(screen.getByLabelText(/^new password/i).getAttribute('autocomplete')).toBe('new-password');
    expect(screen.getByLabelText(/^confirm password/i).getAttribute('autocomplete')).toBe('new-password');
  });
});

async function fillAndSubmitReset(code = '123456', pw = 'Newpass123') {
  fireEvent.change(label('6-digit code'), { target: { value: code } });
  fireEvent.change(screen.getByLabelText(/^new password/i), { target: { value: pw } });
  fireEvent.change(screen.getByLabelText(/^confirm password/i), { target: { value: pw } });
  fireEvent.click(screen.getByRole('button', { name: /change password/i }));
}

describe('Forgot password: limits, errors and resend', () => {
  it('says too many tries on 429 when asking for the code, not the email message', async () => {
    replyWith({ '/auth/forgot-password-sms': { status: 429 } });
    renderPage();
    submitIdentifier('+27821234567');
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toBe(en.auth.tooManyTries);
    expect(alert.textContent).not.toMatch(/reset email/i);
  });

  it('says too many tries on 429 when changing the password', async () => {
    replyWith({ '/auth/forgot-password-sms': {}, '/auth/reset-password-sms': { status: 429 } });
    renderPage();
    await toCodeStep();
    await fillAndSubmitReset();
    expect((await screen.findByRole('alert')).textContent).toBe(en.auth.tooManyTries);
  });

  it('shows an inline error when the email request fails', async () => {
    replyWith({ '/auth/forgot-password': { status: 500 } });
    renderPage();
    submitIdentifier('a@example.com');
    expect((await screen.findByRole('alert')).textContent).toBe(en.auth.resetRequestFailed);
  });

  it('asks for an email or phone number when the input is neither', async () => {
    replyWith({});
    renderPage();
    submitIdentifier('hello');
    expect((await screen.findByRole('alert')).textContent).toBe(en.auth.identifierInvalid);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('puts password-rule errors next to the new password field and focuses it', async () => {
    replyWith({ '/auth/forgot-password-sms': {} });
    renderPage();
    await toCodeStep();
    fireEvent.change(label('6-digit code'), { target: { value: '123456' } });
    fireEvent.change(screen.getByLabelText(/^new password/i), { target: { value: 'weak' } });
    fireEvent.click(screen.getByRole('button', { name: /change password/i }));
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toBe(en.auth.fixPasswordReqs);
    expect(screen.getByLabelText(/^new password/i).getAttribute('aria-describedby')).toBe(alert.id);
    await waitFor(() => expect(document.activeElement).toBe(screen.getByLabelText(/^new password/i)));
  });

  it('accepts a pasted code with a space', async () => {
    replyWith({ '/auth/forgot-password-sms': {}, '/auth/reset-password-sms': {} });
    renderPage();
    await toCodeStep();
    await fillAndSubmitReset('123 456');
    await screen.findByText(en.auth.passwordChanged);
    expect(bodyOf(1).code).toBe('123456');
  });

  it('adds met and not met text to the password rules', async () => {
    replyWith({ '/auth/forgot-password-sms': {} });
    renderPage();
    await toCodeStep();
    fireEvent.change(screen.getByLabelText(/^new password/i), { target: { value: 'Abcdefg1' } });
    expect(screen.getAllByText(/^, not met$/i).length).toBe(1);
    expect(screen.getAllByText(/^, met$/i).length).toBe(4);
  });

  it('waits 60 seconds before resending, clears the code, and shows the 429 message', async () => {
    vi.useFakeTimers();
    const flush = () => act(async () => { await Promise.resolve(); await Promise.resolve(); });
    const tick = (ms: number) => act(async () => { await vi.advanceTimersByTimeAsync(ms); });
    replyWith({ '/auth/forgot-password-sms': {} });
    renderPage();
    submitIdentifier('+27 82 123 4567');
    await flush();
    expect(screen.getByText(sentMessage)).toBeTruthy();
    fireEvent.change(label('6-digit code'), { target: { value: '123456' } });
    const resend = () => screen.getByRole('button', { name: /send a new code/i }) as HTMLButtonElement;
    expect(resend().disabled).toBe(true);
    expect(resend().textContent).toMatch(/60/);
    await tick(30_000);
    expect(resend().textContent).toMatch(new RegExp('in 30s'));
    await tick(30_000);
    expect(resend().disabled).toBe(false);
    fireEvent.click(resend());
    await flush();
    expect(screen.getByRole('status').textContent).toBe(en.auth.newCodeSent);
    expect((label('6-digit code') as HTMLInputElement).value).toBe('');
    expect(resend().disabled).toBe(true);
    // the server refuses the next one
    replyWith({ '/auth/forgot-password-sms': { status: 429 } });
    await tick(60_000);
    fireEvent.click(resend());
    await flush();
    expect(screen.getByRole('alert').textContent).toBe(en.auth.tooManyTries);
  });
});
