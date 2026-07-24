import nodemailer, { Transporter } from 'nodemailer';
import { env } from '../../shared/config/env';
import { logger } from '../../shared/logger'; 

function buildTransport(): Transporter {
  if (env.SMTP_HOST) {
    return nodemailer.createTransport({
      host: env.SMTP_HOST,
      port: env.SMTP_PORT,
      secure: env.SMTP_SECURE,
      auth: env.SMTP_USER ? { user: env.SMTP_USER, pass: env.SMTP_PASS } : undefined,
    });
  }
  // Dev fallback: render emails to the log instead of sending.
  logger.warn('SMTP_HOST not configured — emails will be logged, not sent');
  return nodemailer.createTransport({ jsonTransport: true });
}

const transport = buildTransport();
const devFallbackTransport = nodemailer.createTransport({ jsonTransport: true });

async function send(to: string, subject: string, html: string, text: string): Promise<void> {
  const message = { from: env.MAIL_FROM, to, subject, html, text };
  try {
    const info = await transport.sendMail(message);
    if (!env.SMTP_HOST) {
      logger.info({ to, subject, preview: text.slice(0, 200) }, 'Email (dev log transport)');
    } else {
      logger.debug({ to, subject, messageId: info.messageId }, 'Email sent');
    }
  } catch (err) {
    logger.error(
      { err, to, subject, smtpHost: env.SMTP_HOST, smtpPort: env.SMTP_PORT },
      'Email delivery failed',
    );
    // A stale local SMTP setting should not make authentication flows unusable.
    // Keep production strict: silently pretending a reset email was delivered
    // there would strand the user without a usable link.
    if (env.isProd) throw err;
    await devFallbackTransport.sendMail(message);
    logger.warn(
      { to, subject, preview: text.slice(0, 500) },
      'Email written to development log after SMTP failure',
    );
  }
}

const layout = (title: string, bodyHtml: string) => `
<div style="font-family:-apple-system,Segoe UI,Roboto,sans-serif;max-width:520px;margin:0 auto;padding:24px">
  <h2 style="color:#4f46e5;margin-bottom:4px">BusinessHub AI</h2>
  <h3 style="margin-top:0">${title}</h3>
  ${bodyHtml}
  <p style="color:#6b778c;font-size:12px;margin-top:32px">
    If you didn't request this, you can safely ignore this email.
  </p>
</div>`;

export const mailer = {
  async sendEmailVerification(to: string, token: string): Promise<void> {
    const url = `${env.WEB_APP_URL}/auth/verify-email?token=${token}`;
    await send(
      to,
      'Verify your email',
      layout(
        'Verify your email address',
        `<p>Welcome! Confirm your email to activate your workspace.</p>
         <p><a href="${url}" style="background:#4f46e5;color:#fff;padding:10px 18px;border-radius:8px;text-decoration:none">Verify email</a></p>
         <p style="font-size:12px;color:#6b778c">Link expires in 24 hours.</p>`
      ),
      `Verify your email: ${url} (expires in 24 hours)`
    );
  },

  async sendPasswordReset(to: string, token: string): Promise<void> {
    const url = `${env.WEB_APP_URL}/auth/reset-password/${token}`;
    await send(
      to,
      'Reset your password',
      layout(
        'Reset your password',
        `<p>We received a request to reset your password.</p>
         <p><a href="${url}" style="background:#4f46e5;color:#fff;padding:10px 18px;border-radius:8px;text-decoration:none">Choose a new password</a></p>
         <p style="font-size:12px;color:#6b778c">Link expires in 1 hour. All sessions will be signed out after reset.</p>`
      ),
      `Reset your password: ${url} (expires in 1 hour)`
    );
  },

  async sendPasswordChangedNotice(to: string): Promise<void> {
    await send(
      to,
      'Your password was changed',
      layout(
        'Password changed',
        `<p>Your BusinessHub AI password was just changed and all active sessions were signed out.
         If this wasn't you, reset your password immediately and contact support.</p>`
      ),
      'Your BusinessHub AI password was changed. If this was not you, reset it immediately.'
    );
  },

  async sendInvitation(to: string, orgName: string, token: string): Promise<void> {
    const url = `${env.WEB_APP_URL}/auth/invite/${token}`;
    await send(
      to,
      `You've been invited to ${orgName}`,
      layout(
        `Join ${orgName} on BusinessHub AI`,
        `<p>You've been invited to collaborate in <b>${orgName}</b>.</p>
         <p><a href="${url}" style="background:#4f46e5;color:#fff;padding:10px 18px;border-radius:8px;text-decoration:none">Accept invitation</a></p>
         <p style="font-size:12px;color:#6b778c">Invitation expires in 7 days.</p>`
      ),
      `Join ${orgName} on BusinessHub AI: ${url} (expires in 7 days)`
    );
  },
};
