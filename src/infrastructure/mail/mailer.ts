import nodemailer, { Transporter } from 'nodemailer';
import { env } from '../../shared/config/env';
import { logger } from '../../shared/logger';
import { prismaUnscoped } from '../../infrastructure/database/prisma';

/** Categorizes a delivery in EmailDeliveryLog for troubleshooting + retry. */
export type EmailType =
  | 'EMAIL_VERIFY'
  | 'PASSWORD_RESET'
  | 'PASSWORD_CHANGED'
  | 'INVITATION'
  | 'NOTICE';

export interface EmailContext {
  type: EmailType;
  userId?: string | null;
  organizationId?: string | null;
}

/** Persist a delivery attempt. Unscoped + best-effort — never fails a send. */
async function recordDelivery(
  ctx: EmailContext | undefined,
  to: string,
  subject: string,
  result: { delivered: boolean; attempts: number; messageId?: string; error?: string },
): Promise<void> {
  if (!ctx) return;
  try {
    await prismaUnscoped.emailDeliveryLog.create({
      data: {
        organizationId: ctx.organizationId ?? null,
        userId: ctx.userId ?? null,
        type: ctx.type,
        recipient: to,
        subject,
        status: result.delivered ? 'SENT' : 'FAILED',
        attempts: result.attempts,
        provider: env.SMTP_HOST || 'dev-log',
        messageId: result.messageId ?? null,
        error: result.error ?? null,
      },
    });
  } catch (err) {
    logger.warn({ err: (err as Error).message, to, type: ctx.type }, 'Failed to write EmailDeliveryLog');
  }
}

function buildTransport(): Transporter {
  if (env.SMTP_HOST) {
    return nodemailer.createTransport({
      host: env.SMTP_HOST,
      port: env.SMTP_PORT,
      secure: env.SMTP_SECURE,
      auth: env.SMTP_USER ? { user: env.SMTP_USER, pass: env.SMTP_PASS } : undefined,
    });
  }
  if (env.isProd) {
    throw new Error(
      'SMTP_HOST is required in production; transactional emails cannot be delivered',
    );
  }
  // Development/test fallback: render emails to the log instead of sending.
  logger.warn('SMTP_HOST not configured — emails will be logged, not sent');
  return nodemailer.createTransport({ jsonTransport: true });
}

const transport = buildTransport();
const devFallbackTransport = nodemailer.createTransport({ jsonTransport: true });

/** Outcome of a delivery attempt — callers use this to show accurate status. */
export interface MailResult {
  delivered: boolean;
  attempts: number;
  messageId?: string;
  error?: string;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Deliver an email with automatic retry + backoff. Never throws — it returns a
 * {@link MailResult} so callers (registration, resend, notifications) can log
 * and surface accurate delivery status without failing the surrounding action.
 * Every attempt is logged for troubleshooting.
 */
async function send(
  to: string,
  subject: string,
  html: string,
  text: string,
  opts: { retries?: number; context?: EmailContext } = {},
): Promise<MailResult> {
  const retries = opts.retries ?? 3;
  const message = { from: env.MAIL_FROM, to, subject, html, text };
  let lastErr: unknown;

  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const info = await transport.sendMail(message);
      if (!env.SMTP_HOST) {
        logger.info({ to, subject, preview: text.slice(0, 200) }, 'Email (dev log transport)');
      } else {
        logger.info({ to, subject, attempt, messageId: info.messageId }, 'Email delivered');
      }
      const result = { delivered: true, attempts: attempt, messageId: info.messageId };
      await recordDelivery(opts.context, to, subject, result);
      return result;
    } catch (err) {
      lastErr = err;
      logger.warn(
        { err: (err as Error).message, to, subject, attempt, retries, smtpHost: env.SMTP_HOST },
        'Email delivery attempt failed',
      );
      if (attempt < retries) await sleep(500 * 2 ** (attempt - 1)); // 0.5s, 1s, 2s…
    }
  }

  logger.error(
    { err: (lastErr as Error)?.message, to, subject, attempts: retries, smtpHost: env.SMTP_HOST },
    'Email delivery failed after all retries',
  );
  // Outside production, still write the content to the log so devs get the link.
  if (!env.isProd) {
    try {
      await devFallbackTransport.sendMail(message);
      logger.warn({ to, subject, preview: text.slice(0, 500) }, 'Email written to dev log after SMTP failure');
    } catch {
      /* ignore */
    }
  }
  const result = { delivered: false, attempts: retries, error: (lastErr as Error)?.message };
  await recordDelivery(opts.context, to, subject, result);
  return result;
}

const BRAND = '#F97316';
const button = (url: string, label: string) =>
  `<a href="${url}" style="background:${BRAND};color:#fff;padding:11px 20px;border-radius:8px;text-decoration:none;font-weight:600;display:inline-block">${label}</a>`;

const layout = async (title: string, bodyHtml: string) => {
  const lockup =
    '<div style="font-size:18px;line-height:32px;font-weight:800;letter-spacing:-.025em;color:#1f2937">Vhicasar<span style="color:#F97316">&nbsp;Hub AI</span></div>';
  return `
<div style="font-family:-apple-system,Segoe UI,Roboto,sans-serif;max-width:520px;margin:0 auto;padding:24px">
  <div style="margin-bottom:18px">
    ${lockup}
  </div>
  <h3 style="margin-top:0">${title}</h3>
  ${bodyHtml}
  <p style="color:#6b778c;font-size:12px;margin-top:32px">
    If you didn't request this, you can safely ignore this email.
  </p>
</div>`;
};

export const mailer = {
  async sendEmailVerification(to: string, token: string, userId?: string | null): Promise<MailResult> {
    const url = `${env.WEB_APP_URL}/auth/verify-email?token=${token}`;
    return send(
      to,
      'Verify your email',
      await layout(
        'Verify your email address',
        `<p>Welcome! Confirm your email to activate your workspace.</p>
         <p>${button(url, 'Verify email')}</p>
         <p style="font-size:12px;color:#6b778c">Link expires in 24 hours.</p>`
      ),
      `Verify your email: ${url} (expires in 24 hours)`,
      { context: { type: 'EMAIL_VERIFY', userId } },
    );
  },

  async sendPasswordReset(to: string, token: string, userId?: string | null): Promise<MailResult> {
    const url = `${env.WEB_APP_URL}/auth/reset-password/${token}`;
    return send(
      to,
      'Reset your password',
      await layout(
        'Reset your password',
        `<p>We received a request to reset your password.</p>
         <p>${button(url, 'Choose a new password')}</p>
         <p style="font-size:12px;color:#6b778c">Link expires in 1 hour. All sessions will be signed out after reset.</p>`
      ),
      `Reset your password: ${url} (expires in 1 hour)`,
      { context: { type: 'PASSWORD_RESET', userId } },
    );
  },

  async sendPasswordChangedNotice(to: string, userId?: string | null): Promise<MailResult> {
    return send(
      to,
      'Your password was changed',
      await layout(
        'Password changed',
        `<p>Your Vhicasar Hub AI password was just changed and all active sessions were signed out.
         If this wasn't you, reset your password immediately and contact support.</p>`
      ),
      'Your Vhicasar Hub AI password was changed. If this was not you, reset it immediately.',
      { context: { type: 'PASSWORD_CHANGED', userId } },
    );
  },

  async sendInvitation(to: string, orgName: string, token: string, organizationId?: string | null): Promise<MailResult> {
    const url = `${env.WEB_APP_URL}/auth/invite/${token}`;
    return send(
      to,
      `You've been invited to ${orgName}`,
      await layout(
        `Join ${orgName} on Vhicasar Hub AI`,
        `<p>You've been invited to collaborate in <b>${orgName}</b>.</p>
         <p>${button(url, 'Accept invitation')}</p>
         <p style="font-size:12px;color:#6b778c">Invitation expires in 7 days.</p>`
      ),
      `Join ${orgName} on Vhicasar Hub AI: ${url} (expires in 7 days)`,
      { context: { type: 'INVITATION', organizationId } },
    );
  },

  /** Generic branded email — used by order/payment notifications. */
  async sendNotice(
    to: string,
    subject: string,
    title: string,
    bodyHtml: string,
    text: string,
    context?: { organizationId?: string | null },
  ): Promise<MailResult> {
    return send(to, subject, await layout(title, bodyHtml), text, {
      context: { type: 'NOTICE', organizationId: context?.organizationId ?? null },
    });
  },
};
