// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';

const mocks = vi.hoisted(() => ({ payment: vi.fn(() => ({})), createAccount: vi.fn(() => ({})), missing: '', signAndSubmit: vi.fn(), validAddress: true, toastError: vi.fn(), toastSuccess: vi.fn() }));
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
vi.mock('../lib/constants', () => ({ getNetworkConfig: () => ({ horizonUrl: 'https://horizon.example.invalid', networkPassphrase: 'synthetic passphrase' }) }));
vi.mock('../lib/custody-wallets', () => ({ listCustodyWallets: async () => { throw new Error('You keep your own keys, so Amma does not manage wallets for you.'); } }));
vi.mock('../lib/api', async () => ({ signingApi: { signAndSubmit: mocks.signAndSubmit, feeQuote: (await import('../test/fee-quote')).noFeeQuote } }));
vi.mock('../lib/stellar', () => {
  class TransactionBuilder {
    addOperation() { return this; }
    setTimeout() { return this; }
    build() { return { toEnvelope: () => ({ toXDR: () => 'SYNTHETIC_XDR' }), hash: () => Buffer.alloc(32, 1), timeBounds: { maxTime: '0' } }; }
  }
  return {
    buildPaymentTx: vi.fn(), calculatePlatformFee: () => '0', extractStellarError: (err: Error) => err.message,
    validateMemo: () => null, makeMemo: () => undefined, memoLooksLikeHash: () => false,
    StellarSdk: {
      StrKey: { isValidEd25519PublicKey: () => mocks.validAddress },
      Horizon: { Server: class { async loadAccount(id: string) { if (id === mocks.missing) throw Object.assign(new Error('Not Found'), { response: { status: 404 } }); return {}; } } },
      Asset: Object.assign(class {}, { native: () => ({}) }),
      Operation: { payment: mocks.payment, createAccount: mocks.createAccount },
      TransactionBuilder, BASE_FEE: '100',
    },
  };
});
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string, fallback?: unknown) => (typeof fallback === 'string' ? fallback : key) }) }));
vi.mock('sonner', () => ({ toast: { error: mocks.toastError, success: mocks.toastSuccess } }));

import SendPage from '../pages/Send';

let root: Root;
beforeEach(() => {
  vi.clearAllMocks(); mocks.validAddress = true;
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  mocks.signAndSubmit.mockResolvedValue({ success: true });
  mocks.payment.mockClear();
  document.body.innerHTML = '<div id="root"></div>';
  root = createRoot(document.getElementById('root')!);
});
afterEach(async () => { await act(async () => root.unmount()); vi.unstubAllGlobals(); });

const $ = <T extends Element>(sel: string) => document.querySelector<T>(sel);
async function change(input: HTMLInputElement, value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}
const sendButton = () => [...document.querySelectorAll('button')].find((b) => b.textContent?.includes('send.sendButton'))!;
async function render() { await act(async () => root.render(<MemoryRouter><SendPage /></MemoryRouter>)); }
const confirmButton = () => [...document.querySelectorAll('button')].find((b) => b.textContent?.includes('Confirm and send'))!;
/** The form leads to a review step; confirming it is what asks for the passphrase. */
async function reviewAndConfirm() {
  await act(async () => sendButton().click());
  await act(async () => confirmButton().click());
}
async function fill(dest: string, amount: string) {
  await change($<HTMLInputElement>('#send-destination')!, dest);
  await change($<HTMLInputElement>('#send-amount')!, amount);
}
async function submitPassphrase(value: string) {
  await change($<HTMLInputElement>('input[type="password"]')!, value);
  await act(async () => { $('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); });
}

describe('Send form errors sit next to the field', () => {
  it('shows what is missing under each field, marks them invalid, focuses the first, and sends no toast', async () => {
    await render();
    await act(async () => sendButton().click());
    const dest = $<HTMLInputElement>('#send-destination')!;
    const amount = $<HTMLInputElement>('#send-amount')!;
    expect($('#send-destination-error')?.textContent).toBe('Enter the address you are sending to.');
    expect($('#send-amount-error')?.textContent).toBe('Enter an amount.');
    expect(dest.getAttribute('aria-invalid')).toBe('true');
    expect(dest.getAttribute('aria-describedby')).toBe('send-destination-error');
    expect(amount.getAttribute('aria-describedby')).toBe('send-amount-error');
    expect(document.activeElement).toBe(dest);
    expect(mocks.toastError).not.toHaveBeenCalled();
  });

  it('puts the address error under the address and clears it when the person edits the field', async () => {
    mocks.validAddress = false;
    await render();
    await fill('not-an-address', '5');
    await act(async () => sendButton().click());
    expect($('#send-destination-error')?.textContent).toBe('Invalid Stellar address');
    expect($('#send-amount-error')).toBeNull();
    await change($<HTMLInputElement>('#send-destination')!, 'not-an-address-2');
    expect($('#send-destination-error')).toBeNull();
  });
});

describe('Send with a wallet passphrase', () => {
  async function toPassphraseDialog() {
    await render();
    await fill('GSYNTHETICDESTINATION', '5');
    await reviewAndConfirm();
  }

  it('keeps the dialog open and shows the error inside it when the passphrase is wrong', async () => {
    mocks.signAndSubmit.mockRejectedValue(new Error('Incorrect wallet passphrase. The wallet could not be unlocked.'));
    await toPassphraseDialog();
    await submitPassphrase('wrong passphrase 123');
    expect($('input[type="password"]')).not.toBeNull();
    expect($('form')!.textContent).toContain('Incorrect wallet passphrase');
    expect(mocks.toastError).not.toHaveBeenCalled();
  });

  it('closes the dialog and shows other failures next to the Send button, not in a toast', async () => {
    mocks.signAndSubmit.mockRejectedValue(new Error('Network request failed'));
    await toPassphraseDialog();
    await submitPassphrase('right passphrase 123');
    expect($('input[type="password"]')).toBeNull();
    expect($('#send-error')?.textContent).toBe('Network request failed');
    expect($('#send-error')?.getAttribute('role')).toBe('alert');
    expect(mocks.toastError).not.toHaveBeenCalled();
  });

  it('closes the dialog and confirms with a toast when the payment goes through', async () => {
    await toPassphraseDialog();
    await submitPassphrase('right passphrase 123');
    expect($('input[type="password"]')).toBeNull();
    expect($('#send-error')).toBeNull();
    expect(mocks.toastSuccess).toHaveBeenCalledTimes(1);
  });

  it('cannot be cancelled while the payment is on its way', async () => {
    let finish: (v: unknown) => void = () => {};
    mocks.signAndSubmit.mockReturnValue(new Promise((resolve) => { finish = resolve; }));
    await toPassphraseDialog();
    await submitPassphrase('right passphrase 123');
    const cancel = [...document.querySelectorAll('form button')].find((b) => b.textContent === 'Cancel') as HTMLButtonElement;
    expect(cancel.disabled).toBe(true);
    await act(async () => finish({ success: true }));
    expect($('input[type="password"]')).toBeNull();
  });

  it('announces the wrong-passphrase message and marks the field invalid', async () => {
    mocks.signAndSubmit.mockRejectedValue(new Error('Incorrect wallet passphrase. The wallet could not be unlocked.'));
    await toPassphraseDialog();
    await submitPassphrase('wrong passphrase 123');
    expect($('form [role="alert"]')?.textContent).toContain('Incorrect wallet passphrase');
    expect($('input[type="password"]')!.getAttribute('aria-invalid')).toBe('true');
  });
});

describe('Send to an account that does not exist on the network yet', () => {
  beforeEach(() => { mocks.missing = 'GSYNTHETICDESTINATION'; mocks.createAccount.mockClear(); });
  afterEach(() => { mocks.missing = ''; });

  it('creates the account with the amount as starting balance instead of paying it', async () => {
    await render();
    await fill('GSYNTHETICDESTINATION', '5');
    await reviewAndConfirm();
    await submitPassphrase('right passphrase 123');
    expect(mocks.createAccount).toHaveBeenCalledWith({ destination: 'GSYNTHETICDESTINATION', startingBalance: '5' });
    expect(mocks.payment).not.toHaveBeenCalled();
    expect(mocks.signAndSubmit).toHaveBeenCalledTimes(1);
  });

  it('says a new account needs at least 1 XLM in the review step, before asking for the passphrase, and sends nothing', async () => {
    await render();
    await fill('GSYNTHETICDESTINATION', '0.5');
    await reviewAndConfirm();
    expect($('#send-error')?.textContent).toBe('A new account needs at least 1 XLM to be created.');
    expect(confirmButton().disabled).toBe(true);
    expect($('input[type="password"]')).toBeNull();
    expect(mocks.signAndSubmit).not.toHaveBeenCalled();
  });
});

describe('Send address with stray spaces', () => {
  it('builds the payment to the address without the spaces', async () => {
    await render();
    await fill('  GSYNTHETICDESTINATION  ', '5');
    await reviewAndConfirm();
    await submitPassphrase('right passphrase 123');
    expect(mocks.payment).toHaveBeenCalledWith(expect.objectContaining({ destination: 'GSYNTHETICDESTINATION' }));
  });
});
