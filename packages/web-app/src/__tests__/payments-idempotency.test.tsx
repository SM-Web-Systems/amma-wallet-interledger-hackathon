// @vitest-environment jsdom
// G-08: each submission of the Request form gets its own Idempotency-Key.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';

const asset = {code: 'ZAR', scale: 2, issuer: 'GISSUER'};
const calls: {path: string; body: unknown; key?: string}[] = [];
let failInvoice = 0;
let invoiceSeq = 0;

vi.mock('../lib/payments', async () => {
  const actual = await vi.importActual<typeof import('../lib/payments')>('../lib/payments');
  return {
    ...actual,
    paymentRequest: vi.fn(async (path: string, body?: unknown, key?: string) => {
      calls.push({path, body, key});
      if (path === '/availability') return {enabled: true, paused: false, assets: [asset]};
      if (path === '/history' || path === '/sources') return [];
      if (path === '/addresses') return {url: 'https://wallet.example/shop'};
      if (path === '/requests') {
        if (failInvoice > 0) { failInvoice--; throw new Error('Network error'); }
        return {id: `inv-${++invoiceSeq}`, merchant: 'Shop', asset, amount: '1000'};
      }
      return {};
    }),
  };
});

import Payments from '../pages/Payments';

let root: Root;
beforeEach(() => {
  calls.length = 0; failInvoice = 0; invoiceSeq = 0;
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  document.body.innerHTML = '<div id="root"></div>';
  root = createRoot(document.getElementById('root')!);
});
afterEach(async () => { await act(async () => root.unmount()); vi.unstubAllGlobals(); });

async function open() {
  await act(async () => root.render(<MemoryRouter initialEntries={['/payments']}><Payments /></MemoryRouter>));
  await act(async () => { (document.querySelector('button[aria-label="Request payment"]') as HTMLButtonElement).click(); });
}
async function fill(id: string, value: string) {
  const input = document.getElementById(id) as HTMLInputElement;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value);
    input.dispatchEvent(new Event('input', {bubbles: true}));
  });
}
async function submit() {
  await act(async () => { document.querySelector('form')!.dispatchEvent(new Event('submit', {bubbles: true, cancelable: true})); });
}
const invoiceKeys = () => calls.filter(c => c.path === '/requests').map(c => c.key);
const addressKeys = () => calls.filter(c => c.path === '/addresses').map(c => c.key);

describe('request form idempotency keys (G-08)', () => {
  it('uses a different key for a second request with the same name, asset and amount', async () => {
    await open(); await fill('request-merchant', 'Shop'); await fill('request-amount', '10');
    await submit(); await submit();
    const keys = invoiceKeys();
    expect(keys).toHaveLength(2);
    expect(keys[0]).toBeTruthy();
    expect(keys[1]).toBeTruthy();
    expect(keys[0]).not.toBe(keys[1]);
  });

  it('keeps the same key when the first attempt failed and the person tries again', async () => {
    failInvoice = 1;
    await open(); await fill('request-merchant', 'Shop'); await fill('request-amount', '10');
    await submit(); await submit();
    const keys = invoiceKeys();
    expect(keys).toHaveLength(2);
    expect(keys[0]).toBe(keys[1]);
  });

  it('keeps the payment address key stable, so one merchant does not get a new address per sale', async () => {
    await open(); await fill('request-merchant', 'Shop'); await fill('request-amount', '10');
    await submit(); await submit();
    const keys = addressKeys();
    expect(keys).toHaveLength(2);
    expect(keys[0]).toBe(keys[1]);
  });

  it('gives a fresh key after a reload (keys are never stored)', async () => {
    await open(); await fill('request-merchant', 'Shop'); await fill('request-amount', '10');
    await submit();
    await act(async () => root.unmount());
    root = createRoot(document.getElementById('root')!);
    await open(); await fill('request-merchant', 'Shop'); await fill('request-amount', '10');
    await submit();
    const keys = invoiceKeys();
    expect(keys[0]).not.toBe(keys[1]);
  });

  it('treats 10 and 10.0 as the same amount, so a retry with a re-typed amount cannot duplicate', async () => {
    failInvoice = 1;
    await open(); await fill('request-merchant', 'Shop'); await fill('request-amount', '10');
    await submit();
    await fill('request-amount', '10.0');
    await submit();
    const keys = invoiceKeys();
    expect(keys).toHaveLength(2);
    expect(keys[0]).toBe(keys[1]);
  });

  it('gives a different amount its own key after a failure', async () => {
    failInvoice = 1;
    await open(); await fill('request-merchant', 'Shop'); await fill('request-amount', '10');
    await submit();
    await fill('request-amount', '20');
    await submit();
    const keys = invoiceKeys();
    expect(keys[0]).not.toBe(keys[1]);
  });

  it('sends one request for a rapid double submit', async () => {
    await open(); await fill('request-merchant', 'Shop'); await fill('request-amount', '10');
    await act(async () => {
      const form = document.querySelector('form')!;
      form.dispatchEvent(new Event('submit', {bubbles: true, cancelable: true}));
      form.dispatchEvent(new Event('submit', {bubbles: true, cancelable: true}));
    });
    expect(invoiceKeys()).toHaveLength(1);
  });
});
