// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import VerifyEmailPage from '../pages/VerifyEmail';

let root: Root;
const fetchMock = vi.fn();
const respond = (body: object, status = 200) => Promise.resolve({ok: status < 400, status, json: async () => body});
const pending = {success: false, requiresConfirmation: true, email: 'owner@example.invalid', phoneHint: '12'};
const methods = () => fetchMock.mock.calls.map(([, init]) => init?.method ?? 'GET');

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('fetch', fetchMock);
  document.body.innerHTML = '<div id="root"></div>';
  root = createRoot(document.getElementById('root')!);
});
afterEach(async () => {await act(async () => root.unmount()); vi.unstubAllGlobals();});
async function open(token = 'synthetic-token') {
  await act(async () => root.render(<MemoryRouter initialEntries={[`/verify-email?token=${token}`]}><VerifyEmailPage /></MemoryRouter>));
}
const button = (label: string) => [...document.querySelectorAll('button')].find(item => item.textContent === label)!;

describe('email verification page', () => {
  it('only reads the link on load, and names the address and account', async () => {
    fetchMock.mockImplementation(() => respond(pending));
    await open();
    expect(methods()).toEqual(['GET']);
    expect(document.body.textContent).toContain('owner@example.invalid');
    expect(document.body.textContent).toContain('ending in 12');
    expect(button('Yes, add it to my account')).toBeTruthy();
  });
  it('confirms with a POST only after the button is pressed', async () => {
    fetchMock.mockImplementationOnce(() => respond(pending));
    fetchMock.mockImplementationOnce(() => respond({success: true, message: 'Email verified successfully!'}));
    await open();
    await act(async () => {button('Yes, add it to my account').click();});
    expect(methods()).toEqual(['GET', 'POST']);
    expect(JSON.parse(fetchMock.mock.calls[1][1].body)).toEqual({token: 'synthetic-token'});
    expect(document.body.textContent).toContain('Email verified successfully!');
  });
  it('sends nothing when the reader did not ask for this', async () => {
    fetchMock.mockImplementation(() => respond(pending));
    await open();
    await act(async () => {button('I did not ask for this').click();});
    expect(methods()).toEqual(['GET']);
    expect(document.body.textContent).toContain('Nothing was changed');
  });
  it('words a link with no phone without inventing one', async () => {
    fetchMock.mockImplementation(() => respond({...pending, phoneHint: null}));
    await open();
    expect(document.body.textContent).toContain('owner@example.invalid');
    expect(document.body.textContent).not.toContain('ending in');
  });
  it('shows a conflict from the confirmation', async () => {
    fetchMock.mockImplementationOnce(() => respond(pending));
    fetchMock.mockImplementationOnce(() => respond({error: 'This email could not be added to this account.'}, 409));
    await open();
    await act(async () => {button('Yes, add it to my account').click();});
    expect(document.body.textContent).toContain('This email could not be added');
  });
  it('reports an already verified or unusable link without asking', async () => {
    fetchMock.mockImplementation(() => respond({success: true, message: 'Email already verified'}));
    await open();
    expect(document.body.textContent).toContain('Email already verified');
    expect(document.querySelector('button')?.textContent).toBe('Go to Dashboard');
  });
});
