import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { authApi, clearTokens, getAccessToken, request, restoreSession, setTokens } from '../lib/api';

const fetchMock = vi.fn();
const json = (body: object, status = 200) => Promise.resolve({ok: status < 400, status, json: async () => body});
const refreshCalls = () => fetchMock.mock.calls.filter(([url]) => String(url).endsWith('/api/v1/auth/refresh'));

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal('fetch', fetchMock);
  clearTokens();
});
afterEach(() => vi.unstubAllGlobals());

describe('session restore from the httpOnly refresh cookie', () => {
  it('asks the server to refresh from the cookie and keeps the new access token in memory', async () => {
    fetchMock.mockImplementation(() => json({accessToken: 'restored-access', refreshToken: 'rotated-refresh'}));
    expect(await restoreSession()).toBe(true);
    const [, init] = refreshCalls()[0];
    expect(init.method).toBe('POST');
    expect(init.headers['X-Amma-Refresh']).toBe('1');
    expect(JSON.parse(init.body)).toEqual({}); // the refresh token never travels from script
    expect(getAccessToken()).toBe('restored-access');
  });

  it('leaves the user signed out when the cookie is missing or rejected', async () => {
    setTokens('stale-access', 'ignored-refresh');
    fetchMock.mockImplementation(() => json({error: 'Invalid refresh token'}, 401));
    expect(await restoreSession()).toBe(false);
    expect(getAccessToken()).toBeNull();
  });

  it('shares one refresh between concurrent 401s, since each refresh revokes the previous token', async () => {
    setTokens('expired-access', 'ignored-refresh');
    let releaseRefresh!: () => void;
    fetchMock.mockImplementation((url: string, init: RequestInit) => {
      if (url.endsWith('/api/v1/auth/refresh')) {
        return new Promise(resolve => { releaseRefresh = () => resolve(json({accessToken: 'fresh-access'})); });
      }
      const auth = (init.headers as Record<string, string>).Authorization;
      return auth === 'Bearer fresh-access' ? json({ok: true}) : json({error: 'expired'}, 401);
    });
    const both = Promise.all([request('/api/v1/one'), request('/api/v1/two')]);
    await vi.waitFor(() => expect(refreshCalls()).toHaveLength(1));
    releaseRefresh();
    expect(await both).toEqual([{ok: true}, {ok: true}]);
    expect(refreshCalls()).toHaveLength(1);
  });

  it('does not try a refresh for unauthenticated calls such as login', async () => {
    fetchMock.mockImplementation(() => json({error: 'Invalid credentials'}, 401));
    await expect(authApi.login({email: 'user@example.invalid', password: 'wrong'})).rejects.toThrow('Invalid credentials');
    expect(refreshCalls()).toHaveLength(0);
  });

  it('logout no longer sends a refresh token from script; the server uses the cookie', async () => {
    setTokens('access', 'ignored-refresh');
    fetchMock.mockImplementation(() => json({ok: true}));
    await authApi.logout();
    const [, init] = fetchMock.mock.calls.find(([url]) => String(url).endsWith('/api/v1/auth/logout'))!;
    expect(JSON.parse(init.body)).toEqual({});
    expect(getAccessToken()).toBeNull();
  });
  it('sends auth calls with credentials so the browser keeps the cross-origin refresh cookie', async () => {
    fetchMock.mockImplementation(() => json({accessToken: 'a', refreshToken: 'r', user: {}}));
    await authApi.login({email: 'user@example.invalid', password: 'pw'});
    await restoreSession();
    await authApi.logout();
    const authCalls = fetchMock.mock.calls.filter(([url]) => String(url).includes('/api/v1/auth/'));
    expect(authCalls.map(([url]) => String(url).replace(/^.*\/api\/v1\/auth\//, ''))).toEqual(['login', 'refresh', 'logout']);
    for (const [, init] of authCalls) expect(init.credentials).toBe('include');
  });

  it('does not send cookies to other API routes', async () => {
    setTokens('access');
    fetchMock.mockImplementation(() => json({ok: true}));
    await request('/api/v1/wallets');
    const [, init] = fetchMock.mock.calls[0];
    expect(init.credentials).toBeUndefined();
  });
});

