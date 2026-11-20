import { describe, expect, it, vi } from 'vitest';

const send = vi.hoisted(() => vi.fn(async () => true));
vi.mock('../config', () => ({config: {WEB_APP_URL: 'https://wallet.example.invalid'}}));
vi.mock('./mailer', () => ({sendEmail: send}));
import { sendVerificationEmail } from './email';

describe('verification email wording', () => {
  it('tells the reader not to confirm a request they did not make', async () => {
    expect(await sendVerificationEmail('owner@example.invalid', 'synthetic-token')).toBe(true);
    const html = (send.mock.calls[0] as unknown as string[])[2];
    expect(html).toContain('verify-email?token=synthetic-token');
    expect(html).toContain('Did not ask for this? Do not continue.');
    expect(html).toContain('someone else');
  });
});
