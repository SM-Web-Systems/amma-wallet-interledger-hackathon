// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import * as RealSdk from '@stellar/stellar-sdk';

const PASSPHRASE = 'Test SDF Network ; September 2015';
const mocks = vi.hoisted(() => ({
  unlock: vi.fn(), signAndSubmit: vi.fn(), signingMode: 'delegated', source: '', secret: '', toastError: vi.fn(), buildPaymentTx: vi.fn(),
}));
vi.mock('../store/wallet', async () => {
  const {create} = await import('zustand');
  return {useWalletStore: create(() => ({
    isUnlocked: false, network: 'testnet', unlock: mocks.unlock,
    getSecretKey: () => { if (mocks.secret) return mocks.secret; throw new Error('locked'); },
    getPublicKey: () => mocks.source,
  }))};
});
vi.mock('../store/auth', () => ({useAuthStore: (select: (s: {signingMode: string}) => unknown) => select({signingMode: mocks.signingMode})}));
vi.mock('../hooks/useBalances', () => ({useBalances: () => ({data: [{assetCode: 'XLM', assetIssuer: 'native', balance: '100'}]})}));
vi.mock('../lib/constants', async (orig) => ({...(await orig<typeof import('../lib/constants')>()), getNetworkConfig: () => ({horizonUrl: 'https://horizon.example.invalid', networkPassphrase: 'Test SDF Network ; September 2015'})}));
vi.mock('../lib/custody-wallets', () => ({listCustodyWallets: async () => { throw new Error('You keep your own keys, so Amma does not manage wallets for you.'); }}));
vi.mock('../lib/api', async () => ({signingApi: {signAndSubmit: mocks.signAndSubmit, feeQuote: (await import('../test/fee-quote')).noFeeQuote}}));
// Real Stellar SDK and real helpers; only the self-signing network call is replaced.
vi.mock('../lib/stellar', async (orig) => ({...(await orig<typeof import('../lib/stellar')>()), buildPaymentTx: mocks.buildPaymentTx}));
vi.mock('react-i18next', () => ({useTranslation: () => ({t: (key: string) => key})}));
vi.mock('sonner', () => ({toast: {error: mocks.toastError, success: vi.fn()}}));

import SendPage from '../pages/Send';

// Keypair.random() needs a Node realm; encode fixed bytes instead (valid checksummed keys).
const key = (n: number) => RealSdk.StrKey.encodeEd25519PublicKey(Buffer.alloc(32, n));
const DEST = key(7);
let root: Root;
beforeEach(() => {
  vi.clearAllMocks(); mocks.signingMode = 'delegated'; mocks.secret = '';
  mocks.source = key(9);
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.spyOn(RealSdk.Horizon.Server.prototype, 'loadAccount').mockImplementation(
    async (id: string) => new RealSdk.Account(id, '1') as unknown as Awaited<ReturnType<RealSdk.Horizon.Server['loadAccount']>>);
  mocks.unlock.mockRejectedValue(new Error('Wallet data is missing — please log out and log back in to restore it.'));
  mocks.signAndSubmit.mockResolvedValue({success: true});
  document.body.innerHTML = '<div id="root"></div>';
  root = createRoot(document.getElementById('root')!);
});
afterEach(async () => {await act(async () => root.unmount()); vi.unstubAllGlobals(); vi.restoreAllMocks();});

async function change(el: HTMLInputElement | HTMLSelectElement, value: string) {
  await act(async () => {
    const proto = el instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, 'value')!.set!.call(el, value);
    el.dispatchEvent(new Event(el instanceof HTMLSelectElement ? 'change' : 'input', {bubbles: true}));
  });
}
const btn = (label: string) => [...document.querySelectorAll('button')].find(b => b.textContent?.includes(label))!;
const q = <T extends HTMLElement>(sel: string) => document.querySelector<T>(sel)!;
const text = () => document.body.textContent!;
const renderAt = (url: string) => act(async () => root.render(<MemoryRouter initialEntries={[url]}><SendPage /></MemoryRouter>));
type Opts = {memo?: string; type?: string; dest?: string};
async function fill(opts: Opts = {}) {
  await renderAt('/send');
  await change(q('#send-destination'), opts.dest ?? DEST);
  await change(q('input[type="number"]'), '5');
  if (opts.type) await change(q('#send-memo-type'), opts.type);
  if (opts.memo !== undefined) await change(q('#send-memo'), opts.memo);
}
async function fillAndReview(opts: Opts = {}) {
  await fill(opts);
  await act(async () => btn('send.sendButton').click());
}
async function submitPin(pin: string) {
  await change(q('input[type="password"]'), pin);
  await act(async () => {q('form').dispatchEvent(new Event('submit', {bubbles: true, cancelable: true}));});
}
async function sendWithPin(pin: string, memo?: string, type?: string) {
  await fillAndReview({memo, type});
  await act(async () => btn('send.confirmSend').click());
  await submitPin(pin);
}
const submittedTx = () => RealSdk.TransactionBuilder.fromXDR(mocks.signAndSubmit.mock.calls[0][0], PASSPHRASE) as RealSdk.Transaction;

describe('Send PIN flow', () => {
  it('delegated mode sends the PIN to the server without unlocking in the browser', async () => {
    await sendWithPin('lamp river garden 42');
    expect(mocks.unlock).not.toHaveBeenCalled();
    // The quote's innerHash goes along: the server refuses rather than submit a different transaction.
    expect(mocks.signAndSubmit).toHaveBeenCalledWith(expect.any(String), PASSPHRASE, 'lamp river garden 42', 'pin', expect.stringMatching(/^[0-9a-f]{64}$/));
  });
  it('self-signing mode still unlocks the wallet locally', async () => {
    mocks.signingMode = 'self';
    mocks.unlock.mockResolvedValue(undefined);
    await sendWithPin('lamp river garden 42');
    expect(mocks.unlock).toHaveBeenCalledWith('lamp river garden 42');
    expect(mocks.signAndSubmit).not.toHaveBeenCalled();
  });
  it.each(['delegated', 'self'])('%s mode: a short legacy passphrase never signs; it opens the move-to-Amma prompt', async (mode) => {
    mocks.signingMode = mode;
    const { useWalletStore } = await import('../store/wallet');
    await sendWithPin('123456');
    expect(mocks.unlock).not.toHaveBeenCalled();
    expect(mocks.signAndSubmit).not.toHaveBeenCalled();
    expect((useWalletStore.getState() as { needsPassphraseUpgrade?: boolean }).needsPassphraseUpgrade).toBe(true);
    expect(document.body.textContent).toContain('Short wallet passphrases are no longer used');
  });
  it('the server refusing a legacy passphrase (pin-retired) opens the prompt instead of an error', async () => {
    const { useWalletStore } = await import('../store/wallet');
    mocks.signAndSubmit.mockRejectedValueOnce(Object.assign(new Error('Wallet PINs are no longer used.'), { code: 'pin-retired', status: 403 }));
    await sendWithPin('lamp river garden 42');
    expect((useWalletStore.getState() as { needsPassphraseUpgrade?: boolean }).needsPassphraseUpgrade).toBe(true);
    expect(document.body.textContent).toContain('Short wallet passphrases are no longer used');
  });
});

describe('Send prefill', () => {
  it('prefills destination, memo and memo type from the query string', async () => {
    await renderAt(`/send?to=${DEST}&memo=12345&memoType=id`);
    expect(q<HTMLInputElement>('#send-destination').value).toBe(DEST);
    expect(q<HTMLInputElement>('#send-memo').value).toBe('12345');
    expect(q<HTMLSelectElement>('#send-memo-type').value).toBe('id');
  });
  it('defaults the memo type to text', async () => {
    await renderAt('/send?to=GX&memo=hi');
    expect(q<HTMLSelectElement>('#send-memo-type').value).toBe('text');
  });
});

describe('Memo validation', () => {
  it('accepts exactly 28 bytes and blocks 29', async () => {
    await fillAndReview({memo: 'a'.repeat(28)});
    expect(text()).toContain('send.confirmSend');
    await act(async () => btn('send.back').click());
    await change(q('#send-memo'), 'a'.repeat(29));
    expect(text()).toContain('send.memoTooLong');
    expect(q('[role="alert"]')).not.toBeNull();
    expect(btn('send.sendButton').hasAttribute('disabled')).toBe(true);
  });
  it('blocks a multibyte memo that is 30 bytes (15 chars)', async () => {
    await fillAndReview({memo: 'é'.repeat(15)});
    expect(text()).toContain('send.memoTooLong');
    expect(text()).not.toContain('send.confirmSend');
  });
  it('treats a whitespace-only memo as no memo', async () => {
    await fillAndReview({memo: '   '});
    expect(text()).toContain('send.noMemo');
    await act(async () => btn('send.confirmSend').click());
    await submitPin('lamp river garden 42');
    expect(submittedTx().memo.type).toBe('none');
  });
  it('validates id memos (digits only, at most 2^64-1)', async () => {
    await fill({type: 'id', memo: '12a'});
    expect(text()).toContain('send.memoIdInvalid');
    await change(q('#send-memo'), '18446744073709551616');
    expect(text()).toContain('send.memoIdInvalid');
    await change(q('#send-memo'), '18446744073709551615');
    expect(text()).not.toContain('send.memoIdInvalid');
  });
  it('validates hash memos (64 hex characters)', async () => {
    await fill({type: 'hash', memo: 'abcd'});
    expect(text()).toContain('send.memoHashInvalid');
    await change(q('#send-memo'), 'ab'.repeat(32));
    expect(text()).not.toContain('send.memoHashInvalid');
  });
  it('links the error to the memo field', async () => {
    await fill({memo: 'a'.repeat(29)});
    const id = q('#send-memo').getAttribute('aria-describedby')!;
    expect(document.getElementById(id)!.textContent).toContain('send.memoTooLong');
  });
});

describe('Review step', () => {
  it('shows the details, and Back returns without signing', async () => {
    await fillAndReview({memo: 'abc'});
    expect(text()).toContain(`${DEST.slice(0, 4)}…${DEST.slice(-4)}`);
    expect(text()).toContain(DEST);
    expect(text()).toContain('5 XLM');
    expect(text()).toContain('abc');
    expect(text()).not.toContain('send.exchangeHint');
    await act(async () => btn('send.back').click());
    expect(q('#send-destination')).not.toBeNull();
    expect(document.querySelector('input[type="password"]')).toBeNull();
    expect(mocks.signAndSubmit).not.toHaveBeenCalled();
  });
  it('shows No memo and the exchange hint when the memo is empty', async () => {
    await fillAndReview();
    expect(text()).toContain('send.noMemo');
    expect(text()).toContain('send.exchangeHint');
  });
  it('delegated mode shows the Amma fee rows from the server quote, not the self-mode fee', async () => {
    await fillAndReview();
    expect(text()).not.toContain('send.platformFee');
    expect(text()).not.toContain('send.recipientGets');
    expect(text()).toContain('send.networkFee');
    expect(text()).toContain('send.ammaFee');
    expect(text()).toContain('send.totalYouPay');
  });
  it('has no "send max" button (amount plus fee would fail); the delegated form says the fee comes on top', async () => {
    await fill();
    expect([...document.querySelectorAll('button')].some(b => /max/i.test(b.textContent ?? ''))).toBe(false);
    expect(text()).toContain('send.ammaFeeOnReview');
  });
  it('shows the platform fee and what the recipient gets in self-custody mode', async () => {
    mocks.signingMode = 'self';
    await fillAndReview();
    expect(text()).toContain('send.platformFee');
    expect(text()).toContain('send.recipientGets');
    expect(text()).toContain('0.0050000');
    expect(text()).toContain('4.9950000');
  });
  it('self-custody review shows no platform fee when the payment creates the account (as buildPaymentTx charges)', async () => {
    mocks.signingMode = 'self';
    vi.mocked(RealSdk.Horizon.Server.prototype.loadAccount).mockImplementation(async (id: string) => {
      if (id === DEST) throw Object.assign(new Error('Not Found'), {response: {status: 404}});
      return new RealSdk.Account(id, '1') as unknown as Awaited<ReturnType<RealSdk.Horizon.Server['loadAccount']>>;
    });
    await fillAndReview();
    await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
    expect(text()).toContain('send.platformFeeNoneNewAccount');
    expect(text()).not.toContain('0.0050000');
    expect(text()).not.toContain('send.recipientGets');
  });
  it('moves focus to the heading on open and to the Send button on Back', async () => {
    await fillAndReview();
    expect(document.activeElement).toBe(q('#send-review-title'));
    await act(async () => btn('send.back').click());
    expect(document.activeElement).toBe(btn('send.sendButton'));
  });
  it('trims the destination before review and signing', async () => {
    await fillAndReview({dest: `  ${DEST}  `});
    expect(text()).toContain(DEST);
    await act(async () => btn('send.confirmSend').click());
    await submitPin('lamp river garden 42');
    expect(submittedTx().operations[0].destination).toBe(DEST);
  });
  it('shows a toast when copying fails', async () => {
    vi.stubGlobal('navigator', {clipboard: {writeText: vi.fn().mockRejectedValue(new Error('denied'))}});
    await fillAndReview();
    await act(async () => btn('send.copyAddress').click());
    expect(mocks.toastError).toHaveBeenCalled();
  });
});

describe('Confirm signs with the right memo', () => {
  it('delegated text memo is in the real XDR', async () => {
    await sendWithPin('lamp river garden 42', 'abc');
    expect(submittedTx().memo.type).toBe('text');
    expect(submittedTx().memo.value.toString()).toBe('abc');
  });
  it('delegated id memo is in the real XDR', async () => {
    await sendWithPin('lamp river garden 42', '12345', 'id');
    expect(submittedTx().memo.type).toBe('id');
    expect(submittedTx().memo.value.toString()).toBe('12345');
  });
  it('self-custody passes the memo and type to buildPaymentTx', async () => {
    mocks.signingMode = 'self';
    mocks.unlock.mockResolvedValue(undefined);
    mocks.secret = 'SSYNTHETICSECRET';
    await sendWithPin('lamp river garden 42', '12345', 'id');
    expect(mocks.buildPaymentTx).toHaveBeenCalledWith('SSYNTHETICSECRET', DEST, '5', 'XLM', undefined, '12345', 'id');
  });
});
