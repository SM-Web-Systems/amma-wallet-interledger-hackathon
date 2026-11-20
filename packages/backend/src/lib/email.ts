import { config } from "../config";
import { sendEmail } from "./mailer";
import { appLog } from "./app-log";

export async function sendPasswordResetEmail(to: string, resetToken: string): Promise<void> {
  const resetUrl = `${config.WEB_APP_URL}/reset-password?token=${resetToken}`;

  const html = `
    <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 480px; margin: 0 auto; padding: 40px 20px;">
      <div style="text-align: center; margin-bottom: 30px;">
        <h1 style="color: #7c3aed; margin: 0;">Amma Wallet</h1>
      </div>
      <div style="background: #1a1a2e; border-radius: 16px; padding: 32px; text-align: center;">
        <h2 style="color: #ffffff; margin: 0 0 8px;">Reset Your Password</h2>
        <p style="color: #9ca3af; font-size: 14px; margin: 0 0 24px;">Click the button below to set a new password</p>
        <a href="${resetUrl}"
           style="display: inline-block; background: linear-gradient(135deg, #7c3aed, #3b82f6); color: white; padding: 14px 32px;
                  border-radius: 12px; text-decoration: none; font-weight: 600; font-size: 16px;">
          Reset Password
        </a>
        <p style="color: #9ca3af; font-size: 12px; margin-top: 24px;">This link expires in <strong style="color: #ffffff;">1 hour</strong>.</p>
        <p style="color: #6b7280; font-size: 11px; margin-top: 16px; word-break: break-all;">
          Or copy: ${resetUrl}
        </p>
      </div>
      <p style="color: #6b7280; font-size: 11px; text-align: center; margin-top: 24px;">
        If you didn't request this, you can safely ignore this email.
      </p>
    </div>
  `;

  const sent = await sendEmail(to, "Amma Wallet - Password Reset", html);
  if (!sent) {
    appLog().warn({ template: "password-reset" }, "email not sent");
  }
}


export async function sendVerificationEmail(to: string, token: string): Promise<boolean> {
  const verifyUrl = `${config.WEB_APP_URL}/verify-email?token=${token}`;

  const html = `
    <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 480px; margin: 0 auto; padding: 40px 20px;">
      <div style="text-align: center; margin-bottom: 30px;">
        <h1 style="color: #7c3aed; margin: 0;">Amma Wallet</h1>
      </div>
      <div style="background: #1a1a2e; border-radius: 16px; padding: 32px; text-align: center;">
        <h2 style="color: #ffffff; margin: 0 0 8px;">Verify Your Email</h2>
        <p style="color: #9ca3af; font-size: 14px; margin: 0 0 24px;">Click the button below to verify your email address and activate your account.</p>
        <a href="${verifyUrl}"
           style="display: inline-block; background: linear-gradient(135deg, #7c3aed, #3b82f6); color: white; padding: 14px 32px;
                  border-radius: 12px; text-decoration: none; font-weight: 600; font-size: 16px;">
          Verify Email
        </a>
        <p style="color: #9ca3af; font-size: 12px; margin-top: 24px;">This link expires in <strong style="color: #ffffff;">24 hours</strong>.</p>
        <p style="color: #6b7280; font-size: 11px; margin-top: 16px; word-break: break-all;">
          Or copy: ${verifyUrl}
        </p>
      </div>
      <p style="color: #6b7280; font-size: 11px; text-align: center; margin-top: 24px;">
        Did not ask for this? Do not continue. It may mean someone else is trying to link your email to their account.
      </p>
    </div>
  `;

  return await sendEmail(to, "Amma Wallet - Verify Your Email", html);
}

const frame = (title: string, body: string) => `
    <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 480px; margin: 0 auto; padding: 40px 20px;">
      <div style="text-align: center; margin-bottom: 30px;"><h1 style="color: #7c3aed; margin: 0;">Amma Wallet</h1></div>
      <div style="background: #1a1a2e; border-radius: 16px; padding: 32px; text-align: center;">
        <h2 style="color: #ffffff; margin: 0 0 8px;">${title}</h2>
        ${body}
      </div>
    </div>`;

async function mustSend(to: string, subject: string, html: string): Promise<void> {
  if (!(await sendEmail(to, subject, html))) throw new Error("email could not be sent");
}

/** Recovery step 1: a one-time code that proves the person can read the account's mailbox. */
export async function sendKeyRecoveryCode(to: string, code: string): Promise<void> {
  await mustSend(to, "Amma Wallet - Recovery code", frame("Your recovery code",
    `<p style="color: #9ca3af; font-size: 14px;">Use this code to start wallet recovery. It expires in 15 minutes.</p>
     <p style="color: #ffffff; font-size: 32px; letter-spacing: 6px; font-weight: 700;">${code}</p>
     <p style="color: #6b7280; font-size: 11px;">If this was not you, do not share the code. Change your account password.</p>`));
}

/** Recovery started: tells the owner when it can finish and gives a one-click way to stop it. */
export async function sendKeyRecoveryAlert(to: string, readyAt: Date, cancelUrl: string): Promise<void> {
  await mustSend(to, "Amma Wallet - Wallet recovery requested", frame("Wallet recovery was requested",
    `<p style="color: #9ca3af; font-size: 14px;">Someone asked to recover the keys of your wallet. Sending from the wallet is paused until this ends.</p>
     <p style="color: #ffffff; font-size: 14px;">It can finish after <strong>${readyAt.toUTCString()}</strong>.</p>
     <p style="color: #fca5a5; font-size: 14px;">If this was not you, cancel it now.</p>
     <a href="${cancelUrl}" style="display: inline-block; background: #dc2626; color: white; padding: 14px 32px; border-radius: 12px; text-decoration: none; font-weight: 600;">Cancel recovery</a>
     <p style="color: #6b7280; font-size: 11px; margin-top: 16px; word-break: break-all;">Or copy: ${cancelUrl}</p>`));
}

export async function sendKeyRecoveryCancelled(to: string): Promise<void> {
  await mustSend(to, "Amma Wallet - Wallet recovery cancelled", frame("Wallet recovery cancelled",
    `<p style="color: #9ca3af; font-size: 14px;">The recovery request on your wallet was cancelled. Sending is available again.</p>`));
}

/** Sent before a saved recovery phrase is shown: the owner always hears about it, and the phrase is not released if this fails. */
export async function sendRecoveryPhraseViewedAlert(to: string, when: Date): Promise<void> {
  await mustSend(to, "Amma Wallet - Your recovery phrase was viewed", frame("Your recovery phrase was viewed",
    `<p style="color: #9ca3af; font-size: 14px;">Your saved recovery phrase was shown in a signed-in session on <strong style="color: #ffffff;">${when.toUTCString()}</strong>.</p>
     <p style="color: #fca5a5; font-size: 14px;">If this was not you, change your account password now, turn on two-factor sign-in, and contact support.</p>`));
}

/** The email-method second factor for viewing a saved recovery phrase. */
export async function sendRecoveryPhraseCode(to: string, code: string): Promise<void> {
  await mustSend(to, "Amma Wallet - Code to view your recovery phrase", frame("Your verification code",
    `<p style="color: #9ca3af; font-size: 14px;">Use this code to view your saved recovery phrase. It expires in 10 minutes.</p>
     <p style="color: #ffffff; font-size: 32px; letter-spacing: 6px; font-weight: 700;">${code}</p>
     <p style="color: #6b7280; font-size: 11px;">If this was not you, do not share the code. Change your account password.</p>`));
}
