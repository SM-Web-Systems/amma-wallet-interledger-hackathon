import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ register: vi.fn(), wallet: { accounts: [] as { id: string }[], activeAccountId: null as string | null } }));
vi.mock('../store/auth', () => ({ useAuthStore: (select: (s: unknown) => unknown) => select({ register: mocks.register, isLoading: false }) }));
vi.mock('../store/wallet', () => ({ useWalletStore: { getState: () => mocks.wallet } }));
vi.mock('../lib/pending-oauth', () => ({ peekPendingOAuth: () => null }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string, fallback?: string) => fallback ?? key }) }));
vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn() } }));
vi.mock('../components/Turnstile', () => ({ Turnstile: ({ onVerify }: { onVerify: (token: string) => void }) =>
  <button type="button" onClick={() => onVerify('synthetic-captcha')}>Complete verification</button> }));

import RegisterPage from '../pages/Register';

const claim = '/lms/claim#message=U00gV2Vi&return=https%3A%2F%2Flms.example.invalid%2Fclaim';
function Where() { const location = useLocation(); return <p data-testid="where">{location.pathname + location.hash}</p>; }
let root: Root;

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  mocks.register.mockReset().mockResolvedValue(undefined);
  mocks.wallet = { accounts: [{ id: 'a1' }], activeAccountId: 'a1' };
  document.body.innerHTML = '<div id="root"></div>';
  root = createRoot(document.getElementById('root')!);
});
afterEach(async () => { await act(async () => root.unmount()); vi.unstubAllGlobals(); });

async function change(input: HTMLInputElement, value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}
async function signUp(state?: unknown) {
  await act(async () => root.render(
    <MemoryRouter initialEntries={[{ pathname: '/register', state }]}>
      <Routes><Route path="/register" element={<RegisterPage />} /><Route path="*" element={<Where />} /></Routes>
    </MemoryRouter>));
  await change(document.querySelector<HTMLInputElement>('input[type="email"]')!, 'new@example.invalid');
  const [password, confirm] = [...document.querySelectorAll<HTMLInputElement>('input[type="password"]')];
  await change(password, 'Synthetic-Passw0rd');
  await change(confirm, 'Synthetic-Passw0rd');
  await act(async () => [...document.querySelectorAll('button')].find((b) => b.textContent === 'Complete verification')!.click());
  await act(async () => { document.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); });
  return document.querySelector('[data-testid="where"]')?.textContent;
}

describe('where sign-up lands', () => {
  it('returns to an LMS claim after sign-up', async () => {
    mocks.wallet = { accounts: [], activeAccountId: null };
    expect(await signUp({ returnTo: claim })).toBe(claim);
  });
  it('lands on the dashboard when the Amma wallet was set up', async () => {
    expect(await signUp()).toBe('/dashboard');
  });
  it('goes to onboarding when no wallet could be set up', async () => {
    mocks.wallet = { accounts: [], activeAccountId: null };
    expect(await signUp()).toBe('/onboarding');
  });
});
