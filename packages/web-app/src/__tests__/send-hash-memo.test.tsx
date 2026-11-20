// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';

vi.mock('../store/wallet', async () => {
  const { create } = await import('zustand');
  return { useWalletStore: create(() => ({
    isUnlocked: false, network: 'testnet', unlock: vi.fn(),
    getSecretKey: () => { throw new Error('locked'); },
    getPublicKey: () => 'GSYNTHETICSOURCE',
  })) };
});
vi.mock('../store/auth', () => ({ useAuthStore: (select: (s: { signingMode: string }) => unknown) => select({ signingMode: 'delegated' }) }));
vi.mock('../hooks/useBalances', () => ({ useBalances: () => ({ data: [{ assetCode: 'XLM', assetIssuer: 'native', balance: '100' }] }) }));
vi.mock('../lib/custody-wallets', () => ({ listCustodyWallets: async () => { throw new Error('keeps own keys'); } }));
vi.mock('../lib/api', async () => ({ signingApi: { signAndSubmit: vi.fn(), feeQuote: (await import('../test/fee-quote')).noFeeQuote } }));
vi.mock('../lib/stellar', async () => {
  const actual = await vi.importActual<typeof import('../lib/stellar')>('../lib/stellar');
  return { ...actual, buildPaymentTx: vi.fn(), calculatePlatformFee: () => '0' };
});
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string, fallback?: unknown) => (typeof fallback === 'string' ? fallback : key) }) }));
vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn() } }));

import SendPage from '../pages/Send';

const H64 = '0123456789abcdef'.repeat(4);
const WARNING = 'This looks like a hash memo. A Text memo with the same characters will NOT match a payment request that expects a Hash memo.';

let root: Root;
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  document.body.innerHTML = '<div id="root"></div>';
  root = createRoot(document.getElementById('root')!);
});
afterEach(async () => { await act(async () => root.unmount()); vi.unstubAllGlobals(); });

const $ = <T extends Element>(sel: string) => document.querySelector<T>(sel);
async function render(url = '/send') {
  await act(async () => root.render(<MemoryRouter initialEntries={[url]}><SendPage /></MemoryRouter>));
}
async function type(value: string) {
  const input = $<HTMLInputElement>('#send-memo')!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}
async function pickType(v: string) {
  const sel = $<HTMLSelectElement>('#send-memo-type')!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')!.set!.call(sel, v);
    sel.dispatchEvent(new Event('change', { bubbles: true }));
  });
}
const help = () => $('#send-memo-help')!.textContent ?? '';
const alertText = () => $('#send-memo-help [role="alert"]')?.textContent ?? '';

describe('Send hash memo field', () => {
  it('accepts 64 hex characters, in either case, with no error', async () => {
    await render();
    await pickType('hash');
    await type(H64);
    expect($('#send-memo')!.getAttribute('aria-invalid')).toBe('false');
    expect(alertText()).toBe('');
    await type(H64.toUpperCase());
    expect(alertText()).toBe('');
  });

  it.each([['63 characters', H64.slice(1)], ['65 characters', H64 + 'a'], ['non-hex', 'z' + H64.slice(1)]])('rejects %s', async (_n, v) => {
    await render();
    await pickType('hash');
    await type(v);
    expect(alertText()).toBe('Memo hash must be exactly 64 hexadecimal characters.');
    expect($('#send-memo')!.getAttribute('aria-invalid')).toBe('true');
  });

  it('rejects a 0x prefix with a clear instruction', async () => {
    await render();
    await pickType('hash');
    await type('0x' + H64);
    expect(alertText()).toBe('Remove the 0x at the start.');
  });

  it('warns when a Text memo looks like a hash, and says the types will not match', async () => {
    await render();
    await type(H64);
    expect($('#send-memo-help [data-testid="memo-hash-warning"]')?.textContent).toBe(WARNING);
  });

  it('does not warn for short text, for a Hash memo, or for an ID memo', async () => {
    await render();
    await type('hello');
    expect(help()).not.toContain('looks like a hash memo');
    await pickType('hash');
    await type(H64);
    expect(help()).not.toContain('looks like a hash memo');
    await pickType('id');
    await type('12345');
    expect(help()).not.toContain('looks like a hash memo');
  });

  it('leaves ID memo validation unchanged', async () => {
    await render();
    await pickType('id');
    await type('-1');
    expect(alertText()).toBe('Memo ID must be a whole number from 0 to 18446744073709551615.');
    await type('18446744073709551615');
    expect(alertText()).toBe('');
  });
});

describe('Send URL prefill uses the same validation', () => {
  it('memoType=hash with a valid hash is selected and clean', async () => {
    await render(`/send?memo=${H64}&memoType=hash`);
    expect($<HTMLSelectElement>('#send-memo-type')!.value).toBe('hash');
    expect(alertText()).toBe('');
  });
  it('memoType=hash with a 0x-prefixed value shows the 0x message', async () => {
    await render(`/send?memo=0x${H64}&memoType=hash`);
    expect(alertText()).toBe('Remove the 0x at the start.');
  });
  it('a hash-looking memo with no type prefilled as text shows the warning', async () => {
    await render(`/send?memo=${H64}`);
    expect($('[data-testid="memo-hash-warning"]')).not.toBeNull();
  });
});
