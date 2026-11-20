import type { FastifyInstance } from 'fastify';
import { eq, sql } from 'drizzle-orm';
import { randomBytes } from 'node:crypto';
import { db, schema } from '../db';
import { authMiddleware } from '../middleware/auth';
import { verifyPassword } from '../lib/auth';
import { sendVerificationEmail } from '../lib/email';
import { hashVerificationToken } from '../lib/code-hash';

const EMAIL_ALREADY_SET = 'This account already has an email. Contact support to change it.';

/** Record a pending email. It reaches users.email, and blocks others, only after mailbox proof. */
export async function accountEmailRoutes(app: FastifyInstance) {
  app.post('/api/v1/auth/email', {
    preHandler: authMiddleware,
    config: {rateLimit: {max: 3, timeWindow: '15 minutes'}},
    schema: {
      tags: ['Auth'], security: [{bearerAuth: []}],
      description: 'Start adding an email to a phone-only account after password confirmation. The email is added once its verification link is opened.',
      body: {type: 'object', required: ['email', 'currentPassword'], additionalProperties: false, properties: {
        email: {type: 'string', format: 'email', maxLength: 254},
        currentPassword: {type: 'string', minLength: 1, maxLength: 1024},
      }},
    },
  }, async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    const {email: input, currentPassword} = request.body as {email: string; currentPassword: string};
    const email = input.trim().toLowerCase();
    const userId = request.user!.userId;
    const [user] = await db.select({email: schema.users.email, passwordHash: schema.users.passwordHash})
      .from(schema.users).where(eq(schema.users.id, userId)).limit(1);
    if (!user || !await verifyPassword(currentPassword, user.passwordHash)) {
      return reply.status(400).send({error: 'Confirm your current AmmaWallet password.'});
    }
    if (user.email) return reply.status(409).send({error: EMAIL_ALREADY_SET});
    const token = randomBytes(32).toString('hex');
    try {
      await db.transaction(async tx => {
        const result: any = await tx.execute(sql`SELECT email FROM users WHERE id = ${userId} FOR UPDATE`);
        if ((result.rows ?? result)[0]?.email) throw new Error('EMAIL_ALREADY_SET');
        // A newer claim replaces the older one, so a mistyped address can be corrected.
        await tx.execute(sql`DELETE FROM email_verification_tokens WHERE user_id = ${userId}`);
        const expires = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
        await tx.execute(sql`INSERT INTO email_verification_tokens (user_id, token, expires_at, email) VALUES (${userId}, ${hashVerificationToken(token)}, ${expires}, ${email})`);
      });
    } catch (error: any) {
      if (error.message === 'EMAIL_ALREADY_SET') return reply.status(409).send({error: EMAIL_ALREADY_SET});
      request.log.error({err: error.message}, '[account-email] Unable to save email');
      return reply.status(500).send({error: 'Could not save your email. Please try again.'});
    }
    // The answer does not depend on whether the address is already in use; only
    // the mailbox owner learns that, when the link is opened.
    let verificationSent = false;
    try { verificationSent = await sendVerificationEmail(email, token); }
    catch { request.log.warn('[account-email] Verification delivery failed'); }
    return reply.status(202).send({success: true, verificationSent,
      message: verificationSent ? 'Open the verification link in your inbox to finish adding this email, then return to LMS sign-in.'
        : 'We could not send the verification email. Use Resend verification email to retry.'});
  });
}
