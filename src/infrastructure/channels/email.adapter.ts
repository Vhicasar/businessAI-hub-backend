import nodemailer from 'nodemailer';
import { ImapFlow } from 'imapflow';
import type {
  ChannelAccountRef,
  ChannelAdapter,
  OutboundPayload,
  SendResult,
  WebhookRequestLike,
} from '../../application/inbox/channel-adapter';
import { AppError } from '../../shared/errors';

/**
 * Email channel — outbound half. Inbound arrives via the IMAP poller
 * (email.poller.ts), not webhooks.
 * Credentials: { imapHost, imapPort, imapUser, imapPass,
 *                smtpHost, smtpPort, smtpSecure?, smtpUser?, smtpPass?, fromAddress? }
 */
export class EmailAdapter implements ChannelAdapter {
  readonly channelType = 'EMAIL' as const;

  verifyWebhook(_req: WebhookRequestLike): boolean {
    return false; // poller-based channel
  }

  parseInbound(): never[] {
    return [];
  }

  async sendMessage(payload: OutboundPayload, account: ChannelAccountRef): Promise<SendResult> {
    const c = account.credentials;
    if (!c.smtpHost) {
      throw new AppError('CHANNEL_MISCONFIGURED', 500, 'Email channel has no SMTP host');
    }
    const transport = nodemailer.createTransport({
      host: c.smtpHost,
      port: Number(c.smtpPort ?? 587),
      secure: c.smtpSecure === 'true',
      auth: c.smtpUser ? { user: c.smtpUser, pass: c.smtpPass ?? '' } : undefined,
    });
    const info = await transport.sendMail({
      from: c.fromAddress || c.smtpUser || c.imapUser,
      to: payload.recipientExternalId,
      subject: payload.subject || (payload.isMarketing ? 'Update from our team' : 'Re: your message'),
      text: payload.text,
    });
    return { providerMessageId: info.messageId ?? `mail_${Date.now()}` };
  }

  async onAccountConnected(account: ChannelAccountRef): Promise<string | null> {
    const c = account.credentials;
    if (!c.imapHost || !c.imapUser || !c.smtpHost) {
      throw new AppError('CHANNEL_MISCONFIGURED', 400, 'IMAP and SMTP server details are required.');
    }
    const client = new ImapFlow({
      host: c.imapHost,
      port: Number(c.imapPort ?? 993),
      secure: true,
      auth: { user: c.imapUser, pass: c.imapPass ?? '' },
      logger: false,
    });
    try {
      await client.connect();
    } catch {
      throw new AppError('CHANNEL_MISCONFIGURED', 400, 'The mailbox credentials could not be verified with the IMAP server.');
    } finally {
      await client.logout().catch(() => undefined);
    }
    const transport = nodemailer.createTransport({
      host: c.smtpHost,
      port: Number(c.smtpPort ?? 587),
      secure: c.smtpSecure === 'true',
      auth: c.smtpUser ? { user: c.smtpUser, pass: c.smtpPass ?? '' } : undefined,
    });
    await transport.verify().catch(() => {
      throw new AppError('CHANNEL_MISCONFIGURED', 400, 'The mailbox credentials could not be verified with the SMTP server.');
    });
    return 'Email connected. Incoming mail is checked about once a minute.';
  }
}
