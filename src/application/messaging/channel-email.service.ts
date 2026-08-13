import nodemailer from 'nodemailer';
import { prisma } from '../../infrastructure/database/prisma';
import { decrypt } from '../../shared/crypto';
import { logger } from '../../shared/logger';

/**
 * Send a rich email — HTML plus attachments — from a business's own mailbox.
 *
 * The channel adapter sends plain text only, which is right for a chat reply
 * but loses an invoice: the document becomes a sentence and the PDF is dropped.
 * This uses the same connected credentials, so the customer still sees the
 * business's address and can reply to it, but the message can carry a real
 * document.
 */

export interface ChannelEmail {
  to: string;
  subject: string;
  html: string;
  text: string;
  attachments?: { filename: string; content: Buffer; contentType: string }[];
}

export async function sendEmailViaChannel(
  channelAccountId: string,
  email: ChannelEmail,
): Promise<{ ok: boolean; error?: string }> {
  const account = await prisma.channelAccount.findFirst({
    where: { id: channelAccountId, deletedAt: null, isActive: true },
    select: { id: true, channelType: true, name: true, credentialsEnc: true },
  });
  if (!account) return { ok: false, error: 'That email channel is no longer connected' };
  if (account.channelType !== 'EMAIL') {
    return { ok: false, error: `${account.name} is not an email channel` };
  }

  let credentials: Record<string, string> = {};
  try {
    credentials = account.credentialsEnc
      ? (JSON.parse(decrypt(account.credentialsEnc)) as Record<string, string>)
      : {};
  } catch (err) {
    logger.warn({ err: (err as Error).message, channelAccountId }, 'channel credentials unreadable');
    return { ok: false, error: 'The channel’s saved credentials could not be read. Reconnect it.' };
  }

  if (!credentials.smtpHost) {
    return {
      ok: false,
      error: `${account.name} has no outgoing mail server configured, so it cannot send.`,
    };
  }

  const from = credentials.fromAddress || credentials.smtpUser || credentials.imapUser;
  if (!from) {
    return { ok: false, error: `${account.name} has no sending address configured.` };
  }

  try {
    const transport = nodemailer.createTransport({
      host: credentials.smtpHost,
      port: Number(credentials.smtpPort ?? 587),
      secure: credentials.smtpSecure === 'true',
      auth: credentials.smtpUser
        ? { user: credentials.smtpUser, pass: credentials.smtpPass ?? '' }
        : undefined,
    });

    const info = await transport.sendMail({
      from,
      to: email.to,
      subject: email.subject,
      html: email.html,
      text: email.text,
      ...(email.attachments?.length ? { attachments: email.attachments } : {}),
    });
    logger.info(
      { to: email.to, subject: email.subject, channelAccountId, messageId: info.messageId },
      'Email sent through business channel',
    );
    return { ok: true };
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Send failed';
    logger.warn({ err: message, channelAccountId }, 'business channel email failed');
    return { ok: false, error: message };
  }
}
