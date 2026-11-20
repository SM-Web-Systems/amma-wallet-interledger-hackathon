import { beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({login: vi.fn(), me: vi.fn(), profile: vi.fn(), sync: vi.fn(), setTokens: vi.fn(), restore: vi.fn(), claim: vi.fn(), lock: vi.fn(), token: 'synthetic-session' as string | null}));
vi.mock('../lib/api', () => ({
  authApi: {login: mocks.login, me: mocks.me, updateProfile: mocks.profile},
  setTokens: mocks.setTokens, clearTokens: vi.fn(), getAccessToken: () => mocks.token, restoreSession: mocks.restore,
  userWalletApi: {list: async () => []}, signingApi: {getMode: async () => 'self'},
}));
vi.mock('../store/wallet', () => ({useWalletStore: {getState: () => ({syncFromServer: mocks.sync, logout: vi.fn(), claimFor: mocks.claim, lock: mocks.lock})}}));
import { useAuthStore } from '../store/auth';
const user = {id: 42, email: null, firstName: 'Synthetic', lastName: 'Learner', isEmailVerified: false};
beforeEach(() => {
  vi.clearAllMocks(); useAuthStore.setState({user: null, isAuthenticated: false, serverWallets: []});
  mocks.login.mockResolvedValue({user, accessToken: 'access', refreshToken: 'refresh'});
  mocks.sync.mockResolvedValue(undefined);
  mocks.token = 'synthetic-session';
});
describe('Wallet account journey contracts', () => {
  it('sends a phone identifier to the existing login API', async () => {
    await useAuthStore.getState().login('+27123456789', 'synthetic-password', 'synthetic-captcha');
    expect(mocks.login).toHaveBeenCalledWith({phoneNumber: '+27123456789', password: 'synthetic-password', turnstileToken: 'synthetic-captcha', twoFaToken: undefined});
    expect(useAuthStore.getState().user?.email).toBeNull();
    expect(mocks.claim).toHaveBeenCalledWith(42, []);
  });
  it('retains email login and its second-factor proof', async () => {
    await useAuthStore.getState().login(' owner@example.invalid ', 'password', 'captcha', 'second-factor');
    expect(mocks.login).toHaveBeenCalledWith({email: 'owner@example.invalid', password: 'password', turnstileToken: 'captcha', twoFaToken: 'second-factor'});
  });
  it('does not authenticate or store tokens when the provider requires a second factor', async () => {
    mocks.login.mockResolvedValue({twoFaRequired: true, twoFaMethod: 'totp'});
    await expect(useAuthStore.getState().login('+27123456789', 'password')).rejects.toThrow('2FA_REQUIRED:totp');
    expect(useAuthStore.getState().isAuthenticated).toBe(false);
    expect(mocks.setTokens).not.toHaveBeenCalled();
  });
  it('loads the actual flat profile response and current verification status', async () => {
    mocks.me.mockResolvedValue({...user, email: 'verified@example.invalid', isEmailVerified: true, wallets: []});
    await useAuthStore.getState().loadProfile();
    expect(useAuthStore.getState().user).toMatchObject({id: 42, email: 'verified@example.invalid', isEmailVerified: true});
    expect(useAuthStore.getState().user).not.toHaveProperty('wallets');
  });
  it('keeps account metadata when updating a flat name profile', async () => {
    useAuthStore.setState({user: {...user, email: 'verified@example.invalid', isEmailVerified: true} as any});
    mocks.profile.mockResolvedValue({id: 42, firstName: 'Updated'});
    await useAuthStore.getState().updateProfile({firstName: 'Updated'});
    expect(useAuthStore.getState().user).toMatchObject({firstName: 'Updated', email: 'verified@example.invalid', isEmailVerified: true});
  });
  it('after a reload, restores a signed-in session from the refresh cookie before loading the profile', async () => {
    mocks.token = null;
    useAuthStore.setState({user: user as any, isAuthenticated: true});
    mocks.restore.mockImplementation(async () => { mocks.token = 'restored-access'; return true; });
    mocks.me.mockResolvedValue({...user, wallets: []});
    await useAuthStore.getState().loadProfile();
    expect(mocks.restore).toHaveBeenCalledTimes(1);
    expect(mocks.me).toHaveBeenCalled();
    expect(useAuthStore.getState().isAuthenticated).toBe(true);
  });
  it('signs out when the refresh cookie cannot restore the session', async () => {
    mocks.token = null;
    useAuthStore.setState({user: user as any, isAuthenticated: true});
    mocks.restore.mockResolvedValue(false);
    await useAuthStore.getState().loadProfile();
    expect(mocks.me).not.toHaveBeenCalled();
    expect(useAuthStore.getState().isAuthenticated).toBe(false);
  });
  it('does not call the refresh endpoint for a visitor who was never signed in', async () => {
    mocks.token = null;
    await useAuthStore.getState().loadProfile();
    expect(mocks.restore).not.toHaveBeenCalled();
  });
});
