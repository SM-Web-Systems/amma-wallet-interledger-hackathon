import { beforeEach, describe, expect, it, vi } from 'vitest';
import Fastify from 'fastify';
import { hashVerificationToken } from '../lib/code-hash';
const mocks = vi.hoisted(() => ({select: vi.fn(), execute: vi.fn(), transaction: vi.fn(), password: vi.fn(), send: vi.fn()}));
vi.mock('../db', () => ({db: {select: mocks.select, transaction: mocks.transaction}, schema: {
  users: {id: 'id', email: 'email', passwordHash: 'password_hash'},
}}));
vi.mock('../middleware/auth', () => ({authMiddleware: async (request: any, reply: any) => {
  if (request.headers.authorization !== 'Bearer synthetic-session') return reply.status(401).send({error: 'Unauthenticated'});
  request.user = {userId: 42};
}}));
vi.mock('../lib/auth', () => ({verifyPassword: mocks.password}));
vi.mock('../lib/email', () => ({sendVerificationEmail: mocks.send}));
vi.mock('../config', () => ({config: {TOTP_ENCRYPTION_KEY: 'a'.repeat(64)}}));
import { accountEmailRoutes } from './account-email';

let existing: string | null;
let lockedEmail: string | null;
beforeEach(() => {
  vi.clearAllMocks(); existing = null; lockedEmail = null;
  mocks.select.mockImplementation(() => ({from: () => ({where: () => ({limit: async () => [{email: existing, passwordHash: 'hash'}]})})}));
  mocks.execute.mockImplementation(async (statement: any) => [{email: lockedEmail}]);
  mocks.transaction.mockImplementation(async callback => callback({execute: mocks.execute}));
  mocks.password.mockResolvedValue(true); mocks.send.mockResolvedValue(true);
});
async function add(payload: object = {email: 'Owner@example.invalid', currentPassword: 'proof'}, authenticated = true) {
  const app = Fastify();
  app.register(accountEmailRoutes);
  const response = await app.inject({method: 'POST', url: '/api/v1/auth/email', payload,
    headers: authenticated ? {authorization: 'Bearer synthetic-session'} : {}});
  await app.close(); return response;
}
describe('phone-only email onboarding', () => {
  it('requires authentication', async () => {
    expect((await add(undefined, false)).statusCode).toBe(401);
    expect(mocks.transaction).not.toHaveBeenCalled();
  });
  it.each([{email: 'bad', currentPassword: 'proof'}, {email: 'a@b.invalid'}, {email: 'a@b.invalid', currentPassword: {}}])('validates %j', async payload => {
    expect((await add(payload)).statusCode).toBe(400);
    expect(mocks.transaction).not.toHaveBeenCalled();
  });
  it('requires the current Wallet password', async () => {
    mocks.password.mockResolvedValue(false);
    expect((await add()).statusCode).toBe(400);
    expect(mocks.transaction).not.toHaveBeenCalled();
  });
  it('never replaces an existing email, verified or otherwise', async () => {
    existing = 'established@example.invalid';
    expect((await add()).statusCode).toBe(409);
    expect(mocks.transaction).not.toHaveBeenCalled();
  });
  it('normalizes the pending email, leaves the account untouched, and issues a fresh verification link', async () => {
    const response = await add();
    expect(response.statusCode).toBe(202);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(mocks.execute).toHaveBeenCalledTimes(3);
    expect(mocks.send).toHaveBeenCalledWith('owner@example.invalid', expect.stringMatching(/^[a-f0-9]{64}$/));
    expect(response.json()).not.toHaveProperty('token');
    // The stored value is the keyed hash of the emailed token, never the token itself.
    const sent = mocks.send.mock.calls[0][1];
    const stored = JSON.stringify(mocks.execute.mock.calls);
    expect(stored).toContain(hashVerificationToken(sent));
    expect(stored).not.toContain(sent);
    expect(response.json().verificationSent).toBe(true);
  });
  it('rejects a competing write without sending verification', async () => {
    lockedEmail = 'established@example.invalid';
    expect((await add()).statusCode).toBe(409);
    expect(mocks.execute).toHaveBeenCalledTimes(1); expect(mocks.send).not.toHaveBeenCalled();
  });
  it('does not send email when token persistence fails', async () => {
    mocks.execute.mockRejectedValueOnce(new Error('synthetic storage failure'));
    expect((await add()).statusCode).toBe(500);
    expect(mocks.send).not.toHaveBeenCalled();
  });
  it.each([false, 'throws'])('allows verification resend after delivery failure %s', async failure => {
    if (failure === false) mocks.send.mockResolvedValue(false);
    else mocks.send.mockRejectedValue(new Error('synthetic delivery failure'));
    const response = await add();
    expect(response.statusCode).toBe(202);
    expect(response.json()).toMatchObject({success: true, verificationSent: false});
    expect(response.json().message).toContain('Resend verification');
  });
});
