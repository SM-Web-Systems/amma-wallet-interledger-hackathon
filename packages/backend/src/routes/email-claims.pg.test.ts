import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import fastifyCookie from '@fastify/cookie';
import bcrypt from 'bcryptjs';

// Real PostgreSQL behavior: row locks, unique indexes and the identifier CHECK.
// CI supplies WALLET_TEST_DATABASE_URL through a disposable service container.
const databaseUrl = process.env.WALLET_TEST_DATABASE_URL;

// password_reset_tokens stores a timestamp without a zone, read back in the process zone. The API container runs in UTC.
vi.hoisted(() => { process.env.TZ = 'UTC'; });

vi.mock('../db', async () => {
  const {drizzle} = await import('drizzle-orm/postgres-js');
  const {default: postgres} = await import('postgres');
  const schema = await import('../db/schema');
  const testClient = postgres(process.env.WALLET_TEST_DATABASE_URL ?? 'postgres://unused@127.0.0.1:1/unused', {max: 10, onnotice: () => {}});
  return {db: drizzle(testClient, {schema}), schema, testClient};
});
vi.mock('../config', () => ({config: {
  JWT_SECRET: 'synthetic-jwt-secret', JWT_REFRESH_SECRET: 'synthetic-refresh-secret',
  JWT_EXPIRES_IN: 900, JWT_REFRESH_EXPIRES_IN: 604800, WEB_APP_URL: 'https://wallet.example.invalid',
  NODE_ENV: 'test', TOTP_ENCRYPTION_KEY: 'a'.repeat(64),
}}));
vi.mock('../middleware/turnstile', () => ({verifyTurnstile: async () => {}}));
vi.mock('../middleware/auth', () => ({authMiddleware: async (request: any, reply: any) => {
  const userId = Number(request.headers['x-test-user']);
  if (!userId) return reply.status(401).send({error: 'Unauthenticated'});
  request.user = {userId};
}}));
vi.mock('../lib/email', () => ({sendVerificationEmail: vi.fn(), sendPasswordResetEmail: vi.fn()}));
vi.mock('../lib/mailer', () => ({send2FACode: vi.fn()}));
vi.mock('../lib/audit', () => ({auditLog: vi.fn()}));
vi.mock('../lib/sms', () => ({sendSmsVerification: vi.fn(), checkSmsVerification: vi.fn()}));

import * as database from '../db';
import { addEmailClaims } from '../db/migrations/add-email-claims';
import { hashVerificationToken, hashEmailCode, hashStaticCode } from '../lib/code-hash';
import { purgeCodesAndTokens } from '../lib/code-purge';
import { createHash } from 'node:crypto';
import { sendPasswordResetEmail, sendVerificationEmail } from '../lib/email';
import { checkSmsVerification } from '../lib/sms';
import { auditLog } from '../lib/audit';
import { send2FACode } from '../lib/mailer';
import { authRoutes } from './auth';
import { twoFaRoutes } from './two-fa';

if (process.env.CI && !databaseUrl) throw new Error('CI must provide WALLET_TEST_DATABASE_URL.');
// These tests drop the public schema, so only ever accept the disposable database.
if (databaseUrl) {
  const target = new URL(databaseUrl);
  if (target.pathname !== '/wallet_test' || !['127.0.0.1', 'localhost'].includes(target.hostname)) {
    throw new Error('WALLET_TEST_DATABASE_URL must be a loopback database named wallet_test.');
  }
}
const {db, schema} = database;
const sql = (database as any).testClient;
const password = 'Synthetic-Passw0rd!';
const address = 'owner@example.invalid';
let passwordHash: string;
let app: FastifyInstance;
let phoneCounter = 0;

async function seedUser(values: {email?: string; phone?: boolean; phoneVerified?: boolean; emailVerified?: boolean; emailTwoFa?: boolean} = {}) {
  const phone = values.phone || values.phoneVerified || !values.email ? `+2771${String(++phoneCounter).padStart(7, '0')}` : null;
  const [row] = await sql`INSERT INTO users (email, password_hash, phone_number, phone_verified, is_email_verified, two_fa_enabled, two_fa_method)
    VALUES (${values.email ?? null}, ${passwordHash}, ${phone}, ${values.phoneVerified ?? false}, ${values.emailVerified ?? false},
      ${values.emailTwoFa === true}, ${values.emailTwoFa ? 'email' : 'none'})
    RETURNING id`;
  return {id: Number(row.id), phone};
}
const userRow = async (id: number) => (await sql`SELECT email, is_email_verified, phone_number, phone_verified, password_hash
  FROM users WHERE id = ${id}`)[0];
const emailOwners = async (email: string) => (await sql`SELECT id FROM users WHERE email = ${email}`).map((row: any) => Number(row.id));
const tokenCount = async (id: number) => Number((await sql`SELECT COUNT(*) AS total FROM email_verification_tokens WHERE user_id = ${id}`)[0].total);
async function seedToken(userId: number, token: string, values: {email?: string | null; expiresInHours?: number} = {}) {
  const expires = new Date(Date.now() + (values.expiresInHours ?? 24) * 3600000);
  await sql`INSERT INTO email_verification_tokens (user_id, token, expires_at, email)
    VALUES (${userId}, ${hashVerificationToken(token)}, ${expires.toISOString()}, ${values.email ?? null})`;
}
const addEmail = (userId: number, email = address) => app.inject({method: 'POST', url: '/api/v1/auth/email',
  headers: {'x-test-user': String(userId)}, payload: {email, currentPassword: password}});
const openLink = (token: string) => app.inject({method: 'GET', url: `/api/v1/auth/verify-email?token=${token}`});
const verify = (token: string) => app.inject({method: 'POST', url: '/api/v1/auth/verify-email', payload: {token}});
const resend = (userId: number) => app.inject({method: 'POST', url: '/api/v1/auth/resend-verification',
  headers: {'x-test-user': String(userId)}, payload: {}});
const me = (userId: number) => app.inject({method: 'GET', url: '/api/v1/auth/me', headers: {'x-test-user': String(userId)}});
const register = (payload: Record<string, unknown>) => app.inject({method: 'POST', url: '/api/v1/auth/register', payload: {password, ...payload}});
const forgot = (email: string) => app.inject({method: 'POST', url: '/api/v1/auth/forgot-password', payload: {email}});
const resetPassword = (token: string, newPassword: string) => app.inject({method: 'POST', url: '/api/v1/auth/reset-password', payload: {token, newPassword}});
const lastVerificationMail = () => vi.mocked(sendVerificationEmail).mock.calls.at(-1)!;

describe.runIf(databaseUrl)('email claims on real PostgreSQL', () => {
  beforeAll(async () => {
    passwordHash = await bcrypt.hash(password, 4);
    await sql.unsafe('DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public;');
    const {generateDrizzleJson, generateMigration} = await import('drizzle-kit/api');
    const tables = Object.fromEntries(Object.entries(schema).filter(([name]) => !name.endsWith('Relations') && name !== 'emailVerificationTokens'));
    for (const statement of await generateMigration(generateDrizzleJson({}), generateDrizzleJson(tables))) await sql.unsafe(statement);
    await sql.unsafe(`CREATE TABLE IF NOT EXISTS email_verification_tokens (
      id BIGSERIAL PRIMARY KEY, user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE, token TEXT NOT NULL UNIQUE,
      expires_at TIMESTAMPTZ NOT NULL, used_at TIMESTAMPTZ, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
    await sql.unsafe(`CREATE TABLE IF NOT EXISTS password_reset_tokens (
      id BIGSERIAL PRIMARY KEY, user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE, token TEXT NOT NULL UNIQUE,
      expires_at TIMESTAMPTZ NOT NULL, used_at TIMESTAMPTZ, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
    await addEmailClaims(db as any);
    await addEmailClaims(db as any); // Repeat application must be harmless.
    app = Fastify({logger: false});
    await app.register(fastifyCookie);
    await app.register(authRoutes);
    await app.register(twoFaRoutes);
    await app.ready();
  }, 60000);
  afterAll(async () => { await app?.close(); await sql.end({timeout: 5}); });
  beforeEach(async () => {
    vi.clearAllMocks();
    vi.mocked(sendVerificationEmail).mockResolvedValue(true);
    vi.mocked(send2FACode).mockResolvedValue(true);
    vi.mocked(sendPasswordResetEmail).mockResolvedValue(true as never);
    await sql`TRUNCATE users RESTART IDENTITY CASCADE`;
    await sql`TRUNCATE token_registry`; // sub has no foreign key, so the cascade does not reach it
  });

  describe('static 2FA code (G-06)', () => {
    const legacyHash = (code: string) => createHash('sha256').update(code).digest('hex');
    const login = (twoFaToken?: string) => app.inject({method: 'POST', url: '/api/v1/auth/login', payload: {email: 'static@example.invalid', password, twoFaToken}});
    const staticUser = async (stored: string | ((id: number) => string)) => {
      const user = await seedUser({email: 'static@example.invalid', emailVerified: true});
      const value = typeof stored === 'function' ? stored(user.id) : stored;
      await sql`UPDATE users SET two_fa_enabled = true, two_fa_method = 'static', two_fa_static_code = ${value} WHERE id = ${user.id}`;
      return user;
    };
    const row = async (id: number) => (await sql`SELECT two_fa_static_code, failed_login_attempts FROM users WHERE id = ${id}`)[0];

    it('keeps a code stored the old way working, and replaces it with a keyed hash on first use', async () => {
      const user = await staticUser(legacyHash('123456'));
      expect((await login('123456')).statusCode).toBe(200);
      const stored = (await row(user.id)).two_fa_static_code;
      expect(stored).toBe(hashStaticCode('123456', user.id));
      expect(stored).not.toBe(legacyHash('123456'));
      expect((await login('123456')).statusCode).toBe(200);
    });

    it('counts wrong codes toward the account lockout, and a right code afterwards resets the count', async () => {
      const user = await staticUser((id) => hashStaticCode('123456', id));
      for (let i = 1; i <= 3; i++) {
        expect((await login('000000')).statusCode).toBe(401);
        expect(Number((await row(user.id)).failed_login_attempts)).toBe(i);
      }
      expect((await login('123456')).statusCode).toBe(200);
      expect(Number((await row(user.id)).failed_login_attempts)).toBe(0);
    });

    it('locks the account after ten wrong codes, even for the right code', async () => {
      await staticUser((id) => hashStaticCode('123456', id));
      for (let i = 0; i < 10; i++) expect((await login('000000')).statusCode).toBe(401);
      expect((await login('123456')).statusCode).toBe(423);
    });

    it('counts every guess of a parallel burst (the count is added in the database)', async () => {
      const user = await staticUser((id) => hashStaticCode('123456', id));
      const codes = ['000000', '000001', '000002', '000003', '000004', '000005', '000006', '000007'];
      const results = await Promise.all(codes.map((code) => login(code)));
      expect(results.every((r) => r.statusCode === 401)).toBe(true);
      expect(Number((await row(user.id)).failed_login_attempts)).toBe(codes.length);
    });

    it('does not write the upgraded hash back over a code that changed after it was read', async () => {
      const user = await staticUser(legacyHash('123456'));
      // The stored value is now something else (the person set a new code); a stale upgrade must not replace it.
      const fresh = hashStaticCode('654321', user.id);
      await sql`UPDATE users SET two_fa_static_code = ${fresh} WHERE id = ${user.id}`;
      expect((await login('123456')).statusCode).toBe(401);
      expect((await row(user.id)).two_fa_static_code).toBe(fresh);
      expect((await login('654321')).statusCode).toBe(200);
    });
  });

  describe('verification tokens and login codes are stored hashed (G-06)', () => {
    it('keeps only the keyed hash of the emailed link token, and the link still verifies once', async () => {
      const user = await seedUser();
      expect((await addEmail(user.id)).statusCode).toBe(202);
      const mailed = lastVerificationMail()[1];
      const stored = (await sql`SELECT token FROM email_verification_tokens WHERE user_id = ${user.id}`).map((row: any) => row.token);
      expect(stored).toEqual([hashVerificationToken(mailed)]);
      expect(stored).not.toContain(mailed);
      expect((await verify(mailed)).statusCode).toBe(200);
      expect((await verify(mailed)).statusCode).toBe(200); // already used: the same page, nothing changes
    });

    it('completes an email second factor setup with the mailed code, which is stored only as a hash', async () => {
      const user = await seedUser({email: address, emailVerified: true});
      const setup = await app.inject({method: 'POST', url: '/api/v1/auth/2fa/setup', headers: {'x-test-user': String(user.id)}, payload: {method: 'email'}});
      expect(setup.statusCode).toBe(200);
      const code = String(vi.mocked(send2FACode).mock.calls.at(-1)![1]);
      const stored = await sql`SELECT code FROM email_codes WHERE user_id = ${user.id}`;
      expect(stored.map((row: any) => row.code)).toEqual([hashEmailCode(code)]);
      expect(stored[0].code).not.toBe(code);
      // Spaces typed into the code do not matter: the same value is hashed on both sides.
      const spaced = `${code.slice(0, 3)} ${code.slice(3)}`;
      const confirm = await app.inject({method: 'POST', url: '/api/v1/auth/2fa/verify', headers: {'x-test-user': String(user.id)}, payload: {token: spaced}});
      expect(confirm.statusCode).toBe(200);
      expect((await sql`SELECT two_fa_enabled FROM users WHERE id = ${user.id}`)[0].two_fa_enabled).toBe(true);
    });

    it('signs in with an emailed login code, which is stored only as a hash and works once', async () => {
      const user = await seedUser({email: address, emailVerified: true, emailTwoFa: true});
      const login = (twoFaToken?: string) => app.inject({method: 'POST', url: '/api/v1/auth/login', payload: {email: address, password, twoFaToken}});
      expect((await login()).statusCode).toBe(200); // asks for the code and mails it
      const code = String(vi.mocked(send2FACode).mock.calls.at(-1)![1]);
      const stored = await sql`SELECT code FROM email_codes WHERE user_id = ${user.id}`;
      expect(stored.map((row: any) => row.code)).toEqual([hashEmailCode(code)]);
      expect((await login(code)).statusCode).toBe(200);
      expect((await login(code)).statusCode).toBe(401);
    });

    it('purges rows written before hashing at once, and hashed rows a day after they expire', async () => {
      const user = await seedUser({email: address, emailVerified: true});
      const hash = (n: string) => n.repeat(64).slice(0, 64);
      await sql`INSERT INTO email_codes (user_id, code, type, expires_at) VALUES
        (${user.id}, '123456', 'login', now() + interval '10 minutes'),
        (${user.id}, ${hash('a')}, 'login', now() + interval '10 minutes'),
        (${user.id}, ${hash('b')}, 'login', now() - interval '25 hours')`;
      await sql`INSERT INTO email_verification_tokens (user_id, token, expires_at) VALUES
        (${user.id}, 'rawtoken', now() + interval '1 hour'),
        (${user.id}, ${hash('c')}, now() + interval '1 hour'),
        (${user.id}, ${hash('d')}, now() - interval '25 hours')`;
      const purged = await purgeCodesAndTokens(database.db);
      expect(purged).toEqual({codes: 2, tokens: 2});
      expect((await sql`SELECT code FROM email_codes`).map((row: any) => row.code)).toEqual([hash('a')]);
      expect((await sql`SELECT token FROM email_verification_tokens`).map((row: any) => row.token)).toEqual([hash('c')]);
    });

    it('holds no raw token in the table after registration', async () => {
      const response = await register({email: 'fresh@example.invalid'});
      expect(response.statusCode).toBeLessThan(300);
      const mailed = lastVerificationMail()[1];
      const rows = await sql`SELECT token FROM email_verification_tokens`;
      expect(rows.map((row: any) => row.token)).not.toContain(mailed);
      expect(rows.every((row: any) => /^[0-9a-f]{64}$/.test(row.token))).toBe(true);
    });
  });

  describe('phone-only claims reserve nothing until the mailbox proves them', () => {
    it('keeps the address pending, so another account can still claim and the first proof wins', async () => {
      const first = await seedUser(); const second = await seedUser();
      const firstResponse = await addEmail(first.id);
      expect(firstResponse.statusCode).toBe(202);
      const firstToken = lastVerificationMail()[1];
      expect(lastVerificationMail()[0]).toBe(address);
      expect((await userRow(first.id)).email).toBeNull();
      expect((await me(first.id)).json()).toMatchObject({email: null, pendingEmail: address, isEmailVerified: false});
      const secondResponse = await addEmail(second.id);
      expect(secondResponse.statusCode).toBe(202);
      expect(secondResponse.json()).toEqual(firstResponse.json());
      const secondToken = lastVerificationMail()[1];
      expect((await verify(secondToken)).statusCode).toBe(200);
      expect(await userRow(second.id)).toMatchObject({email: address, is_email_verified: true});
      expect((await verify(firstToken)).statusCode).toBe(409);
      expect(await userRow(first.id)).toMatchObject({email: null, is_email_verified: false});
      expect(await emailOwners(address)).toEqual([second.id]);
    });
    it('answers the same for an address held by a verified account, then refuses at proof', async () => {
      const holder = await seedUser({email: address, emailVerified: true});
      const free = await seedUser(); const claimant = await seedUser();
      const freeResponse = await addEmail(free.id, 'free@example.invalid');
      const heldResponse = await addEmail(claimant.id);
      expect(heldResponse.statusCode).toBe(202);
      expect(heldResponse.json()).toEqual(freeResponse.json());
      expect((await verify(lastVerificationMail()[1])).statusCode).toBe(409);
      expect(await userRow(claimant.id)).toMatchObject({email: null, is_email_verified: false});
      expect(await userRow(holder.id)).toMatchObject({email: address, is_email_verified: true});
    });
    it('expires a claim without changing the account, and the expired claim blocks nobody', async () => {
      const first = await seedUser(); const second = await seedUser();
      await seedToken(first.id, 'expired-claim', {email: address, expiresInHours: -1});
      expect((await verify('expired-claim')).statusCode).toBe(400);
      expect(await userRow(first.id)).toMatchObject({email: null, is_email_verified: false});
      expect((await me(first.id)).json().pendingEmail).toBeNull();
      expect((await addEmail(second.id)).statusCode).toBe(202);
      expect((await verify(lastVerificationMail()[1])).statusCode).toBe(200);
      expect(await emailOwners(address)).toEqual([second.id]);
    });
    it('lets the owner replace a mistyped claim and kills the earlier link', async () => {
      const user = await seedUser();
      await addEmail(user.id, 'typo@example.invalid');
      const oldToken = lastVerificationMail()[1];
      await addEmail(user.id);
      expect(await tokenCount(user.id)).toBe(1);
      expect((await verify(oldToken)).statusCode).toBe(400);
      expect((await verify(lastVerificationMail()[1])).statusCode).toBe(200);
      expect(await userRow(user.id)).toMatchObject({email: address, is_email_verified: true});
    });
    it('resends to the pending address, kills the earlier link, and refuses without a claim', async () => {
      const user = await seedUser(); const unclaimed = await seedUser();
      await addEmail(user.id);
      const oldToken = lastVerificationMail()[1];
      expect((await resend(user.id)).statusCode).toBe(200);
      const [to, newToken] = lastVerificationMail();
      expect(to).toBe(address);
      expect(newToken).not.toBe(oldToken);
      expect((await verify(oldToken)).statusCode).toBe(400);
      expect((await verify(newToken)).statusCode).toBe(200);
      expect(await userRow(user.id)).toMatchObject({email: address, is_email_verified: true});
      expect((await resend(unclaimed.id)).statusCode).toBe(400);
    });
    it('does not revive an expired claim through resend', async () => {
      const user = await seedUser();
      await seedToken(user.id, 'expired-claim', {email: address, expiresInHours: -1});
      expect((await resend(user.id)).statusCode).toBe(400);
      expect(sendVerificationEmail).not.toHaveBeenCalled();
      expect((await userRow(user.id)).email).toBeNull();
    });
    it('never overwrites an established email, by request or through an old link', async () => {
      const established = await seedUser({email: 'first@example.invalid', phone: true});
      expect((await addEmail(established.id)).statusCode).toBe(409);
      expect(await tokenCount(established.id)).toBe(0);
      await seedToken(established.id, 'old-claim', {email: address});
      expect((await verify('old-claim')).statusCode).toBe(409);
      expect(await userRow(established.id)).toMatchObject({email: 'first@example.invalid', is_email_verified: false});
      expect(await emailOwners(address)).toEqual([]);
    });
    it('gives a pending address no password reset power', async () => {
      const user = await seedUser();
      await addEmail(user.id);
      expect((await forgot(address)).statusCode).toBe(200);
      expect(sendPasswordResetEmail).not.toHaveBeenCalled();
    });
    it('lets exactly one concurrent proof win an address', async () => {
      const users = await Promise.all([seedUser(), seedUser(), seedUser(), seedUser()]);
      const tokens = users.map((_, index) => `concurrent-${index}`);
      await Promise.all(users.map((user, index) => seedToken(user.id, tokens[index], {email: address})));
      const statuses = (await Promise.all(tokens.map(verify))).map(response => response.statusCode).sort();
      expect(statuses).toEqual([200, 409, 409, 409]);
      expect(await emailOwners(address)).toHaveLength(1);
    });
    it('treats a concurrent double click on one link as one verification', async () => {
      const user = await seedUser();
      await seedToken(user.id, 'double-click', {email: address});
      const statuses = (await Promise.all([verify('double-click'), verify('double-click')])).map(response => response.statusCode);
      expect(statuses).toEqual([200, 200]);
      expect(await userRow(user.id)).toMatchObject({email: address, is_email_verified: true});
    });
  });

  describe('opening a link changes nothing until the mailbox owner confirms', () => {
    it('names the address and account for a pending claim, however often it is opened', async () => {
      const user = await seedUser();
      await seedToken(user.id, 'claim', {email: address});
      for (const _ of [1, 2]) {
        const opened = await openLink('claim');
        expect(opened.statusCode).toBe(200);
        expect(opened.json()).toEqual({success: false, requiresConfirmation: true, email: address, phoneHint: user.phone!.slice(-2)});
      }
      expect(await userRow(user.id)).toMatchObject({email: null, is_email_verified: false});
      expect((await sql`SELECT used_at FROM email_verification_tokens WHERE token = ${hashVerificationToken('claim')}`)[0].used_at).toBeNull();
      expect((await verify('claim')).statusCode).toBe(200);
      expect(await userRow(user.id)).toMatchObject({email: address, is_email_verified: true});
    });
    it('does not move an address from another holder when opened', async () => {
      const holder = await seedUser({email: address, phoneVerified: true}); const claimant = await seedUser();
      await seedToken(claimant.id, 'claim', {email: address});
      await openLink('claim');
      expect((await userRow(holder.id)).email).toBe(address);
      expect((await userRow(claimant.id)).email).toBeNull();
    });
    it('needs confirmation for a link from registration too, with no phone to name', async () => {
      const user = await seedUser({email: address});
      await seedToken(user.id, 'registration');
      expect((await openLink('registration')).json()).toEqual({success: false, requiresConfirmation: true, email: address, phoneHint: null});
      expect((await userRow(user.id)).is_email_verified).toBe(false);
      expect((await verify('registration')).statusCode).toBe(200);
      expect((await openLink('registration')).json()).toMatchObject({success: true});
    });
    it('reports unknown and expired links without detail', async () => {
      const user = await seedUser();
      await seedToken(user.id, 'expired', {email: address, expiresInHours: -1});
      for (const token of ['unknown', 'expired']) {
        const opened = await openLink(token);
        expect(opened.statusCode).toBe(400);
        expect(opened.json()).not.toHaveProperty('email');
        expect(opened.json()).not.toHaveProperty('phoneHint');
      }
    });
  });

  describe('mailbox proof against an existing unverified holder', () => {
    it('moves the address from a phone-verified holder while keeping that identity', async () => {
      const holder = await seedUser({email: address, phoneVerified: true});
      const claimant = await seedUser();
      await seedToken(holder.id, 'holder-link');
      await sql`INSERT INTO password_reset_tokens (user_id, token, expires_at) VALUES (${holder.id}, 'holder-reset', ${new Date(Date.now() + 3600000).toISOString()})`;
      const before = await userRow(holder.id);
      await addEmail(claimant.id);
      expect((await verify(lastVerificationMail()[1])).statusCode).toBe(200);
      expect(await userRow(claimant.id)).toMatchObject({email: address, is_email_verified: true});
      expect(await userRow(holder.id)).toEqual({...before, email: null, is_email_verified: false});
      expect(await tokenCount(holder.id)).toBe(0);
      expect((await sql`SELECT id FROM password_reset_tokens WHERE user_id = ${holder.id}`)).toHaveLength(0);
      expect((await verify('holder-link')).statusCode).toBe(400);
      expect(auditLog).toHaveBeenCalledWith('email_claim_released', expect.objectContaining({userId: holder.id, detail: {reason: 'mailbox_proof'}}));
      const login = await app.inject({method: 'POST', url: '/api/v1/auth/login', payload: {phoneNumber: holder.phone, password}});
      expect(login.statusCode).toBe(200);
    });
    it.each([
      ['email-only', {email: address}],
      ['holding only an unproven phone', {email: address, phone: true}],
      ['verified', {email: address, emailVerified: true, phoneVerified: true}],
      ['signing in with codes sent to that address', {email: address, phoneVerified: true, emailTwoFa: true}],
    ])('never takes the address from a holder that is %s', async (_name, values) => {
      const holder = await seedUser(values); const claimant = await seedUser();
      const before = await userRow(holder.id);
      await addEmail(claimant.id);
      expect((await verify(lastVerificationMail()[1])).statusCode).toBe(409);
      expect(await userRow(holder.id)).toEqual(before);
      expect(await userRow(claimant.id)).toMatchObject({email: null, is_email_verified: false});
    });
    it('cancels an unfinished email second factor setup, so it cannot hold the address', async () => {
      const holder = await seedUser({email: address, phoneVerified: true}); const claimant = await seedUser();
      const setup = await app.inject({method: 'POST', url: '/api/v1/auth/2fa/setup', headers: {'x-test-user': String(holder.id)}, payload: {method: 'email'}});
      expect(setup.statusCode).toBe(200);
      const code = vi.mocked(send2FACode).mock.calls[0][1];
      await addEmail(claimant.id);
      expect((await verify(lastVerificationMail()[1])).statusCode).toBe(200);
      expect(await userRow(claimant.id)).toMatchObject({email: address, is_email_verified: true});
      const [after] = await sql`SELECT email, two_fa_enabled, two_fa_method FROM users WHERE id = ${holder.id}`;
      expect(after).toEqual({email: null, two_fa_enabled: false, two_fa_method: 'none'});
      // The code mailed before the release can no longer switch email second factor on.
      const confirm = await app.inject({method: 'POST', url: '/api/v1/auth/2fa/verify', headers: {'x-test-user': String(holder.id)}, payload: {token: code}});
      expect(confirm.statusCode).toBe(400);
      expect((await sql`SELECT two_fa_enabled FROM users WHERE id = ${holder.id}`)[0].two_fa_enabled).toBe(false);
    });
    it('stops treating a holder as phone-owned after it changes its phone', async () => {
      const holder = await seedUser({email: address, phoneVerified: true}); const claimant = await seedUser();
      const changed = await app.inject({method: 'PATCH', url: '/api/v1/auth/profile', headers: {'x-test-user': String(holder.id)}, payload: {phoneNumber: '+27710000555'}});
      expect(changed.statusCode).toBe(200);
      await addEmail(claimant.id);
      expect((await verify(lastVerificationMail()[1])).statusCode).toBe(409);
      expect((await userRow(holder.id)).email).toBe(address);
    });
    it('lets one of several concurrent proofs take an address from a phone-owned holder', async () => {
      const holder = await seedUser({email: address, phoneVerified: true});
      const claimants = await Promise.all([seedUser(), seedUser(), seedUser()]);
      await Promise.all(claimants.map((claimant, index) => seedToken(claimant.id, `proof-${index}`, {email: address})));
      const statuses = (await Promise.all(claimants.map((_, index) => verify(`proof-${index}`)))).map(response => response.statusCode).sort();
      expect(statuses).toEqual([200, 409, 409]);
      expect(await emailOwners(address)).toHaveLength(1);
      expect(await userRow(holder.id)).toMatchObject({email: null, phone_verified: true});
    });
    it('keeps the holder and claimant consistent when the holder verifies at the same moment', async () => {
      const holder = await seedUser({email: address, phoneVerified: true}); const claimant = await seedUser();
      await seedToken(holder.id, 'holder-link');
      await seedToken(claimant.id, 'claim', {email: address});
      await Promise.all([verify('holder-link'), verify('claim')]);
      const owners = await emailOwners(address);
      expect(owners).toHaveLength(1);
      const owner = await userRow(owners[0]);
      expect(owner.is_email_verified).toBe(true);
      const other = await userRow(owners[0] === holder.id ? claimant.id : holder.id);
      expect(other).toMatchObject({email: null, is_email_verified: false});
    });
  });

  describe('registration with an email', () => {
    it('still creates an unverified account and starts its verification window', async () => {
      const response = await register({email: address});
      expect(response.statusCode).toBe(200);
      const id = response.json().user.id;
      expect(await userRow(id)).toMatchObject({email: address, is_email_verified: false});
      const [token] = await sql`SELECT email FROM email_verification_tokens WHERE user_id = ${id}`;
      expect(token.email).toBeNull();
      expect((await verify(lastVerificationMail()[1])).statusCode).toBe(200);
      expect(await userRow(id)).toMatchObject({email: address, is_email_verified: true});
    });
    it('answers 409, not a server error, when two registrations race', async () => {
      const statuses = (await Promise.all([register({email: address}), register({email: address}), register({email: address})]))
        .map(response => response.statusCode).sort();
      expect(statuses).toEqual([200, 409, 409]);
      expect(await emailOwners(address)).toHaveLength(1);
    });
    it('answers 409 with the phone message when a phone race loses', async () => {
      const responses = await Promise.all(['a', 'b'].map(name => register({email: `${name}@example.invalid`, phoneNumber: '+27710000999'})));
      const loser = responses.find(response => response.statusCode !== 200)!;
      expect(loser.statusCode).toBe(409);
      expect(loser.json().error).toBe('Phone number already registered');
    });
    it.each([
      ['email-only', {email: address}],
      ['holding only an unproven phone', {email: address, phone: true}],
      ['verified', {email: address, emailVerified: true, phoneVerified: true}],
      ['owned by a proven phone', {email: address, phoneVerified: true}],
    ])('never takes an address from a holder that is %s, even after its link expires', async (_name, values) => {
      const holder = await seedUser(values);
      await seedToken(holder.id, 'expired', {expiresInHours: -1});
      const before = await userRow(holder.id);
      expect((await register({email: address})).statusCode).toBe(409);
      expect(await userRow(holder.id)).toEqual(before);
      expect(await tokenCount(holder.id)).toBe(1);
    });
  });

  describe('verification links from before this change', () => {
    it('verify the account email, once', async () => {
      const user = await seedUser({email: address});
      await seedToken(user.id, 'legacy');
      expect((await verify('legacy')).statusCode).toBe(200);
      expect((await verify('legacy')).json().message).toContain('already');
      expect(await userRow(user.id)).toMatchObject({email: address, is_email_verified: true});
    });
    it('cannot mark an account with no email as verified', async () => {
      const user = await seedUser();
      await seedToken(user.id, 'no-address');
      expect((await verify('no-address')).statusCode).toBe(400);
      expect((await userRow(user.id)).is_email_verified).toBe(false);
    });
    it('reject an unknown token', async () => {
      expect((await verify('unknown')).statusCode).toBe(400);
    });
  });

  describe('password reset by email', () => {
    it('sends nothing to an unverified address on a phone-verified account, with the same answer', async () => {
      await seedUser({email: address, phoneVerified: true});
      const answer = await forgot(address);
      const unknown = await forgot('nobody@example.invalid');
      expect(answer.statusCode).toBe(200);
      expect(answer.json()).toEqual(unknown.json());
      expect(sendPasswordResetEmail).not.toHaveBeenCalled();
      expect(await sql`SELECT id FROM password_reset_tokens`).toHaveLength(0);
    });
    it.each([
      ['an unverified email-only account, its only recovery route', {email: address}],
      ['a verified account', {email: address, emailVerified: true}],
      ['a verified account that also has a verified phone', {email: address, emailVerified: true, phoneVerified: true}],
    ])('still works for %s', async (_name, values) => {
      await seedUser(values);
      expect((await forgot(address)).statusCode).toBe(200);
      expect(sendPasswordResetEmail).toHaveBeenCalledTimes(1);
    });
    it('refuses a reset link once a proven phone owns the account, so an earlier email cannot be used', async () => {
      const user = await seedUser({email: address, phone: true});
      await forgot(address);
      const resetToken = vi.mocked(sendPasswordResetEmail).mock.calls[0][1];
      await sql`UPDATE users SET phone_verified = true WHERE id = ${user.id}`;
      const before = (await userRow(user.id)).password_hash;
      const refused = await resetPassword(resetToken, 'Zx9!kQ7#mLp2$vRt');
      expect(refused.statusCode).toBe(400);
      expect(refused.json().error).toBe('Invalid or expired reset token');
      expect((await userRow(user.id)).password_hash).toBe(before);
    });
    it('still honors a reset link when the account is not phone-owned', async () => {
      const user = await seedUser({email: address});
      await forgot(address);
      const resetToken = vi.mocked(sendPasswordResetEmail).mock.calls[0][1];
      const before = (await userRow(user.id)).password_hash;
      expect((await resetPassword(resetToken, 'Zx9!kQ7#mLp2$vRt')).statusCode).toBe(200);
      expect((await userRow(user.id)).password_hash).not.toBe(before);
    });
  });

  describe('password reset recovery (WA-08)', () => {
    const newPassword = 'Zx9!kQ7#mLp2$vRt';
    const login = (pw: string) => app.inject({method: 'POST', url: '/api/v1/auth/login', payload: {email: address, password: pw}});
    const mailedToken = async () => { await forgot(address); return vi.mocked(sendPasswordResetEmail).mock.calls.at(-1)![1] as string; };
    const resets = async (userId: number) => (await sql`SELECT detail FROM audit_logs WHERE user_id = ${userId} AND action = 'password_reset'`).map((r: any) => r.detail);
    const lockRow = async (id: number) => (await sql`SELECT failed_login_attempts, last_failed_login FROM users WHERE id = ${id}`)[0];
    const smsReset = (phone: string | null) => app.inject({method: 'POST', url: '/api/v1/auth/reset-password-sms', payload: {phoneNumber: phone, code: '123456', newPassword}});
    afterEach(() => { vi.mocked(checkSmsVerification).mockReset(); });

    it('lets only one of two parallel requests use a reset link', async () => {
      const user = await seedUser({email: address, emailVerified: true});
      const token = await mailedToken();
      const results = await Promise.all([resetPassword(token, newPassword), resetPassword(token, 'Other!Passw0rd9x')]);
      expect(results.map((r) => r.statusCode).sort()).toEqual([200, 400]);
      expect(results.find((r) => r.statusCode === 400)!.json().error).toBe('Reset token has already been used');
      expect(await resets(user.id)).toHaveLength(1);
    });

    it('does not deadlock when two links for one account are used at the same time', async () => {
      await seedUser({email: address, emailVerified: true});
      const first = await mailedToken();
      const second = await mailedToken();
      const results = await Promise.all([resetPassword(first, newPassword), resetPassword(second, 'Other!Passw0rd9x')]);
      expect(results.map((r) => r.statusCode).sort()).toEqual([200, 400]);
    });

    it('voids every other unused reset link for the account', async () => {
      await seedUser({email: address, emailVerified: true});
      const first = await mailedToken();
      const second = await mailedToken();
      expect((await resetPassword(second, newPassword)).statusCode).toBe(200);
      const again = await resetPassword(first, 'Other!Passw0rd9x');
      expect(again.statusCode).toBe(400);
      expect(again.json().error).toBe('Reset token has already been used');
    });

    it('clears the login lock on an email reset so the new password works at once', async () => {
      const user = await seedUser({email: address, emailVerified: true});
      for (let i = 0; i < 10; i++) expect((await login('Wrong-Passw0rd!')).statusCode).toBe(401);
      expect((await login(password)).statusCode).toBe(423);
      expect((await resetPassword(await mailedToken(), newPassword)).statusCode).toBe(200);
      const row = await lockRow(user.id);
      expect(Number(row.failed_login_attempts)).toBe(0);
      expect(row.last_failed_login).toBeNull();
      expect((await login(newPassword)).statusCode).toBe(200);
    });

    it('clears the login lock on an SMS reset too', async () => {
      const user = await seedUser({phoneVerified: true});
      await sql`UPDATE users SET failed_login_attempts = 10, last_failed_login = now() WHERE id = ${user.id}`;
      vi.mocked(checkSmsVerification).mockResolvedValue({success: true} as never);
      expect((await smsReset(user.phone)).statusCode).toBe(200);
      const row = await lockRow(user.id);
      expect(Number(row.failed_login_attempts)).toBe(0);
      expect(row.last_failed_login).toBeNull();
      const signedIn = await app.inject({method: 'POST', url: '/api/v1/auth/login', payload: {phoneNumber: user.phone, password: newPassword}});
      expect(signedIn.statusCode).toBe(200);
    });

    it('tells a locked user when sign-in opens again', async () => {
      await seedUser({email: address, emailVerified: true});
      for (let i = 0; i < 10; i++) await login('Wrong-Passw0rd!');
      const locked = await login(password);
      expect(locked.statusCode).toBe(423);
      const body = locked.json();
      expect(Date.parse(body.retryAt) - Date.now()).toBeGreaterThan(29 * 60_000);
      expect(body.error).toBe(`Too many wrong passwords. Sign-in is paused until ${new Date(body.retryAt).toISOString().slice(11, 16)} UTC. You can reset your password now.`);
    });

    it.each(['email', 'sms'] as const)('signs out refresh tokens and OAuth tokens on an %s reset, for that user only', async (method) => {
      const user = await seedUser(method === 'email' ? {email: address, emailVerified: true} : {phoneVerified: true});
      const other = await seedUser({email: 'other@example.invalid', emailVerified: true});
      const later = new Date(Date.now() + 86400000).toISOString();
      await sql`INSERT INTO refresh_tokens (user_id, token, expires_at) VALUES (${user.id}, 'synthetic-refresh-hash', ${later}), (${other.id}, 'synthetic-other-hash', ${later})`;
      await sql`INSERT INTO token_registry (jti, token_type, sub, client_id, issued_at, expires_at)
        VALUES ('synthetic-jti-1', 'refresh', ${String(user.id)}, 'synthetic-client', now(), now() + interval '1 day'),
               ('synthetic-jti-2', 'refresh', ${String(other.id)}, 'synthetic-client', now(), now() + interval '1 day')`;
      if (method === 'email') expect((await resetPassword(await mailedToken(), newPassword)).statusCode).toBe(200);
      else {
        vi.mocked(checkSmsVerification).mockResolvedValue({success: true} as never);
        expect((await smsReset(user.phone)).statusCode).toBe(200);
      }
      expect((await sql`SELECT user_id FROM refresh_tokens`).map((r: any) => Number(r.user_id))).toEqual([other.id]);
      const rows = await sql`SELECT jti, revoked_at FROM token_registry ORDER BY jti`;
      expect(rows[0].revoked_at).not.toBeNull();
      expect(rows[1].revoked_at).toBeNull();
    });

    it('records the reset in the same step, with the method', async () => {
      const user = await seedUser({email: address, emailVerified: true});
      expect((await resetPassword(await mailedToken(), newPassword)).statusCode).toBe(200);
      expect(await resets(user.id)).toEqual([{method: 'email'}]);
      const sms = await seedUser({phoneVerified: true});
      vi.mocked(checkSmsVerification).mockResolvedValue({success: true} as never);
      expect((await smsReset(sms.phone)).statusCode).toBe(200);
      expect(await resets(sms.id)).toEqual([{method: 'sms'}]);
    });

    it('leaves the password unchanged and the link usable when the audit row cannot be written', async () => {
      const user = await seedUser({email: address, emailVerified: true});
      const token = await mailedToken();
      const before = (await userRow(user.id)).password_hash;
      await sql`ALTER TABLE audit_logs ADD CONSTRAINT wa08_refuse CHECK (action <> 'password_reset')`;
      try {
        expect((await resetPassword(token, newPassword)).statusCode).toBe(500);
      } finally {
        await sql`ALTER TABLE audit_logs DROP CONSTRAINT wa08_refuse`;
      }
      expect((await userRow(user.id)).password_hash).toBe(before);
      expect((await resetPassword(token, newPassword)).statusCode).toBe(200);
    });
  });

  describe('phone proof applies only to the number that was checked', () => {
    it('does not mark a number changed during the code check as verified', async () => {
      const user = await seedUser();
      vi.mocked(checkSmsVerification).mockImplementation(async () => {
        await sql`UPDATE users SET phone_number = '+27710000666', phone_verified = false WHERE id = ${user.id}`;
        return {success: true} as any;
      });
      const response = await app.inject({method: 'POST', url: '/api/v1/auth/verify-phone', headers: {'x-test-user': String(user.id)}, payload: {code: '123456'}});
      expect(response.statusCode).toBe(409);
      expect(await userRow(user.id)).toMatchObject({phone_number: '+27710000666', phone_verified: false});
    });
    it('still verifies the number that was checked', async () => {
      const user = await seedUser();
      vi.mocked(checkSmsVerification).mockResolvedValue({success: true} as any);
      const response = await app.inject({method: 'POST', url: '/api/v1/auth/verify-phone', headers: {'x-test-user': String(user.id)}, payload: {code: '123456'}});
      expect(response.statusCode).toBe(200);
      expect((await userRow(user.id)).phone_verified).toBe(true);
    });
  });
});
