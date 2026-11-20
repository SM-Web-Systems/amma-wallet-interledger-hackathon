// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import * as RealSdk from '@stellar/stellar-sdk';

const PASSPHRASE = 'Test SDF Network ; September 2015';
const mocks = vi.hoisted(() => ({ signAndSubmit: vi.fn(), feeQuote: vi.fn(), source: '', toastError: vi.fn(), toastSuccess: vi.fn() }));
vi.mock('../store/wallet', async () => {
  const {create} = await import('zustand');
  return {useWalletStore: create(() => ({
    isUnlocked: false, network: 'testnet', unlock: vi.fn(),
    getSecretKey: () => { throw new Error('locked'); },
    getPublicKey: () => mocks.source,
  }))};
});
vi.mock('../store/auth', () => ({useAuthStore: (select: (s: {signingMode: string}) => unknown) => select({signingMode: 'delegated'})}));
vi.mock('../hooks/useBalances', () => ({useBalances: () => ({data: [{assetCode: 'XLM', assetIssuer: 'native', balance: '100'}]})}));
vi.mock('../lib/constants', async (orig) => ({...(await orig<typeof import('../lib/constants')>()), getNetworkConfig: () => ({horizonUrl: 'https://horizon.example.invalid', networkPassphrase: 'Test SDF Network ; September 2015'})}));
// The active wallet is Amma-held: the server signs after the account password.
vi.mock('../lib/custody-wallets', () => ({listCustodyWallets: async () => [{chain: 'stellar', address: mocks.source}]}));
vi.mock('../lib/api', () => ({signingApi: {signAndSubmit: mocks.signAndSubmit, feeQuote: mocks.feeQuote}}));
vi.mock('react-i18next', () => ({useTranslation: () => ({t: (key: string) => key})}));
vi.mock('sonner', () => ({toast: {error: mocks.toastError, success: mocks.toastSuccess}}));

import SendPage from '../pages/Send';

const key = (n: number) => RealSdk.StrKey.encodeEd25519PublicKey(Buffer.alloc(32, n));
const DEST = key(7);
const slot = () => `amma.stellarPending.testnet.${mocks.source}`;
let root: Root;
let seq = 0;
let fetchMock: ReturnType<typeof vi.fn>;
beforeEach(() => {
  vi.clearAllMocks(); localStorage.clear(); sessionStorage.clear(); seq = 0;
  mocks.source = key(9);
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  // Each load of the sender sees the next sequence number, as if the previous attempt had applied.
  vi.spyOn(RealSdk.Horizon.Server.prototype, 'loadAccount').mockImplementation(
    async (id: string) => new RealSdk.Account(id, id === mocks.source ? String(++seq) : '1') as unknown as Awaited<ReturnType<RealSdk.Horizon.Server['loadAccount']>>);
  fetchMock = vi.fn(async () => ({ok: false, status: 404, json: async () => ({})}));
  vi.stubGlobal('fetch', fetchMock);
  mocks.signAndSubmit.mockResolvedValue({success: true});
  // Default quote: no Amma fee, so the server would submit the client's own transaction (same hash).
  mocks.feeQuote.mockImplementation(async (xdr: string) => ({
    innerHash: (RealSdk.TransactionBuilder.fromXDR(xdr, PASSPHRASE) as RealSdk.Transaction).hash().toString('hex'),
    fee: null, pays: [{asset: 'XLM', amount: '5.0000000', upTo: false}], networkFeePaidByAmma: true,
  }));
  document.body.innerHTML = '<div id="root"></div>';
  root = createRoot(document.getElementById('root')!);
});
afterEach(async () => {await act(async () => root.unmount()); vi.unstubAllGlobals(); vi.restoreAllMocks();});

async function change(el: HTMLInputElement, value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(el, value);
    el.dispatchEvent(new Event('input', {bubbles: true}));
  });
}
const btn = (label: string) => [...document.querySelectorAll('button')].find(b => b.textContent?.includes(label))!;
const q = <T extends HTMLElement>(sel: string) => document.querySelector<T>(sel)!;
const text = () => document.body.textContent!;
const flush = () => act(async () => { await new Promise((r) => setTimeout(r, 0)); });
const render = async () => { await act(async () => root.render(<MemoryRouter initialEntries={['/send']}><SendPage /></MemoryRouter>)); await flush(); };
async function openApproval() {
  await render();
  await change(q('#send-destination'), DEST);
  await change(q('#send-amount'), '5');
  await act(async () => btn('send.sendButton').click());
  await flush();
  await act(async () => btn('send.confirmSend').click());
}
async function approve(password = 'correct horse') {
  await change(q('input[type="password"]'), password);
  await act(async () => {q('form').dispatchEvent(new Event('submit', {bubbles: true, cancelable: true}));});
  await flush();
}
const xdrOf = (call: number) => mocks.signAndSubmit.mock.calls[call][0] as string;
const hashOf = (call: number) => (RealSdk.TransactionBuilder.fromXDR(xdrOf(call), PASSPHRASE) as RealSdk.Transaction).hash().toString('hex');
const senderLoads = () => vi.mocked(RealSdk.Horizon.Server.prototype.loadAccount).mock.calls.filter(([id]) => id === mocks.source).length;
const explorerLink = () => document.querySelector<HTMLAnchorElement>('a[href*="stellar.expert"]');

describe('Amma-held Stellar send: one envelope per review', () => {
  it('re-sends the same envelope when the password is retried in the same review', async () => {
    mocks.signAndSubmit.mockRejectedValueOnce(new Error('That password is not correct.')).mockResolvedValueOnce({success: true, hash: 'c'.repeat(64)});
    await openApproval();
    await approve('wrong');
    expect(text()).toContain('That password is not correct.');
    await approve('right');
    expect(mocks.signAndSubmit).toHaveBeenCalledTimes(2);
    expect(mocks.signAndSubmit.mock.calls[0][3]).toBe('password');
    expect(xdrOf(1)).toBe(xdrOf(0));
    expect(senderLoads()).toBe(1);
  });

  it('shows a pending card with the hash and blocks a new attempt when the outcome is unknown', async () => {
    mocks.signAndSubmit.mockResolvedValueOnce({status: 'unknown', hash: 'a'.repeat(64), innerHash: 'b'.repeat(64)});
    await openApproval();
    await approve();
    // The server's innerHash is what Horizon is asked about.
    const hash = 'b'.repeat(64);
    expect(text()).toContain(hash);
    expect(explorerLink()!.getAttribute('href')).toBe(`https://stellar.expert/explorer/testnet/tx/${hash}`);
    expect(fetchMock).toHaveBeenCalledWith(`https://horizon.example.invalid/transactions/${hash}`);
    expect(btn('send.confirmSend').disabled).toBe(true);
    expect(JSON.parse(localStorage.getItem(slot())!)).toMatchObject({hash, network: 'testnet'});
    expect(mocks.signAndSubmit).toHaveBeenCalledTimes(1);
  });

  it('treats a request that got no answer as unknown and checks Horizon instead of failing', async () => {
    mocks.signAndSubmit.mockRejectedValueOnce(new TypeError('Failed to fetch'));
    await openApproval();
    await approve();
    expect(text()).toContain(hashOf(0));
    expect(localStorage.getItem(slot())).toContain(hashOf(0));
    expect(btn('send.confirmSend').disabled).toBe(true);
  });

  it('shows the hash and an explorer link once Horizon has the transaction', async () => {
    mocks.signAndSubmit.mockResolvedValueOnce({status: 'unknown', hash: 'a'.repeat(64)});
    fetchMock.mockResolvedValue({ok: true, status: 200, json: async () => ({successful: true})});
    await openApproval();
    await approve();
    await flush();
    const hash = hashOf(0);
    expect(text()).toContain('send.sentTitle');
    expect(explorerLink()!.getAttribute('href')).toBe(`https://stellar.expert/explorer/testnet/tx/${hash}`);
    expect(localStorage.getItem(slot())).toBeNull();
    expect(mocks.toastSuccess).toHaveBeenCalled();
  });

  it('builds a new envelope only after the time bound has passed and Horizon never saw the first one', async () => {
    const T = 1_800_000_000_000;
    const now = vi.spyOn(Date, 'now').mockReturnValue(T);
    mocks.signAndSubmit.mockResolvedValueOnce({status: 'unknown', hash: 'f'.repeat(64)}).mockResolvedValueOnce({success: true, hash: 'e'.repeat(64)});
    await openApproval();
    await approve();
    expect(text()).toContain(hashOf(0));
    // setTimeout(300) on the envelope plus the 60 s grace, plus 2 s.
    now.mockReturnValue(T + 362_000);
    await act(async () => btn('send.pendingCheck').click());
    await flush();
    expect(text()).toContain('send.pendingExpired');
    expect(localStorage.getItem(slot())).toBeNull();
    await act(async () => btn('send.confirmSend').click());
    await approve();
    expect(mocks.signAndSubmit).toHaveBeenCalledTimes(2);
    expect(xdrOf(1)).not.toBe(xdrOf(0));
    expect(senderLoads()).toBe(2);
  });

  it('builds a new envelope after Horizon rejected the last one with a result code', async () => {
    mocks.signAndSubmit.mockRejectedValueOnce(Object.assign(new Error('Not enough XLM.'), {code: 'op_underfunded'})).mockResolvedValueOnce({success: true});
    await openApproval();
    await approve();
    await approve();
    expect(mocks.signAndSubmit).toHaveBeenCalledTimes(2);
    expect(xdrOf(1)).not.toBe(xdrOf(0));
    expect(senderLoads()).toBe(2);
  });

  it('treats a 5xx or a reply it cannot read as unknown and does not build a new envelope', async () => {
    mocks.signAndSubmit.mockRejectedValueOnce(Object.assign(new Error('API error 504'), {status: 504, unreadable: true}));
    await openApproval();
    await approve();
    expect(text()).toContain(hashOf(0));
    expect(localStorage.getItem(slot())).toContain(hashOf(0));
    expect(btn('send.confirmSend').disabled).toBe(true);
    expect(mocks.signAndSubmit).toHaveBeenCalledTimes(1);
    expect(senderLoads()).toBe(1);
  });

  it('looks the hash up instead of building a new envelope when a re-send gets tx_bad_seq', async () => {
    mocks.signAndSubmit
      .mockRejectedValueOnce(Object.assign(new Error('Too many requests.'), {status: 429, unreadable: false}))
      .mockRejectedValueOnce(Object.assign(new Error('Your wallet was busy with another transaction. Try again.'), {code: 'tx_bad_seq', status: 409, unreadable: false}));
    await openApproval();
    await approve();
    expect(text()).toContain('Too many requests.');
    await approve();
    expect(mocks.signAndSubmit).toHaveBeenCalledTimes(2);
    expect(xdrOf(1)).toBe(xdrOf(0));
    const hash = hashOf(0);
    expect(text()).toContain(hash);
    expect(fetchMock).toHaveBeenCalledWith(`https://horizon.example.invalid/transactions/${hash}`);
    expect(btn('send.confirmSend').disabled).toBe(true);
    expect(senderLoads()).toBe(1);
  });

  it('keeps the same envelope after a refusal whose code is not a Stellar result', async () => {
    mocks.signAndSubmit
      .mockRejectedValueOnce(Object.assign(new Error('Try again later.'), {code: 'rate_limited', status: 429, unreadable: false}))
      .mockResolvedValueOnce({success: true, hash: 'c'.repeat(64)});
    await openApproval();
    await approve();
    await approve();
    expect(mocks.signAndSubmit).toHaveBeenCalledTimes(2);
    expect(xdrOf(1)).toBe(xdrOf(0));
    expect(senderLoads()).toBe(1);
  });

  it('keeps a pending record while the request is in flight, so a reload then builds no new envelope', async () => {
    mocks.signAndSubmit.mockReturnValueOnce(new Promise(() => {}));
    await openApproval();
    await approve();
    await flush();
    const hash = hashOf(0);
    expect(JSON.parse(localStorage.getItem(slot())!)).toMatchObject({hash, network: 'testnet'});
    // Reload: a fresh page with the same tab storage.
    await act(async () => root.unmount());
    root = createRoot(document.getElementById('root')!);
    await render();
    expect(text()).toContain(hash);
    expect(fetchMock).toHaveBeenCalledWith(`https://horizon.example.invalid/transactions/${hash}`);
    expect(btn('send.sendButton').disabled).toBe(true);
    expect(mocks.signAndSubmit).toHaveBeenCalledTimes(1);
  });

  it('clears the saved record when the server refuses before submitting', async () => {
    mocks.signAndSubmit.mockRejectedValueOnce(new Error('That password is not correct.')).mockResolvedValueOnce({success: true, hash: 'c'.repeat(64)});
    await openApproval();
    await approve('wrong');
    expect(localStorage.getItem(slot())).toBeNull();
    await approve('right');
    expect(localStorage.getItem(slot())).toBeNull();
  });

  it('resumes a payment saved as pending in this tab and keeps new sends blocked', async () => {
    const hash = 'd'.repeat(64);
    localStorage.setItem(slot(), JSON.stringify({hash, maxTime: Math.floor(Date.now() / 1000) + 300, network: 'testnet', summary: '5 XLM'}));
    await render();
    expect(text()).toContain(hash);
    expect(fetchMock).toHaveBeenCalledWith(`https://horizon.example.invalid/transactions/${hash}`);
    expect(btn('send.sendButton').disabled).toBe(true);
  });

  it('shows the hash and explorer link after a confirmed send', async () => {
    mocks.signAndSubmit.mockResolvedValueOnce({success: true, hash: 'e'.repeat(64)});
    await openApproval();
    await approve();
    expect(text()).toContain('e'.repeat(64));
    expect(explorerLink()!.getAttribute('href')).toBe(`https://stellar.expert/explorer/testnet/tx/${'e'.repeat(64)}`);
  });
});

// The server adds the Amma fee, so the transaction it submits has another hash than the browser's envelope.
describe('Amma fee: the server hash is the one tracked, and the fee is shown before approval', () => {
  const SERVER = 'c'.repeat(64);
  const withFee = (innerHash = SERVER, fee = '0.0100000', total = '5.0100000') => ({
    innerHash, fee: {feePercent: 0.1, minFeeXlm: 0.01, feeOperations: [{asset: 'XLM', amount: fee, xlmFallbackFor: []}], xlmFallback: []},
    pays: [{asset: 'XLM', amount: total, upTo: false}], networkFeePaidByAmma: true,
  });

  it('shows the Amma fee and the total in the review step, before the password is asked', async () => {
    mocks.feeQuote.mockResolvedValue(withFee());
    await render();
    await change(q('#send-destination'), DEST);
    await change(q('#send-amount'), '5');
    await act(async () => btn('send.sendButton').click());
    await flush();
    expect(text()).toContain('send.ammaFee');
    expect(text()).toContain('0.0100000 XLM');
    expect(text()).toContain('send.totalYouPay');
    expect(text()).toContain('5.0100000 XLM');
    expect(text()).toContain('send.networkFeeAmma');
    expect(document.querySelector('input[type="password"]')).toBeNull();
    expect(mocks.feeQuote).toHaveBeenCalledTimes(1);
    expect(mocks.signAndSubmit).not.toHaveBeenCalled();
  });

  it('reply lost: the pending card and the Horizon lookup use the quoted server hash, never the browser hash', async () => {
    mocks.feeQuote.mockResolvedValue(withFee());
    mocks.signAndSubmit.mockRejectedValueOnce(new TypeError('Failed to fetch'));
    await openApproval();
    await approve();
    expect(hashOf(0)).not.toBe(SERVER);
    expect(mocks.signAndSubmit.mock.calls[0][4]).toBe(SERVER);
    expect(text()).toContain(SERVER);
    expect(text()).not.toContain(hashOf(0));
    expect(JSON.parse(localStorage.getItem(slot())!)).toMatchObject({hash: SERVER, serverHash: true});
    expect(fetchMock).toHaveBeenCalledWith(`https://horizon.example.invalid/transactions/${SERVER}`);
    expect(fetchMock).not.toHaveBeenCalledWith(`https://horizon.example.invalid/transactions/${hashOf(0)}`);
    expect(btn('send.confirmSend').disabled).toBe(true);
  });

  it('reply lost on a retry of the same review: same envelope, same expected hash, and the lookup finds the fee-bearing transaction', async () => {
    mocks.feeQuote.mockResolvedValue(withFee());
    mocks.signAndSubmit
      .mockRejectedValueOnce(Object.assign(new Error('Too many requests.'), {status: 429, unreadable: false}))
      .mockRejectedValueOnce(new TypeError('Failed to fetch'));
    fetchMock.mockImplementation(async (url: string) => (url.endsWith(SERVER) ? {ok: true, status: 200, json: async () => ({successful: true})} : {ok: false, status: 404, json: async () => ({})}));
    await openApproval();
    await approve();
    await approve();
    await flush();
    expect(mocks.signAndSubmit).toHaveBeenCalledTimes(2);
    expect(xdrOf(1)).toBe(xdrOf(0));
    expect(mocks.signAndSubmit.mock.calls.map((c) => c[4])).toEqual([SERVER, SERVER]);
    expect(mocks.feeQuote).toHaveBeenCalledTimes(1);
    expect(text()).toContain('send.sentTitle');
    expect(text()).toContain(SERVER);
    expect(localStorage.getItem(slot())).toBeNull();
  });

  it('a pending record with only the browser hash: after its time it says unknown, never "did not go through", and blocks until the user confirms', async () => {
    const T = 1_800_000_000_000;
    vi.spyOn(Date, 'now').mockReturnValue(T);
    const own = 'd'.repeat(64);
    localStorage.setItem(slot(), JSON.stringify({hash: own, maxTime: T / 1000 - 1000, network: 'testnet', summary: '5 XLM'}));
    await render();
    await flush();
    expect(text()).toContain('send.pendingUnknown');
    expect(text()).not.toContain('send.pendingExpired');
    expect(btn('send.sendButton').disabled).toBe(true);
    expect(localStorage.getItem(slot())).toContain(own);
    await act(async () => btn('send.pendingRelease').click());
    expect(localStorage.getItem(slot())).toBeNull();
    expect(text()).not.toContain('send.pendingUnknown');
  });

  it('fee changed at the server (409 fee_changed): the password dialog closes, the new fee is shown, and Confirm must be pressed again', async () => {
    const NEW = 'e'.repeat(64);
    mocks.feeQuote.mockResolvedValueOnce(withFee(SERVER)).mockResolvedValueOnce(withFee(NEW, '0.0200000', '5.0200000'));
    mocks.signAndSubmit
      .mockRejectedValueOnce(Object.assign(new Error('The Amma fee for this payment changed. Check the new fee and confirm again.'), {code: 'fee_changed', status: 409, unreadable: false}))
      .mockResolvedValueOnce({success: true, hash: 'f'.repeat(64), innerHash: NEW});
    await openApproval();
    await approve();
    // The dialog is gone: a second password entry can't approve the new fee unseen.
    expect(document.querySelector('input[type="password"]')).toBeNull();
    expect(text()).toContain('The Amma fee for this payment changed.');
    expect(text()).toContain('5.0200000 XLM');
    expect(localStorage.getItem(slot())).toBeNull();
    expect(mocks.signAndSubmit).toHaveBeenCalledTimes(1);
    // Confirm again (sees the new fee), then the password: the same envelope goes with the new hash.
    await act(async () => btn('send.confirmSend').click());
    await approve();
    expect(mocks.signAndSubmit).toHaveBeenCalledTimes(2);
    expect(xdrOf(1)).toBe(xdrOf(0));
    expect(mocks.signAndSubmit.mock.calls[1][4]).toBe(NEW);
    expect(senderLoads()).toBe(1);
  });

  it('fee changed, and the new quote fails: dialog closed, Confirm off, Try again recovers', async () => {
    mocks.feeQuote.mockResolvedValueOnce(withFee(SERVER)).mockRejectedValueOnce(Object.assign(new Error('x'), {status: 500})).mockResolvedValueOnce(withFee('e'.repeat(64)));
    mocks.signAndSubmit.mockRejectedValueOnce(Object.assign(new Error('The Amma fee for this payment changed.'), {code: 'fee_changed', status: 409, unreadable: false}));
    await openApproval();
    await approve();
    expect(document.querySelector('input[type="password"]')).toBeNull();
    expect(text()).toContain('send.feeQuoteFailed');
    expect(btn('send.confirmSend').disabled).toBe(true);
    await act(async () => btn('send.tryAgain').click());
    await flush();
    expect(btn('send.confirmSend').disabled).toBe(false);
  });

  it('edit the amount after a quote: going back and reviewing again builds a new envelope and quote, and sends the new hash', async () => {
    const NEW = 'e'.repeat(64);
    mocks.feeQuote.mockResolvedValueOnce(withFee(SERVER)).mockResolvedValueOnce(withFee(NEW, '0.0100000', '6.0100000'));
    await render();
    await change(q('#send-destination'), DEST);
    await change(q('#send-amount'), '5');
    await act(async () => btn('send.sendButton').click());
    await flush();
    expect(text()).toContain('5.0100000 XLM');
    await act(async () => btn('send.back').click());
    await change(q('#send-amount'), '6');
    await act(async () => btn('send.sendButton').click());
    await flush();
    expect(text()).toContain('6.0100000 XLM');
    expect(text()).not.toContain('5.0100000 XLM');
    await act(async () => btn('send.confirmSend').click());
    await approve();
    expect(mocks.feeQuote).toHaveBeenCalledTimes(2);
    expect(mocks.feeQuote.mock.calls[1][0]).not.toBe(mocks.feeQuote.mock.calls[0][0]);
    expect(mocks.signAndSubmit.mock.calls[0][4]).toBe(NEW);
    expect(xdrOf(0)).toBe(mocks.feeQuote.mock.calls[1][0]);
  });

  it('a late answer for an older quote never replaces the newer one', async () => {
    let releaseOld: (v: unknown) => void = () => {};
    mocks.feeQuote
      .mockImplementationOnce(() => new Promise((r) => { releaseOld = r; }))
      .mockResolvedValueOnce(withFee('e'.repeat(64), '0.0100000', '6.0100000'));
    await render();
    await change(q('#send-destination'), DEST);
    await change(q('#send-amount'), '5');
    await act(async () => btn('send.sendButton').click());
    await flush();
    expect(text()).toContain('send.feeLoading');
    await act(async () => btn('send.back').click());
    await change(q('#send-amount'), '6');
    await act(async () => btn('send.sendButton').click());
    await flush();
    expect(text()).toContain('6.0100000 XLM');
    await act(async () => { releaseOld(withFee(SERVER)); });
    await flush();
    expect(text()).toContain('6.0100000 XLM');
    expect(text()).not.toContain('5.0100000 XLM');
    expect(btn('send.confirmSend').disabled).toBe(false);
  });

  it('the fee row is a live region while it loads, and the disabled Confirm says why', async () => {
    mocks.feeQuote.mockImplementationOnce(() => new Promise(() => {}));
    await render();
    await change(q('#send-destination'), DEST);
    await change(q('#send-amount'), '5');
    await act(async () => btn('send.sendButton').click());
    await flush();
    const status = [...document.querySelectorAll('[role="status"]')].find((e) => e.textContent?.includes('send.feeLoading'));
    expect(status).toBeTruthy();
    const confirm = btn('send.confirmSend');
    expect(confirm.disabled).toBe(true);
    const id = confirm.getAttribute('aria-describedby')!;
    expect(document.getElementById(id)!.textContent).toContain('send.feeLoading');
  });

  it('reload with a server-hash record whose time later passes: says it did not go through and lets the user send again', async () => {
    const T = 1_800_000_000_000;
    const now = vi.spyOn(Date, 'now').mockReturnValue(T);
    localStorage.setItem(slot(), JSON.stringify({hash: SERVER, maxTime: T / 1000 + 100, network: 'testnet', summary: '5 XLM', serverHash: true}));
    await render();
    expect(text()).toContain(SERVER);
    expect(btn('send.sendButton').disabled).toBe(true);
    now.mockReturnValue(T + 1000 * (100 + 61));
    await act(async () => btn('send.pendingCheck').click());
    await flush();
    expect(text()).toContain('send.pendingExpired');
    expect(localStorage.getItem(slot())).toBeNull();
  });

  it('another tab saves a pending payment: this tab shows it and blocks a new send (storage event)', async () => {
    await render();
    expect(btn('send.sendButton').disabled).toBe(false);
    const value = JSON.stringify({hash: SERVER, maxTime: Math.floor(Date.now() / 1000) + 300, network: 'testnet', summary: '5 XLM', serverHash: true});
    localStorage.setItem(slot(), value);
    await act(async () => { window.dispatchEvent(new StorageEvent('storage', {key: slot(), newValue: value})); });
    await flush();
    expect(text()).toContain(SERVER);
    expect(btn('send.sendButton').disabled).toBe(true);
  });

  it('amount plus fee is more than the wallet can spend: Confirm is off, the reason says the largest amount, and it is linked', async () => {
    vi.mocked(RealSdk.Horizon.Server.prototype.loadAccount).mockImplementation(async (id: string) => Object.assign(new RealSdk.Account(id, String(++seq)), {
      subentry_count: 0, balances: [{asset_type: 'native', balance: '10.0000000', selling_liabilities: '0.0000000'}],
    }) as unknown as Awaited<ReturnType<RealSdk.Horizon.Server['loadAccount']>>);
    mocks.feeQuote.mockResolvedValue(withFee(SERVER, '0.0100000', '9.0100000'));
    await render();
    await change(q('#send-destination'), DEST);
    await change(q('#send-amount'), '9');
    await act(async () => btn('send.sendButton').click());
    await flush();
    const confirm = btn('send.confirmSend');
    expect(confirm.disabled).toBe(true);
    expect(text()).toContain('send.overBalance');
    expect(text()).toContain('8.9900000 XLM');
    expect(document.getElementById(confirm.getAttribute('aria-describedby')!)!.textContent).toContain('8.9900000 XLM');
    // 8.99 fits: Confirm on
    mocks.feeQuote.mockResolvedValue(withFee(SERVER, '0.0100000', '9.0000000'));
    await act(async () => btn('send.back').click());
    await change(q('#send-amount'), '8.99');
    await act(async () => btn('send.sendButton').click());
    await flush();
    expect(btn('send.confirmSend').disabled).toBe(false);
    expect(text()).not.toContain('send.overBalance');
  });

  it("no Amma fee (percentage 0) and too little: the reason does not mention a fee", async () => {
    vi.mocked(RealSdk.Horizon.Server.prototype.loadAccount).mockImplementation(async (id: string) => Object.assign(new RealSdk.Account(id, String(++seq)), {
      subentry_count: 0, balances: [{asset_type: 'native', balance: '5.0000000'}],
    }) as unknown as Awaited<ReturnType<RealSdk.Horizon.Server['loadAccount']>>);
    mocks.feeQuote.mockResolvedValue({innerHash: SERVER, fee: null, pays: [{asset: 'XLM', amount: '5.0000000', upTo: false}], networkFeePaidByAmma: true});
    await openApproval().catch(() => {});
    expect(btn('send.confirmSend').disabled).toBe(true);
    expect(text()).toContain('send.notEnoughForAmount');
    expect(text()).not.toContain('send.overBalance');
  });

  it("the fee is in XLM (fallback) and the wallet has no spare XLM: Confirm off, the reason names XLM", async () => {
    vi.mocked(RealSdk.Horizon.Server.prototype.loadAccount).mockImplementation(async (id: string) => Object.assign(new RealSdk.Account(id, String(++seq)), {
      subentry_count: 1, balances: [{asset_type: 'native', balance: '1.5000000'}],
    }) as unknown as Awaited<ReturnType<RealSdk.Horizon.Server['loadAccount']>>);
    mocks.feeQuote.mockResolvedValue({...withFee(SERVER), pays: [{asset: 'XLM', amount: '5.0100000', upTo: false}]});
    await openApproval().catch(() => {});
    expect(btn('send.confirmSend').disabled).toBe(true);
    expect(text()).toContain('send.overBalance');
  });

  it('no quote, no send: Confirm stays off until the fee is known; Try again recovers', async () => {
    mocks.feeQuote.mockRejectedValueOnce(Object.assign(new Error('Could not work out the Amma fee. Try again.'), {status: 500}));
    await render();
    await change(q('#send-destination'), DEST);
    await change(q('#send-amount'), '5');
    await act(async () => btn('send.sendButton').click());
    await flush();
    expect(text()).toContain('send.feeQuoteFailed');
    expect(btn('send.confirmSend').disabled).toBe(true);
    await act(async () => btn('send.tryAgain').click());
    await flush();
    expect(btn('send.confirmSend').disabled).toBe(false);
    expect(senderLoads()).toBe(1);
  });
});
