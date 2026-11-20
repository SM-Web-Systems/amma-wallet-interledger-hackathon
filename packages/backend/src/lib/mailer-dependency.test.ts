import { afterEach, describe, expect, it, vi } from 'vitest';
import nodemailer from 'nodemailer';

vi.mock('../config', () => ({ config: {
  SMTP_HOST: 'smtp.example.invalid', SMTP_PORT: 587,
  SMTP_USER: 'synthetic-user', SMTP_PASS: 'synthetic-password',
  SMTP_FROM: 'Amma Wallet <sender@example.invalid>', WEB_APP_URL: 'https://wallet.example.invalid',
} }));

const originalCreateTransport = nodemailer.createTransport.bind(nodemailer);
afterEach(() => { vi.restoreAllMocks(); vi.resetModules(); });

function offlineTransport() {
  // The actual Nodemailer composer/envelope runs; SMTP and DNS are never used.
  const transport = originalCreateTransport({ streamTransport: true, buffer: true, newline: 'unix' });
  const send = vi.spyOn(transport, 'sendMail');
  vi.spyOn(nodemailer, 'createTransport').mockReturnValue(transport);
  return { transport, send };
}

describe('application email with the real offline Nodemailer transport', () => {
  it('keeps verification recipients, subject and link intact', async () => {
    const { transport, send } = offlineTransport();
    try {
      const { sendVerificationEmail } = await import('./email');
      expect(await sendVerificationEmail('owner@example.invalid', 'synthetic-verification-token')).toBe(true);
      const info = await send.mock.results[0].value;
      expect(info.envelope).toEqual({ from: 'sender@example.invalid', to: ['owner@example.invalid'] });
      const message = info.message.toString();
      expect(message).toContain('Subject: Amma Wallet - Verify Your Email');
      // Quoted-printable MIME encoding may wrap the link across lines.
      expect(message.replace(/=\r?\n/g, '').replace(/=3D/g, '='))
        .toContain('https://wallet.example.invalid/verify-email?token=synthetic-verification-token');
    } finally { transport.close(); }
  });

  it('composes a second-factor code through the same application mailer', async () => {
    const { transport, send } = offlineTransport();
    try {
      const { send2FACode } = await import('./mailer');
      expect(await send2FACode('owner@example.invalid', '123456')).toBe(true);
      const info = await send.mock.results[0].value;
      expect(info.envelope.to).toEqual(['owner@example.invalid']);
      expect(info.message.toString()).toContain('123456');
    } finally { transport.close(); }
  });

  it('reports failure instead of success when real transport composition rejects', async () => {
    const { transport } = offlineTransport();
    transport.use('compile', (_mail, callback) => callback(new Error('synthetic composition failure')));
    const warn = vi.fn();
    // Modules are reset between tests, so take the logger from the same module registry as the mailer.
    const { setAppLogger } = await import('./app-log');
    setAppLogger({info: () => {}, warn, error: () => {}});
    try {
      const { sendVerificationEmail } = await import('./email');
      expect(await sendVerificationEmail('owner@example.invalid', 'synthetic-token')).toBe(false);
      expect(warn).toHaveBeenCalledWith(expect.not.objectContaining({to: expect.anything()}), 'mail send failed');
    } finally { transport.close(); }
  });
});
